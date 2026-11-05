# Design Instagram

<<<SECTION 1>>>
## High-Level Design: Instagram

## 1. Requirements

**Functional:** upload photos and videos; follow/unfollow users; like, comment, share posts; personalized, ranked feed for every user; search posts, hashtags, users; notifications for likes, comments, follows, mentions.

**Out of scope:** live streaming; direct messaging; Reels (separate recommendation-heavy video pipeline); Stories (like posts but with TTL; can be added as an extension).

**Non-functional:**
- High availability: feed and media serving must never go down
- Low latency: feed under 100ms, media under 200ms
- Massive read throughput: read/write ratio ~1000:1
- Eventual consistency OK for feed, like counts, notifications
- Strong consistency for follow/unfollow and user profile data

## 2. Capacity Estimation

- **DAU:** 500 million
- **Posts/day:** 20% of DAU post daily = 100 million
- **Average post size:** ~5 MB (weighted: photos ~1 MB, videos ~10 MB)
- **Raw storage/day:** 100M × 5 MB = **500 TB/day**
- **Yearly raw storage:** ~180 PB (before replication and resolution variants)
- **Read/write ratio:** ~1000:1; one celebrity post is viewed hundreds of millions of times

The read/write asymmetry is the most important number: one post, potentially a billion reads. It drives aggressive caching, edge CDN, precomputed feeds, and read replicas everywhere. With ~90% CDN hit rate for popular media, most media reads never reach origin.

<<<SECTION 2>>>
## 3. API Gateway

All client requests (iOS, Android, web, third-party) enter here. Responsibilities:

- **Auth:** token validation before any downstream service
- **Rate limiting:** protects services from spikes and abuse
- **Request routing** to the correct microservice
- **SSL termination** at the edge

As with Spotify, the Gateway must never carry binary media. A video upload can be 100MB+, which would make it a catastrophic bottleneck. It handles auth and routing only; uploads use direct-to-S3 presigned URLs.

## 4. Upload Pipeline

The most complex write path. It mirrors the Spotify transcoding pipeline (article 15) with Instagram-specific image resolutions and video formats.

### Step 1: Auth and Presigned URL Generation

Client sends an upload request to the API Gateway, which authenticates and forwards to the **Post Service**. It returns a **presigned S3 URL**: time-limited and authenticated, letting the client upload directly to S3. The backend never touches raw media, only metadata and orchestration, keeping the Post Service lightweight, stateless, and horizontally scalable.

### Step 2: Direct Client Upload to S3

Client uploads the raw file directly to S3 with the presigned URL. On completion, S3 emits an event.

### Step 3: Transcoding

The S3 event triggers the **Transcoding Service** via Kafka.

### For images:

- Resolution variants: thumbnail (150×150) for profile grids, medium (640×640) for feed, full resolution for expanded view
- Compression and format optimization (WebP for web, JPEG for older clients)
- A blurred low-quality placeholder that loads instantly before the full image

### For videos:

- Quality variants: 360p, 480p, 720p, 1080p
- HLS segments (like Spotify) for adaptive bitrate streaming
- Thumbnail frame for feed preview
- Compression

All variants go back to S3 under a deterministic path, media/{post_id}/{variant}/, so any service can build the URL without a lookup.

### Step 4: Kafka Fanout

The Transcoding Service publishes post.transcoded to Kafka. Independent consumers:

- **Metadata Worker:** writes metadata to the Posts DB and fills the Post Metadata Cache in Redis.
- **Search Indexing Worker:** indexes the post in Elasticsearch, searchable by text and hashtag within seconds.

Services stay decoupled: if the Search worker is down, it falls behind on its Kafka offset and catches up later with no data loss or impact on others.

### Step 5: Feed Fanout

A third consumer, the **Feed Fanout Worker**, writes the new post into followers' feeds (fan-out-on-write, see Feed Generation).

### Bottlenecks in the Upload Pipeline

Transcoding is the main bottleneck (multiple image resolutions and video variants are CPU-intensive). It runs as a horizontally scalable worker pool pulling from a Kafka topic; jobs are independent, so it scales linearly. S3 upload throughput is not a bottleneck.

<<<SECTION 3>>>
## 5. Media Serving and CDN

Serving must be extremely fast and global. A **CDN** (CloudFront or Akamai) sits in front of S3; every request goes to the nearest edge. Cache hits (~90% for popular posts) are served with no origin involvement. On a miss, the CDN fetches from S3, caches at the edge, and serves.

The hit rate is high because content follows a power law: a tiny fraction of posts (celebrity, viral) gets most views, gets cached at edges almost immediately, and stays hot for days.

Clients request the variant matching the display context: thumbnail for grid, medium for feed, full for expanded view. Each is a separate S3 object and CDN cache entry, so the CDN serves the cheapest appropriate variant.

<<<SECTION 4>>>
## 6. Feed Generation

The hardest distributed systems problem here. A user follows 500 accounts posting twice a day: 1000 candidate posts per day for one user, times 500 million users. A personalized, ranked feed must load in under 100ms. Instagram uses a hybrid of two strategies.

### Strategy 1: Fan-out on Write (Push Model)

On publish, the Feed Fanout Worker writes the post into every follower's precomputed feed, a **Redis sorted set**:

- **Key:** feed:{user_id}, e.g. feed:500
- **Member:** post_id
- **Score:** composite relevance of recency (Unix timestamp) and engagement (like count, comment count, follower-author closeness)

ZREVRANGE feed:500 0 19 returns user 500's top 20 post IDs by score in one sub-millisecond Redis call. Each set is capped at ~1000 posts; older, lower-scored posts are evicted. Users rarely scroll past 20-30 posts, so 1000 is generous.

**Problem:** a celebrity with 100 million followers needs 100 million sorted-set writes. At 1 microsecond each, that is 100 seconds of fan-out for one post. Unacceptable.

### Strategy 2: Fan-out on Read (Pull Model)

Accounts above a threshold (say 1 million followers) skip fan-out on write. Their posts go to a separate **Celebrity Posts** Redis cache keyed by user ID. When a follower opens their feed, the system pulls latest posts from followed celebrities in real time and merges them with the precomputed feed.

### The Hybrid Model

- **Normal users** (below threshold): fan-out on write; posts pushed into followers' sorted sets immediately.
- **Celebrities** (above threshold): fan-out on read; posts stored in the celebrity cache and merged at read time.

At read time the Feed Service:

1. Fetches the precomputed feed: ZREVRANGE feed:{user_id} 0 49
1. Fetches latest posts from followed celebrities in the Celebrity Posts cache
1. Merges and re-ranks the two lists
1. Returns the top 20 post IDs

### Feed Hydration

Post IDs aren't renderable, so the Feed Service hydrates them from the **Post Metadata Cache** with one MGET:

MGET post:101 post:202 post:303 ... post:2020

One round trip instead of 20; 20 sequential 1ms calls would eat 20ms of the 100ms budget. On a miss, it falls back to the Posts DB and writes the record back to Redis. The response includes post metadata, CDN media URLs, author details, and like/comment counts, everything needed to render immediately.

### Bottlenecks in Feed Generation

- **Fan-out Worker during viral moments:** a moderately popular user (say 500k followers) goes viral and posts often; the queue grows faster than workers drain it. Mitigation: scale workers horizontally and prioritize online users (no point writing to the feed of someone inactive for three days).
- **Redis memory:** 1000 post IDs × 500 million users is a lot. Aggressive TTLs evict inactive users' feeds, rebuilt from the Posts DB on next login.

<<<SECTION 5>>>
## 7. Post Service and Data Model

The Post Service handles post CRUD and is the entry point for uploads.

**Posts (PostgreSQL):** post_id UUID PK; user_id UUID FK -> Users; caption TEXT; media_type ENUM('photo', 'video', 'carousel'); media_url TEXT (base S3/CDN path); posted_at TIMESTAMP; like_count INTEGER; comment_count INTEGER.

like_count and comment_count are denormalized counters on the post row, since counting the Likes table on every feed load would be far too slow. Like and comment events increment them asynchronously via Kafka consumers.

**Users (PostgreSQL):** user_id UUID PK; username VARCHAR unique; full_name VARCHAR; profile_pic_url TEXT; bio TEXT; follower_count INTEGER; following_count INTEGER; created_at TIMESTAMP.

follower_count and following_count are also denormalized, updated asynchronously on follow/unfollow events.

**Follows (PostgreSQL):** follower_id UUID FK -> Users; followee_id UUID FK -> Users; created_at TIMESTAMP; PRIMARY KEY (follower_id, followee_id).

A many-to-many join table: follow = INSERT, unfollow = DELETE; "everyone X follows" = WHERE follower_id = X. Simple, fast, indexed. For second/third-degree relationships (mutual follows, suggested users, friends of friends), a **graph database** (Neo4j or AWS Neptune) fits better, since traversals across millions of nodes are very expensive in SQL but native in graph DBs.

**Likes (PostgreSQL):** like_id UUID; post_id UUID FK -> Posts; user_id UUID FK -> Users; created_at TIMESTAMP.

**Comments (PostgreSQL):** comment_id UUID; post_id UUID FK -> Posts; user_id UUID FK -> Users; content TEXT; created_at TIMESTAMP.

These hold raw interaction data. The Likes table is the source of truth for "did X like Y"; the displayed count comes from the denormalized column.

<<<SECTION 6>>>
## 8. Search Service

Search covers posts (caption, hashtag), users (username, full name), and hashtags as first-class objects.

### Storage Engine: Elasticsearch

Handles full-text, fuzzy, and partial matching plus relevance ranking across all three types at once. "har" can return user "harry_spidey", a post captioned "harbour at sunset", and hashtag #harmony, ranked by relevance.

### Elasticsearch Documents

### Post document:

```
{
  "post_id": "123",
  "caption": "beautiful sunset in Goa",
  "hashtags": ["sunset", "goa", "travel"],
  "user_id": "456",
  "like_count": 50000,
  "comment_count": 3200,
  "posted_at": "2026-06-10T18:00:00Z",
  "author_follower_count": 2000000
}
```

### User document:

```
{
  "user_id": "456",
  "username": "harry_dev",
  "full_name": "Harry Singh",
  "follower_count": 15000,
  "verified": false
}
```

### Engagement-Weighted Ranking

Unlike Spotify's pure text relevance, Instagram combines text match with engagement: a weak match with 50,000 likes outranks a perfect match with 3 likes. For users, follower count and verification are the main signals; "harry" surfaces verified, high-follower accounts first.

Hashtags are indexed terms linking thousands of posts. Clicking #sunset in a caption searches the hashtags field and returns tagged posts ranked by engagement.

### Keeping Elasticsearch in Sync

The Search Indexing Worker consumes post.transcoded for new posts and post.updated and user.updated for updates. Like count changes are batched and synced periodically, since search like counts needn't be real-time. Hot queries (top celebrities, trending hashtags) are cached in Redis with a short TTL so Elasticsearch isn't hammered by identical queries.

### Bottlenecks in Search

Elasticsearch degrades under very high query volume with fuzzy matching across multiple fields. Mitigations: Redis caching of hot queries, horizontal scaling of the cluster, and index tuning (index only fields needed for search and ranking, not the full post).

<<<SECTION 7>>>
## 9. Notification Service

Every interaction can trigger a notification, an extremely high-volume event stream.

**Triggers** (User A acts, User B is notified): A likes B's post; A comments on B's post; A follows B; A mentions B in a comment; A shares B's post.

### Architecture: Kafka Fanout

Like, Comment, and Follow services publish to their own Kafka topics; the Notification Service subscribes to all independently. The Like Service doesn't know the Notification Service exists.

### Notification Coalescing

One push per like would be catastrophic for a post with 50,000 likes. **Coalescing** batches similar events into one notification: "Harry and 499 others liked your post" instead of 500; "5 new comments on your post" instead of 5. Events on the same post within a 30-second window are batched before delivery.

### Device Token Store

Maps user_id -> device_token, platform (ios/android); updated when a user logs in on a new device.

### Last Mile Delivery: APNs and FCM

Apple and Google control mobile push delivery, so the flow is:

1. Notification Service receives the Kafka event
1. Fetches the user's device token
1. Applies coalescing if applicable
1. Calls **APNs** (Apple Push Notification Service) for iOS or **FCM** (Firebase Cloud Messaging) for Android with the payload
1. APNs/FCM delivers to the device (lock screen)

For in-app notifications (the bell), the service also writes to a **Notifications Table** in PostgreSQL, which the open app polls or receives via WebSocket.

**Bottlenecks:** viral fan-out. A celebrity post with 1 million likes in an hour yields 1 million Kafka events. Coalescing cuts push count dramatically, but processing throughput must stay high; horizontal scaling of workers and aggressive coalescing windows handle it.

<<<SECTION 8>>>
## 10. Full Data Flow Summary

**Upload:**
1. Client -> API Gateway (auth) -> Post Service -> presigned S3 URL
2. Client -> S3 (direct upload)
3. S3 -> Kafka (post.uploaded) -> Transcoding Service -> S3 (all variants)
4. Transcoding Service -> Kafka (post.transcoded) -> Metadata Worker -> Posts DB + Redis Cache; Search Worker -> Elasticsearch; Feed Fanout Worker -> Redis feed sorted sets (normal users) / Celebrity Post Cache (high-follower users)

**Feed read:** Client -> API Gateway -> Feed Service -> Redis ZREVRANGE feed:{user_id} (precomputed post IDs) -> Redis GET celebrity posts (merged at read time) -> Redis MGET post:1 post:2 ... post:20 (hydrate metadata) -> CDN (media URLs served directly)

**Media serving:** Client -> CDN edge: hit (~90%) -> served directly; miss (~10%) -> S3 -> CDN caches -> served

**Search:** Client -> API Gateway -> Search Service -> Redis (hot query cache) -> Elasticsearch (cache miss) -> Post Metadata Cache (hydrate results)

**Notification:** Like/Comment/Follow -> Kafka -> Notification Service -> coalesce events -> fetch device token -> APNs (iOS) / FCM (Android) -> device; also -> Notifications Table (PostgreSQL) -> in-app bell

**Interaction event ingestion:** Client interactions -> Kafka -> Analytics Workers -> Analytics DB -> ML Pipeline (periodic) -> Redis (personalization signals for feed ranking)

<<<SECTION 9>>>
## 11. Resilience and Fault Tolerance

- **CDN + multi-resolution variants:** media is cached at edges globally; if S3 origin is unreachable, the CDN keeps serving cached media. Thanks to the power law, the most-viewed posts are almost always cache-hot.
- **Precomputed feeds in Redis:** happy-path feed reads don't depend on the Posts DB. If it is slow or down, cached feeds still load; new posts stop appearing, existing content is unaffected.
- **Kafka decoupling:** Feed Fanout Worker, Search Indexing Worker, and Notification Service consume with durable offsets, failing and recovering independently with no data loss.
- **Cassandra replication** for high-volume writes (analytics, feed events): replication factor 3 across availability zones, so no single node failure loses data.
- **PostgreSQL read replicas** for Users, Posts, Follows, Likes: no single point of failure for reads. Reads go to replicas, writes to the primary.
- **Redis eviction** of feeds for users inactive several days prevents memory overflow; feeds are rebuilt from the Posts DB on next login.
- **Circuit breakers** prevent cascading failures: if Redis is slow, the Feed Service falls back to the Posts DB rather than hanging, and vice versa.

<<<SECTION 10>>>
## 12. Technology Choices Summary

- **API Gateway:** Kong / AWS API Gateway (auth, rate limiting, routing)
- **Blob Storage:** AWS S3 (immutable media, durable, CDN-native)
- **CDN:** CloudFront / Akamai (edge caching, absorbs ~90% of media reads)
- **Streaming Protocol:** HLS for video (chunked, adaptive bitrate, CDN-friendly)
- **Decoupling:** Apache Kafka (high-throughput fanout, durable, replayable)
- **Search:** Elasticsearch (full-text, fuzzy, engagement-weighted ranking)
- **Posts / Users DB:** PostgreSQL sharded + replicas (relational, strong consistency)
- **Follows Graph:** PostgreSQL + Neo4j / AWS Neptune (follow/unfollow in SQL, graph traversal for suggestions)
- **Feed Store:** Redis Sorted Sets (sub-millisecond ranked reads, precomputed per user)
- **Metadata Cache:** Redis MGET (batch hydration in one round trip)
- **Analytics Store:** Cassandra / ClickHouse (high write volume, time-series, ML pipeline input)
- **Push Notifications:** APNs + FCM (iOS and Android last mile)
- **In-app Notifications:** PostgreSQL + WebSocket (persistent history + real-time delivery)
