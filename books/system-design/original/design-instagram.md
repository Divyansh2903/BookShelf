# Design Instagram

<<<SECTION 1>>>
## High-Level Design: Instagram

## 1. Requirements

Functional Requirements

- Upload photos and videos
- Follow and unfollow users
- Like, comment, and share posts
- Feed generation: personalized, ranked feed for every user
- Search for posts, hashtags, and users
- Notifications: likes, comments, follows, mentions

Out of Scope

- Live streaming
- Direct messaging
- Reels (separate recommendation-heavy video pipeline)
- Stories (architecturally similar to posts but with TTL, it can be added as an extension)

Non-Functional Requirements

- High availability: feed and media serving must never go down
- Low latency: feed must load in under 100ms, media in under 200ms
- Massive read throughput: read/write ratio is approximately 1000:1
- Eventual consistency is acceptable for feed, like counts, and notifications
- Strong consistency required for follow/unfollow and user profile data

## 2. Capacity Estimation

- **DAU:** 500 million
- **Posts per day:** 20% of DAU post daily i.e. 100 million posts/day
- **Average post size:** ~5 MB (weighted average of photos at ~1 MB and videos at ~10 MB)
- **Raw storage per day:** 100M × 5 MB = **500 TB/day**
- **Yearly raw storage:** ~180 PB (before replication and multi-resolution variants)
- **Read/write ratio:** ~1000:1 - a single celebrity post is viewed hundreds of millions of times

The read/write asymmetry is the single most important number in this design. One post, potentially a billion reads. This drives every architectural decision like aggressive caching, CDN at the edge, precomputed feeds, and read replicas everywhere. The system is overwhelmingly optimized for reads.

With a CDN cache hit rate of ~90% for popular media, the vast majority of media reads never reach origin infrastructure at all.

<<<SECTION 2>>>
## 3. API Gateway

Every client request, from iOS, Android, web, or third-party integrations, enters through the API Gateway. Its responsibilities are:

- **Authentication and authorization:** token validation before any request reaches a downstream service
- **Rate limiting:** protecting downstream services from traffic spikes and abuse
- **Request routing:** directing requests to the correct microservice
- **SSL termination:** handling HTTPS at the edge

The critical constraint is the same as Spotify: the API Gateway must never be in the path of binary media payloads. A video upload can be 100MB or more. Routing that through the API Gateway would make it a catastrophic bottleneck. The Gateway handles auth and routing only, media upload is handled via a direct-to-S3 presigned URL pattern described below.

## 4. Upload Pipeline

The upload pipeline is the most complex write path in the system. It mirrors the Spotify transcoding (article 15) pipeline closely but has Instagram-specific requirements around image resolutions and video formats.

### Step 1: Auth and Presigned URL Generation

The client sends an upload request to the API Gateway, which authenticates the user and forwards to the **Post Service**. The Post Service generates a **presigned S3 URL,** which is a time-limited, authenticated URL that allows the client to upload directly to S3 without routing the binary payload through any backend service. The presigned URL is returned to the client.

This pattern is fundamental. Our backend never touches the raw media file. It only ever handles metadata and orchestration. This keeps the Post Service lightweight, stateless, and horizontally scalable.

### Step 2: Direct Client Upload to S3

The client uploads the raw media file directly to S3 using the presigned URL. This is a direct client-to-S3 connection. Once the upload completes, S3 emits an event.

### Step 3: Transcoding

The S3 upload event triggers the **Transcoding Service** via Kafka. The Transcoding Service processes the media differently depending on type:

### For images:

- Generate multiple resolution variants, thumbnail (150×150) for profile grids, medium (640×640) for feed display, full resolution for expanded view
- Apply compression and format optimization (WebP for web clients, JPEG for older clients)
- Generate a blurred placeholder (the low-quality preview that loads instantly before the full image renders)

### For videos:

- Generate multiple quality variants: 360p, 480p, 720p, 1080p
- Chunk the video into HLS segments (similar to Spotify) for adaptive bitrate streaming
- Generate a thumbnail frame for feed preview
- Apply compression

All variants are written back to S3. The folder structure is deterministic- media/{post_id}/{variant}/ , so any service can construct the correct URL without a lookup.

### Step 4: Kafka Fanout

Once transcoding completes, the Transcoding Service publishes a post.transcoded event to Kafka. Two consumers pick this up independently:

**Metadata Worker:** writes post metadata to the Posts DB and populates the Post Metadata Cache in Redis.

**Search Indexing Worker:** indexes the new post into Elasticsearch, making it discoverable via search and hashtag lookup within seconds.

This event-driven fanout keeps all downstream services decoupled. If the Search Indexing Worker is temporarily down, it falls behind on its Kafka offset and catches up on recovery, no data is lost, no other service is affected.

### Step 5: Feed Fanout

A third Kafka consumer (the **Feed Fanout Worker),** picks up the post.transcoded event and begins writing the new post into the feeds of the author's followers. This is the fan-out-on-write process described in detail in the Feed Generation section below.

### Bottlenecks in the Upload Pipeline

The Transcoding Service is the primary bottleneck, generating multiple image resolutions and video quality variants is CPU-intensive. This is mitigated by running the Transcoding Service as a horizontally scalable worker pool pulling from a Kafka topic. Each transcoding job is independent, so this scales linearly. S3 upload throughput is not a bottleneck, S3 is designed for exactly this scale.

<<<SECTION 3>>>
## 5. Media Serving and CDN

Once the media is in S3 and transcoded, serving it is straightforward but must be extremely fast and globally distributed.

A **CDN** (CloudFront or Akamai) sits in front of S3. Every media request from a client goes to the nearest CDN edge node first. On a cache hit, which accounts for roughly 90% of requests for popular posts, the CDN serves the media directly with no origin involvement. On a cache miss, the CDN fetches from S3, caches it at the edge, and serves it.

The CDN cache hit rate is so high because Instagram's content follows a power law distribution, a tiny fraction of posts (celebrity posts, viral content) account for the vast majority of views. These posts get cached at edge nodes almost immediately after upload and stay hot for days.

For media requests, the client always requests the appropriate resolution variant based on the current display context, thumbnail URL for grid view, medium URL for feed, full URL for expanded view. These are different S3 objects with different CDN cache entries, which means the CDN can serve the cheapest appropriate variant for every context.

<<<SECTION 4>>>
## 6. Feed Generation

Feed generation is the hardest distributed systems problem in Instagram's architecture. The challenge is this: a user follows 500 accounts. Each posts twice a day. That is 1000 potentially relevant posts per day for that user alone. Multiply by 500 million users. The system must serve a personalized, ranked feed to every user in under 100ms the moment they open the app.

There are two fundamental strategies, and Instagram uses a hybrid of both.

### Strategy 1: Fan-out on Write (Push Model)

When a user publishes a post, the Feed Fanout Worker immediately writes that post into the precomputed feed of every one of their followers. Each follower's feed is a **Redis sorted set** with the following structure:

- **Key:** feed:{user_id}: e.g. feed:500
- **Member:** post_id
- **Score:** a composite relevance score combining recency (Unix timestamp) and engagement signals (like count, comment count, relationship closeness between follower and author)

ZREVRANGE feed:500 0 19 returns the top 20 post IDs for user 500, sorted by score descending, in a single Redis call. This is extremely fast, sub-millisecond.

The feed sorted set is capped at ~1000 posts per user. Older, lower-scored posts are evicted automatically. Users rarely scroll past 20-30 posts, so 1000 is a generous cap.

**The problem with pure fan-out on write:** A celebrity with 100 million followers posts a photo. The Feed Fanout Worker must write to 100 million Redis sorted sets. At even 1 microsecond per write, that is 100 seconds of fan-out for a single post. This is completely unacceptable.

### Strategy 2: Fan-out on Read (Pull Model)

For celebrities and high-follower accounts (above a threshold, say 1 million followers), fan-out on write is abandoned. Instead, their posts are stored in a separate **Celebrity Posts** Redis cache, keyed by user ID. When a follower opens their feed, the system pulls the latest posts from all celebrity accounts they follow in real time and merges them with their precomputed feed.

### The Hybrid Model

Instagram uses a hybrid:

- **Normal users** (below follower threshold): fan-out on write. Post is pushed into followers' feed sorted sets imediately.
- **Celebrity users** (above follower threshold): fan-out on read. Post is stored in a celebrity post cache. Merged into follower feeds at read time.

At feed read time, the Feed Service:

1. Fetches the precomputed feed sorted set from Redis. ZREVRANGE feed:{user_id} 0 49
1. Fetches latest posts from any celebrity accounts the user follows from the Celebrity Posts cache
1. Merges and re-ranks the two lists
1. Returns the top 20 post IDs to the client

### Feed Hydration

The feed read returns post IDs, not renderable content. The client needs actual post data to display. The Feed Service hydrates the post IDs by fetching metadata from the **Post Metadata Cache** in Redis using a single MGET call:

MGET post:101 post:202 post:303 ... post:2020

MGET fetches all 20 records in a single round trip rather than 20 sequential calls. This is critical as 20 sequential cache calls at 1ms each would already consume 20ms of your 100ms budget before the client has received anything.

On a cache miss for any post, the Feed Service falls back to the Posts DB, fetches the missing record, and writes it back to Redis.

The final response to the client contains post metadata, media URLs (pointing to CDN), author details, and like/comment counts, everything needed to render the feed immediately.

### Bottlenecks in Feed Generation

The primary bottleneck is the Fan-out Worker for normal users during viral moments, when a moderately popular user (say, 500k followers) suddenly goes viral and posts frequently. The fan-out queue can grow faster than workers can process it. This is mitigated by scaling the Fan-out Worker pool horizontally and by prioritizing online users, there is no point writing to the feed of a user who has not opened Instagram in three days.

The secondary bottleneck is Redis memory. Storing 1000 post IDs per user across 500 million users requires significant memory. This is managed by aggressive TTL policies, feeds for inactive users are evicted from Redis and rebuilt on next login from the Posts DB.

<<<SECTION 5>>>
## 7. Post Service and Data Model

The Post Service handles CRUD operations for posts and is the entry point for the upload flow.

Posts Table (PostgreSQL)

Posts  
post_id        UUID, primary key  
user_id        UUID, foreign key -> Users  
caption        TEXT  
media_type     ENUM('photo', 'video', 'carousel')  
media_url      TEXT (base S3/CDN path)  
posted_at      TIMESTAMP  
like_count     INTEGER  
comment_count  INTEGER

like_count and comment_count are denormalized counters stored directly on the post row. Counting likes by querying the Likes table on every feed load would be catastrophically slow. Instead, like and comment events increment these counters asynchronously via Kafka consumers.

Users Table (PostgreSQL)

Users  
user_id           UUID, primary key  
username          VARCHAR, unique  
full_name         VARCHAR  
profile_pic_url   TEXT  
bio               TEXT  
follower_count    INTEGER  
following_count   INTEGER  
created_at        TIMESTAMP

follower_count and following_count are similarly denormalized counters, updated asynchronously when follow/unfollow events occur.

Follows Table (PostgreSQL)

Follows  
follower_id    UUID, foreign key -> Users  
followee_id    UUID, foreign key -> Users  
created_at     TIMESTAMP  
PRIMARY KEY (follower_id, followee_id)

The follow relationship is a many-to-many join table. A follow operation is an INSERT, an unfollow is a DELETE. "Give me everyone user X follows" is WHERE follower_id = X. Simple, fast, indexed.

For second and third degree relationships like mutual follows, suggested users, friends of friends, a **graph database** (Neo4j or AWS Neptune) is more appropriate than a relational join table, since graph traversals across millions of nodes are extremely expensive in SQL but native in graph DBs.

Likes and Comments Tables (PostgreSQL)

Likes  
like_id      UUID  
post_id      UUID, foreign key -> Posts  
user_id      UUID, foreign key -> Users  
created_at   TIMESTAMP  
  
Comments  
comment_id    UUID  
post_id       UUID, foreign key -> Posts  
user_id       UUID, foreign key -> Users  
content       TEXT  
created_at    TIMESTAMP

These tables store the raw interaction data. Like counts and comment counts on the Post row are maintained as asynchronous denormalized counters, the source of truth for "did user X like post Y" is the Likes table, but the displayed count comes from the denormalized column.

<<<SECTION 6>>>
## 8. Search Service

Search on Instagram covers three entities- posts (by caption and hashtag), users (by username and full name), and hashtags as first-class objects.

### Storage Engine: Elasticsearch

Elasticsearch handles full-text search, fuzzy matching, partial matching, and relevance ranking across all three entity types simultaneously. A search for "har" can return users with username "harry_spidey", posts captioned "harbour at sunset", and the hashtag "[#harmony](https://x.com/search?q=%23harmony&src=hashtag_click)", all ranked by relevance.

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

Unlike Spotify where ranking is purely text relevance, Instagram search combines text match score with engagement signals. A post that weakly matches the query but has 50,000 likes outranks a perfect text match with 3 likes. For user search, follower count and verification status are the primary ranking signals, searching "harry" surfaces verified, high-follower accounts first.

Hashtags are first-class search entities. [#sunset](https://x.com/search?q=%23sunset&src=hashtag_click) is an indexed term linking thousands of posts. Clicking a hashtag in a caption triggers a search against the hashtags field in Elasticsearch and returns all posts tagged with it, ranked by engagement.

### Keeping Elasticsearch in Sync

The Search Indexing Worker consumes from the post.transcoded Kafka topic for new posts and from separate post.updated and user.updated topics for updates. Like count changes are batched and synced to Elasticsearch periodically rather than on every like, exact like counts in search results do not need to be real-time.

Hot search queries (searching for top celebrities, trending hashtags) are cached in Redis with a short TTL to prevent Elasticsearch from being hammered by identical queries.

### Bottlenecks in Search

Elasticsearch performance degrades under very high query volume with fuzzy matching enabled across multiple fields simultaneously. Mitigation is a combination of Redis caching for hot queries, horizontal scaling of the Elasticsearch cluster, and index tuning, keeping only the fields needed for search and ranking in the index, not the full post document.

<<<SECTION 7>>>
## 9. Notification Service

Every interaction in the system (a like, a comment, a follow, a mention, a share), can trigger a notification. At Instagram's scale, this is an extremely high-volume event stream.

Notification Triggers

- User A likes User B's post -> notify User B
- User A comments on User B's post -> notify User B
- User A follows User B -> notify User B
- User A mentions User B in a comment -> notify User B
- User A shares User B's post -> notify User B

### Architecture: Kafka Fanout

Every interaction service (Like Service, Comment Service, Follow Service) publishes events to their respective Kafka topics. The Notification Service subscribes to all of them independently. This is the same event-driven fanout pattern used throughout the system. The Like Service does not know or care that a Notification Service exists.

### Notification Coalescing

Delivering one push notification per like would be catastrophic for a post with 50,000 likes. Instead, the Notification Service applies **coalescing** — batching multiple similar events into a single notification:

- "Harry and 499 others liked your post" instead of 500 individual notifications
- "5 new comments on your post" instead of 5 separate pushes

Coalescing is applied with a short time window. Events on the same post within a 30-second window are batched together before delivery.

### Device Token Store

The Notification Service maintains a simple datastore mapping user_id -> device_token, platform (ios/android). This is updated whenever a user logs in from a new device.

### Last Mile Delivery: APNs and FCM

The Notification Service cannot push directly to a mobile device. Apple and Google control that delivery channel. The flow is:

1. Notification Service receives the Kafka event
1. Fetches the user's device token from the token store
1. Applies coalescing if applicable
1. Calls **APNs** (Apple Push Notification Service) for iOS devices or **FCM** (Firebase Cloud Messaging) for Android devices with the notification payload
1. APNs/FCM handles actual delivery to the device

Interaction event -> Kafka -> Notification Service  
-> fetch device token  
-> coalesce if applicable  
-> APNs (iOS) / FCM (Android) -> user's lock screen

For in-app notifications (the notification bell), the Notification Service also writes to a **Notifications Table** in PostgreSQL, which the client polls or receives via a WebSocket connection when the app is open.

Bottlenecks in Notifications

The bottleneck is fan-out for viral events , a celebrity post that generates 1 million likes in an hour produces 1 million Kafka events that the Notification Service must process. Coalescing reduces the actual push notification count dramatically, but the event processing throughput must still be high. Horizontal scaling of Notification Service workers and aggressive coalescing windows handle this in practice.

<<<SECTION 8>>>
## 10. Full Data Flow Summary

**Upload Flow:**  
Client -> API Gateway (auth) -> Post Service -> presigned S3 URL  
Client -> S3 (direct upload)  
S3 -> Kafka (post.uploaded) -> Transcoding Service -> S3 (all variants)  
Transcoding Service -> Kafka (post.transcoded)  
  -> Metadata Worker     -> Posts DB + Redis Cache  
  -> Search Worker       -> Elasticsearch  
  -> Feed Fanout Worker  -> Redis feed sorted sets (normal users)  
                        -> Celebrity Post Cache (high-follower users)  
  
Feed Read Flow:  
Client -> API Gateway -> Feed Service  
  -> Redis ZREVRANGE feed:{user_id}       (precomputed feed post IDs)  
  -> Redis GET celebrity posts            (merged at read time)  
  -> Redis MGET post:1 post:2 ... post:20 (hydrate metadata)  
  -> CDN (media URLs served directly)  
  
Media Serving Flow:  
Client -> CDN edge (cache hit ~90%)  -> media served directly  
Client -> CDN edge (cache miss ~10%) -> S3 -> CDN caches -> media served  
  
Search Flow:  
Client -> API Gateway -> Search Service  
  -> Redis (hot query cache)  
  -> Elasticsearch (cache miss)  
  -> Post Metadata Cache (hydrate results)  
  
Notification Flow:  
Like/Comment/Follow -> Kafka -> Notification Service  
  -> coalesce events  
  -> fetch device token  
  -> APNs (iOS) / FCM (Android) -> device  
  -> Notifications Table (PostgreSQL) -> in-app bell  
  
Interaction Event Ingestion:  
Client interactions -> Kafka -> Analytics Workers -> Analytics DB  
-> ML Pipeline (periodic) -> Redis (personalization signals for feed ranking)

<<<SECTION 9>>>
## 11. Resilience and Fault Tolerance

**CDN + multi-resolution variants** provide the primary resilience for media serving. Media is cached at edge nodes globally. Even if S3 origin becomes temporarily unreachable, the CDN continues serving cached media without interruption. The power law distribution of Instagram content means the most-viewed posts are almost always cache-hot.

**Precomputed feeds in Redis** mean that feed reads do not depend on the Posts DB being healthy in the happy path. A user opening Instagram reads from Redis — if the Posts DB is slow or unavailable, already-cached feeds continue loading. New posts stop appearing, but existing feed content is unaffected.

**Kafka decoupling** throughout the pipeline means every service can fail and recover independently. The Feed Fanout Worker, Search Indexing Worker, and Notification Service all consume from Kafka with durable offsets. They catch up on recovery without any data loss.

**Cassandra replication** for high-volume write paths (analytics, feed events) ensures no single node failure causes data loss. Replication factor of 3 across availability zones is standard.

**PostgreSQL read replicas** for Users, Posts, Follows, and Likes tables ensure the relational layer has no single point of failure for reads. All read traffic goes to replicas; writes go to the primary.

**Redis eviction policies** for inactive user feeds prevent memory overflow. Feeds for users who have not been active in several days are evicted and rebuilt from the Posts DB on next login.

**Circuit breakers** between services prevent cascading failures. If Redis becomes slow, the Feed Service falls back to the Posts DB rather than hanging indefinitely, and vice versa.

<<<SECTION 10>>>
## 12. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, routing)

**Blob Storage** -> AWS S3 (Immutable media files, durable, CDN-native)

**CDN** -> CloudFront / Akamai (Edge caching, absorbs ~90% of media read load)

**Streaming Protocol** -> HLS for video (Chunked, adaptive bitrate, CDN-friendly)

**Decoupling** -> Apache Kafka (High-throughput event fanout, durable, replayable)

**Search Engine** -> Elasticsearch (Full-text, fuzzy matching, engagement-weighted ranking)

**Posts / Users DB** -> PostgreSQL sharded + replicas (Relational structure, strong consistency)

**Follows Graph** -> PostgreSQL + Neo4j / AWS Neptune (Simple follow/unfollow in SQL, graph traversal for suggestions)

**Feed Store** -> Redis Sorted Sets (Sub-millisecond ranked feed reads, precomputed per user)

**Metadata Cache** -> Redis MGET (Batch hydration of post metadata in single round trip)

**Analytics Store** -> Cassandra / ClickHouse (High write volume, time-series data, ML pipeline input)

**Push Notifications** -> APNs + FCM (iOS and Android last-mile delivery)

**In-app Notifications** -> PostgreSQL + WebSocket (Persistent notification history + real-time delivery)

That's all, folks..Cheers!
