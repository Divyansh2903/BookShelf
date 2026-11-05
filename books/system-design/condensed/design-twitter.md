# Design Twitter

<<<SECTION 1>>>
## High-Level Design: Twitter

## 1. Requirements

**Functional**
- User profiles (name, username, profile photo, banner, bio, date of birth, followers, following)
- Tweets: text up to 280 characters, images, videos
- Like, reply, retweet, follow, unfollow
- Home feed: algorithmic and chronological modes
- Trending page (global hashtags and topics)
- Search tweets, users, hashtags
- Notifications: likes, retweets, replies, follows, mentions

**Out of scope:** Direct Messages (same WebSocket architecture as Tinder), Twitter Spaces (live audio, separate real-time system), Twitter Blue / verified features, ad targeting, analytics pipeline.

**Non-functional**
- High availability for feed, tweet creation, media serving
- Feed reads under 100ms
- Handle coordinated write spikes during global events (World Cup goals, breaking news)
- Hot key resilience for viral tweets read by millions at once
- Eventual consistency OK for like/retweet counts and feed ranking
- Strong consistency for follow/unfollow and tweet existence

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 200 million
- **Original tweets/day:** 150 million (~75% of active users post once, others more)
- **Mix:** 60% text only, 30% images, 10% videos
- **Text:** 60% x 150M x 300 bytes = ~27 GB/day (negligible)
- **Images:** 30% x 150M x 1 MB = ~45 TB/day
- **Video:** 10% x 150M x 10 MB = ~150 TB/day
- **Total:** ~200 TB/day, dominated by video
- **Read/write ratio:** ~3:1

The 3:1 ratio is the key number. Unlike Instagram (or Reddit), where celebrities produce and millions passively consume, Twitter users constantly retweet, reply, and like. So the write path must be as robust and scalable as the read path.

<<<SECTION 3>>>
## 3. API Gateway

Handles authentication, rate limiting, and routing for all requests. It is never in the path of binary media: after auth, photo/video uploads go directly client-to-S3 via presigned URLs.

Extra concern for Twitter: **write spike absorption**. During a global event, millions hit tweet creation at once; Gateway rate limiting is the first defense, shedding excess traffic before downstream services.

## 4. User Service

Manages profile data: name, username, profile photo, banner, bio, date of birth, follower and following counts.

### Profile Photo and Banner Upload

1. Client authenticates via Gateway and requests a presigned S3 URL from the User Service
2. Client uploads directly to S3
3. Photo Processing Worker generates thumbnail and full-resolution variants
4. CDN in front of S3 serves profile media globally with high hit rates (profile photos rarely change)

### Users Table (PostgreSQL)

user_id (UUID, PK), username (VARCHAR, unique), display_name (VARCHAR), bio (TEXT), profile_pic_url (TEXT), banner_url (TEXT), date_of_birth (DATE), follower_count, following_count, tweet_count (INTEGER), verified (BOOLEAN), created_at (TIMESTAMP)

follower_count, following_count, and tweet_count are denormalized counters updated asynchronously via Kafka consumers; counting from the Follows table on every profile load would be far too slow at this scale.

### Follows Table (PostgreSQL)

follower_id (UUID, FK -> Users), followee_id (UUID, FK -> Users), created_at (TIMESTAMP); PRIMARY KEY (follower_id, followee_id)

Follow = INSERT, unfollow = DELETE. "Everyone X follows" is WHERE follower_id = X. Indexed on both columns for lookups in both directions. Second-degree relationships (suggested follows, mutual friends) suit a graph DB like Neo4j or AWS Neptune: traversals across millions of nodes are native there but expensive as relational joins.

### Bottlenecks in the User Service

Profiles are read far more than written. Redis caches hot profiles (verified accounts, celebrities fetched millions of times a day); PostgreSQL read replicas handle the rest. The Follows table reaches billions of rows and is sharded by follower_id.

<<<SECTION 4>>>
## 5. Tweet Service and Upload Pipeline

### Text tweets

1. Client sends POST /tweets via API Gateway to the Tweet Service
2. Tweet Service writes to the Tweets DB
3. Publishes tweet.created to Kafka
4. Kafka consumers fan out to feed, search, and notification systems

### Media tweets

1. Client requests a presigned S3 URL from the Tweet Service
2. Client uploads media directly to S3
3. S3 triggers a media.uploaded event to Kafka
4. Transcoding Service processes it:
   - Images: thumbnail, medium, full-resolution variants; WebP compression
   - Videos: 360p, 480p, 720p, 1080p variants; HLS segments for adaptive streaming; preview thumbnail
5. Variants stored in S3 under media/{tweet_id}/{variant}/
6. Transcoding Service publishes tweet.transcoded to Kafka
7. Three independent consumers:
   - **Metadata Worker:** writes to Tweets DB, populates Tweet Metadata Cache in Redis
   - **Search Indexing Worker:** indexes into Elasticsearch
   - **Feed Fanout Worker:** writes the tweet into followers' feed sorted sets

### Tweets Table (PostgreSQL)

tweet_id (UUID, PK), user_id (UUID, FK -> Users), content (VARCHAR(280)), media_url (TEXT, null for text tweets), media_type (ENUM('none', 'image', 'video')), reply_to_id (UUID, FK -> Tweets, null for originals), like_count, retweet_count, reply_count, view_count (INTEGER), posted_at (TIMESTAMP)

The four counts are denormalized and updated asynchronously. Individual interactions' source of truth is in separate tables (Likes, Retweets, Replies); counts live on the tweet row for fast reads.

### Retweets Table (PostgreSQL)

retweet_id (UUID, PK), original_tweet_id (UUID, FK -> Tweets), retweeter_id (UUID, FK -> Users), retweeted_at (TIMESTAMP)

A retweet references an existing tweet; no new content is stored. retweet_count on the original is incremented asynchronously by a Kafka consumer. When A retweets, it fans out to A's followers, not the original author's; the author only gets a notification.

### Likes Table (PostgreSQL)

like_id (UUID, PK), tweet_id (UUID, FK -> Tweets), user_id (UUID, FK -> Users), liked_at (TIMESTAMP); UNIQUE (tweet_id, user_id)

The UNIQUE constraint enforces like idempotency in the DB. The like count on the tweet row is the fast read path; the Likes table is the source of truth.

### Write Spike Handling

Synchronous PostgreSQL writes for millions of simultaneous tweets during a global event would collapse the DB. A Redis write buffer mitigates this:
1. Tweet written to Redis immediately on creation
2. tweet.created published to Kafka
3. Kafka consumer writes to PostgreSQL asynchronously, off the hot path
4. Redis absorbs the spike; PostgreSQL writes at a sustainable rate

Like and retweet counts work the same way: incremented in Redis, flushed to PostgreSQL via Kafka.

### Bottlenecks in the Tweet Service

Media tweets: the Transcoding Service, handled by horizontally scaling its worker pool. Text tweets: the write spike, mitigated by the Redis buffer and Kafka decoupling.

<<<SECTION 5>>>
## 6. Feed Service

Two modes that differ at the infrastructure level: algorithmic and chronological.

### Algorithmic Feed

Ranks tweets by relevance, engagement, and relationship closeness. Too expensive at read time, so it is precomputed via fan-out on write:
- **Normal users (below follower threshold):** fan-out on write. The Feed Fanout Worker immediately writes A's tweet into all of A's followers' feed sorted sets.
- **Celebrities (above threshold, e.g. 1 million followers):** fan-out on read. Tweets go into a Celebrity Tweets Cache in Redis; at read time the Feed Service fetches the latest and merges them with the precomputed feed.

**Redis Sorted Set:** Key `feed:{user_id}:algorithmic`, Member `tweet_id`, Score = relevance (recency, engagement signals, relationship closeness). `ZREVRANGE feed:user_123:algorithmic 0 19` returns the top 20 tweet IDs instantly.

### Chronological Feed

Pure reverse time order from followed accounts. No ranking, so read-time computation is viable and avoids the fan-out write problem for high-follower accounts.
1. Fetch the user's followed accounts from Redis
2. Query: `SELECT tweet_id FROM Tweets WHERE user_id IN (followed_accounts) ORDER BY posted_at DESC LIMIT 20`
3. A composite index on (user_id, posted_at) keeps this fast across thousands of followed accounts
4. Cache the result per user with a short TTL: `feed:{user_id}:chronological`

Repeat opens hit Redis, not PostgreSQL.

### Feed Hydration

Both modes return tweet IDs; content is hydrated with `MGET tweet:101 tweet:202 tweet:303 ... tweet:2020`, fetching all 20 records in one round trip. On a miss, fall back to PostgreSQL and write back to Redis.

### Hot Key Problem

A viral tweet from a celebrity with 50 million followers has one cache key read millions of times per minute, all hitting the same Redis node. Solution: **multi-layer caching (L1/L2/L3)**:
- **L1: local in-memory cache** on each app server (LRU, e.g. Caffeine in Java). Zero network hops, sub-microsecond reads.
- **L2: Redis** for tweets hot but not viral enough for L1 on every server.
- **L3: PostgreSQL**, source of truth, hit only on full misses.

The viral tweet is served from thousands of app servers' local caches; Redis is hit only when a local cache is cold. The hot key problem disappears.

### Bottlenecks in the Feed Service

The algorithmic Fan-out Worker is the main bottleneck under high tweet volume from moderately popular accounts; the hybrid model handles celebrities. Merging celebrity tweets at read time adds latency proportional to the number of celebrities followed, mitigated by caching the merged result with a short TTL.

<<<SECTION 6>>>
## 7. Trending Service

Unique to Twitter: what the whole world is talking about now, updated in near real-time.

Trending is not most total tweets. #FIFA has billions of lifetime tweets and shouldn't trend forever. Trending means a **spike in activity now** versus the historical baseline: usage in the last hour significantly above the 24-hour average.

### Sliding Window Counter with Redis Sorted Sets

Per hashtag in incoming tweets: Key `hashtag:FIFA`, Member `tweet_id` (unique event ID), Score = tweet's Unix timestamp.

- Last-hour count: `ZCOUNT hashtag:FIFA (now - 3600) now`, O(log N), fast even with millions of entries.
- Periodic cleanup: `ZREMRANGEBYSCORE hashtag:FIFA 0 (now - 3600)`

This **sliding window counter** moves forward with time automatically, with no manual reset.

### Trending Computation Worker

Runs every 1-5 minutes:
1. Fetch top hashtags by recent count via ZCOUNT across active hashtag keys
2. Compute each hashtag's 24-hour baseline
3. Rank by spike ratio (percentage above baseline), not raw count
4. Write the top 50 to `trending:global` with a short TTL

Clients read `trending:global` with a single Redis GET; no computation at read time.

### Hashtag Extraction Pipeline

A **Hashtag Extraction Worker** consumes tweet.created from Kafka, parses hashtags, and for each calls `ZADD hashtag:{tag} <timestamp> <tweet_id>`. Kafka decouples this from tweet creation, which doesn't wait for it.

### Personalized Trending

Topics relevant to the user's location (country, city) and interest graph (accounts followed, topics engaged with), computed by the same Worker with those filters. Cached per user with a longer TTL, since it changes less often than global trending.

### Bottlenecks in the Trending Service

The extraction Worker handles 150 million tweets/day (~1700/sec), each possibly with multiple hashtags, so its pool must scale horizontally. Sorted set operations are sub-millisecond. The computation Worker is a periodic batch job and doesn't affect real-time performance.

<<<SECTION 7>>>
## 8. Search Service

Covers tweets (by content and hashtag), users (by username and display name), and hashtags as first-class objects.

### Storage Engine - Elasticsearch

Handles full-text search, partial matching, and relevance ranking for all three types. Ranking combines text match score with engagement: a highly liked tweet beats an obscure one for the same query.

### Elasticsearch Documents

Tweet document:

```
{
  "tweet_id": "123",
  "content": "Just shipped a new feature using Rust and WebAssembly",
  "hashtags": ["rust", "webassembly", "programming"],
  "author": "harry_dev",
  "author_follower_count": 15000,
  "like_count": 3200,
  "retweet_count": 890,
  "posted_at": "2026-06-20T10:00:00Z"
}
```

User document:

```
{
  "user_id": "456",
  "username": "harry_dev",
  "display_name": "Harry The Nerd",
  "bio": "Backend engineer. Writing about distributed systems.",
  "follower_count": 15000,
  "verified": false
}
```

Like, retweet, and follower counts are ranking signals; verified accounts rank higher in user search. Hashtags are indexed as separate terms, so searching #rust returns all tweets containing it.

### Keeping Elasticsearch in Sync

The Search Indexing Worker consumes tweet.created and tweet.transcoded. Engagement count updates are batched and synced periodically, since search results don't need real-time counts. Hot queries are cached in Redis with a short TTL.

### Bottlenecks in Search

Redis caching of hot queries filters most repeat traffic; horizontal scaling of the Elasticsearch cluster handles the rest.

<<<SECTION 8>>>
## 9. Interaction Service

Handles likes, replies, retweets, and bookmarks: the highest-volume writes after tweet creation.

### Like Flow

1. Client sends POST /likes with { user_id, tweet_id }
2. Idempotency: `SISMEMBER likes:tweet_123 user_456` in Redis; if already liked, ignore
3. `SADD likes:tweet_123 user_456` records the like
4. `INCR tweet:tweet_123:like_count` updates the counter
5. Publish like.created to Kafka
6. Consumers:
   - **Like Persistence Worker:** writes to the Likes table asynchronously
   - **Counter Sync Worker:** periodically syncs Redis counts to like_count on the Tweets row
   - **Notification Worker:** notifies the author via APNs/FCM

### Retweet Flow

1. Client sends POST /retweets with { user_id, tweet_id }
2. Redis idempotency check (one retweet per user per tweet)
3. Write to Retweets table asynchronously via Kafka
4. Increment the original's retweet_count in Redis
5. **Feed Fanout Worker** fans out to the retweeter's followers' feed sorted sets, not the original author's
6. Notify the original author

### Reply Flow

A reply is a tweet with non-null reply_to_id, created through the normal Tweet Service flow. The original's reply_count is incremented asynchronously via Kafka.

### Bottlenecks in the Interaction Service

Likes are the highest-volume operation; a viral tweet can get thousands per second. The Redis idempotency check and counter absorb this in memory; Kafka provides durability and decouples the hot path from PostgreSQL.

<<<SECTION 9>>>
## 10. Notification Service

Same as Instagram: Kafka fanout from interaction services, APNs (iOS), FCM (Android), and coalescing to prevent spam ("Harry and 4,999 others liked your tweet" instead of 5,000 pushes).

Subscribes to like.created, retweet.created, reply.created, follow.created, and mention.created (mentions extracted from tweet content by the Hashtag Extraction Worker).

Device tokens live in a Redis hash per user. In-app notifications are stored in a PostgreSQL Notifications table and served via WebSocket while the app is open.

## 11. Full Data Flow Summary

**Tweet Creation (text):**
Client -> API Gateway (auth) -> Tweet Service -> Redis write buffer (absorb spike) -> Kafka (tweet.created), consumed by:
- Metadata Worker -> Tweets DB + Redis Metadata Cache
- Search Worker -> Elasticsearch
- Feed Fanout Worker -> Redis feed sorted sets (normal users' followers) / Celebrity Tweet Cache (celebrity authors)
- Hashtag Worker -> ZADD hashtag:{tag} <timestamp> <tweet_id>
- Notification Worker -> mentions extracted -> APNs / FCM

**Tweet Creation (media):**
1. Client -> API Gateway (auth) -> Tweet Service -> presigned S3 URL
2. Client -> S3 (direct upload)
3. S3 -> Kafka -> Transcoding Service -> S3 (all variants)
4. Transcoding Service -> Kafka (tweet.transcoded) -> Metadata Worker (Tweets DB + Redis Cache), Search Worker (Elasticsearch), Feed Fanout Worker (Redis feed sorted sets)

**Algorithmic Feed Read:**
Client -> Feed Service -> Redis ZREVRANGE feed:{user_id}:algorithmic 0 19 -> Redis GET celebrity tweets (merged at read time) -> Redis MGET tweet:1 ... tweet:20 (hydrate) -> L1 local cache (viral tweets) -> CDN (media URLs)

**Chronological Feed Read:**
Client -> Feed Service -> Redis GET feed:{user_id}:chronological (hit) -> else PostgreSQL SELECT tweet_id FROM Tweets WHERE user_id IN (...) ORDER BY posted_at DESC LIMIT 20 -> Redis MGET (hydrate) -> write back to Redis with short TTL

**Like:**
Client -> Interaction Service -> Redis SISMEMBER likes:tweet_id user_id (idempotency) -> Redis INCR tweet:tweet_id:like_count -> Kafka (like.created) -> Like Persistence Worker (Likes table), Counter Sync Worker (Tweets.like_count, periodic batch), Notification Worker (APNs / FCM, coalesced)

**Trending:**
1. tweet.created -> Kafka -> Hashtag Extraction Worker -> ZADD hashtag:{tag} <timestamp> <tweet_id>
2. Trending Computation Worker (every 1-5 min): ZCOUNT hashtag:{tag} (now-3600) now (last hour) -> compare to 24hr baseline -> ZREMRANGEBYSCORE (evict old) -> SET trending:global [top 50 hashtags] with TTL
3. Client -> GET trending:global (single Redis read)

**Search:**
Client -> Search Service -> Redis (hot query cache) -> Elasticsearch (on miss) -> Redis MGET (hydrate tweet metadata)

<<<SECTION 10>>>
## 12. Resilience and Fault Tolerance

- **Redis write buffer** (tweets and interactions) absorbs thundering-herd spikes during global events; PostgreSQL never sees the raw spike and drains Kafka at a sustainable rate.
- **Multi-layer caching (L1/L2/L3)** removes the hot key problem: app server local caches serve most viral reads with zero network hops, Redis handles warm content, PostgreSQL only full misses.
- **Kafka durability:** no tweet, like, or retweet is lost if downstream services are down; consumers catch up on recovery.
- **Two-layer idempotency** for likes and retweets: Redis Set check on the hot path, PostgreSQL UNIQUE constraint as safety net. No double likes even under retries.
- **Sliding window counters** for trending are self-maintaining (ZREMRANGEBYSCORE evicts old entries). The Trending Computation Worker is a stateless batch job, restartable anytime without data loss.
- **CDN caching** of profile photos, tweet images, and video chunks from global edges; origin hit only on misses.
- **PostgreSQL read replicas** for all tables: no single point of failure for reads. Writes go to primary, reads fan out to replicas.
- **Chronological feed fallback:** if algorithmic precomputation lags, users can switch to chronological, computed at read time from PostgreSQL independently of fan-out.

<<<SECTION 11>>>
## 13. Technology Choices Summary

- **API Gateway** -> Kong / AWS API Gateway: auth, rate limiting, write spike shedding
- **Blob Storage** -> AWS S3: immutable media, durable, CDN-native
- **CDN** -> CloudFront / Akamai: edge caching of tweet media and profile photos
- **Transcoding** -> horizontally scaled worker pool via Kafka: image variants, HLS video chunking
- **Decoupling** -> Apache Kafka: tweet fanout, like durability, trending extraction, search indexing
- **Search Engine** -> Elasticsearch: full-text, hashtag indexing, engagement-weighted ranking
- **Users / Tweets / Likes DB** -> PostgreSQL, sharded + replicas: relational structure, strong consistency, composite indexes
- **Algorithmic Feed Store** -> Redis Sorted Sets per user: precomputed ranked feed, sub-millisecond reads
- **Chronological Feed Cache** -> Redis, short TTL: cached read-time feed
- **Tweet Metadata Cache** -> Redis MGET: batch hydration in one round trip
- **Hot Tweet Cache** -> L1 local in-memory (Caffeine LRU) + L2 Redis: hot key mitigation
- **Write Buffer** -> Redis: absorbs write spikes before Kafka and PostgreSQL
- **Trending Store** -> Redis Sorted Sets, sliding window: ZCOUNT for time-windowed hashtag frequency
- **Interaction Idempotency** -> Redis Set + PostgreSQL UNIQUE: two-layer duplicate prevention
- **Follows Graph** -> PostgreSQL + Neo4j / AWS Neptune: simple follows in SQL, suggested follows via graph traversal
