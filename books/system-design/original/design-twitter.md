# Design Twitter

<<<SECTION 1>>>
## High-Level Design: Twitter

## 1. Requirements

### Functional Requirements

- User profile management (name, username, profile photo, banner, bio, date of birth, followers, following)
- Create tweets (text up to 280 characters, images, videos)
- Like, reply, retweet, follow, unfollow
- Home feed (algorithmic and chronological modes)
- Trending page (global trending hashtags and topics)
- Search for tweets, users, and hashtags
- Notifications (likes, retweets, replies, follows, mentions)

### Out of Scope

- Direct Messages (same WebSocket architecture as Tinder)
- Twitter Spaces (live audio, separate real-time system)
- Twitter Blue / verified features
- Ad targeting system
- Analytics pipeline

### Non-Functional Requirements

- High availability across feed, tweet creation, and media serving
- Low latency feed reads under 100ms
- Handle coordinated write spikes during global events (World Cup goals, breaking news)
- Hot key resilience for viral tweets read by millions simultaneously
- Eventual consistency acceptable for like counts, retweet counts, and feed ranking
- Strong consistency required for follow/unfollow relationships and tweet existence

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 200 million
- **Original tweets per day:** 150 million (roughly 75% of active users posting once, others posting more)
- **Tweet composition:** 60% text only, 30% with images, 10% with videos
- **Text storage:** 60% x 150M x 300 bytes = ~27 GB/day (negligible)
- **Image storage:** 30% x 150M x 1 MB = ~45 TB/day
- **Video storage:** 10% x 150M x 10 MB = ~150 TB/day
- **Total storage per day:** ~200 TB/day, dominated by video
- **Read/write ratio:** approximately 3:1, far more balanced than Instagram or Reddit due to Twitter's highly engaged, active user base

The 3:1 read/write ratio is the most important number here. Unlike Instagram where celebrities produce and millions passively consume, Twitter's users are constantly retweeting, replying, and liking. This means the write path must be as robust and scalable as the read path, a constraint that does not exist in the same way for the other systems we have designed.

<<<SECTION 3>>>
## 3. API Gateway

All client requests enter through the API Gateway which handles authentication, rate limiting, and routing. The same constraint applies as every previous design: the API Gateway is never in the path of binary media payloads. Photo and video uploads bypass the Gateway after authentication using presigned S3 URLs for direct client-to-S3 upload.

Twitter's API Gateway has an additional concern compared to Instagram or Reddit: **write spike absorption**. During a major global event, millions of users simultaneously hit the tweet creation endpoint. Rate limiting at the Gateway level is the first line of defense, shedding excess traffic before it reaches downstream services.

## 4. User Service

The User Service manages all profile data including name, username, profile photo, banner image, bio, date of birth, follower count, and following count.

### Profile Photo and Banner Upload

Same presigned URL pattern :

1. Client authenticates via API Gateway and requests a presigned S3 URL from the User Service
1. Client uploads directly to S3
1. A Photo Processing Worker generates thumbnail and full resolution variants
1. CDN sits in front of S3 and serves profile media globally with high cache hit rates since profile photos change rarely

Data Model

### Users Table (PostgreSQL)

Users  
user_id           UUID, primary key  
username          VARCHAR, unique  
display_name      VARCHAR  
bio               TEXT  
profile_pic_url   TEXT  
banner_url        TEXT  
date_of_birth     DATE  
follower_count    INTEGER  
following_count   INTEGER  
tweet_count       INTEGER  
verified          BOOLEAN  
created_at        TIMESTAMP

follower_count, following_count, and tweet_count are denormalized counters updated asynchronously via Kafka consumers. Counting followers by querying the Follows table on every profile load would be catastrophically slow at Twitter's scale.

### Follows Table (PostgreSQL)

Follows  
follower_id     UUID, foreign key -> Users  
followee_id     UUID, foreign key -> Users  
created_at      TIMESTAMP  
PRIMARY KEY (follower_id, followee_id)

A follow is an INSERT, an unfollow is a DELETE. "Give me everyone user X follows" is WHERE follower_id = X. Indexed on both columns for fast lookups in both directions. For second-degree relationships like suggested follows and mutual friends, a graph database like Neo4j or AWS Neptune is more appropriate since graph traversals across millions of nodes are native in graph DBs but expensive in relational joins.

### Bottlenecks in the User Service

User profiles are read far more often than they are written. Redis caches hot profiles including verified accounts and celebrities whose profiles are fetched millions of times per day. The PostgreSQL read replicas handle the remaining traffic. The Follows table grows large at Twitter's scale with billions of rows and is sharded by follower_id to keep individual shard sizes manageable.

<<<SECTION 4>>>
## 5. Tweet Service and Upload Pipeline

Tweet Creation Flow

### Text tweets:

1. Client sends POST /tweets with content to the Tweet Service via API Gateway
1. Tweet Service writes to the Tweets DB
1. Publishes tweet.created event to Kafka
1. Kafka consumers fan out to feed, search, and notification systems

### Media tweets:

1. Client requests a presigned S3 URL from the Tweet Service
1. Client uploads media directly to S3
1. S3 triggers a media.uploaded event to Kafka
1. Transcoding Service picks up the event and processes:Images: generates thumbnail, medium, and full resolution variants, applies WebP compression  
Videos: generates multiple quality variants (360p, 480p, 720p, 1080p), chunks into HLS segments for adaptive streaming, generates a preview thumbnail
1. All variants stored in S3 under media/{tweet_id}/{variant}/
1. Transcoding Service publishes tweet.transcoded event to Kafka
1. Three consumers pick up the event independently:**Metadata Worker** writes tweet metadata to Tweets DB and populates Tweet Metadata Cache in Redis  
**Search Indexing Worker** indexes the tweet into Elasticsearch  
**Feed Fanout Worker** begins writing the tweet into followers' feed sorted sets

Data Model

### Tweets Table (PostgreSQL)

Tweets  
tweet_id        UUID, primary key  
user_id         UUID, foreign key -> Users  
content         VARCHAR(280)  
media_url       TEXT (null for text tweets)  
media_type      ENUM('none', 'image', 'video')  
reply_to_id     UUID, foreign key -> Tweets (null for original tweets)  
like_count      INTEGER  
retweet_count   INTEGER  
reply_count     INTEGER  
view_count      INTEGER  
posted_at       TIMESTAMP

like_count, retweet_count, reply_count, and view_count are all denormalized counters updated asynchronously. The source of truth for individual interactions lives in separate tables (Likes, Retweets, Replies) but counts are maintained on the Tweet row for fast reads.

### Retweets Table (PostgreSQL)

Retweets  
retweet_id          UUID, primary key  
original_tweet_id   UUID, foreign key -> Tweets  
retweeter_id        UUID, foreign key -> Users  
retweeted_at        TIMESTAMP

A retweet is a reference to an existing tweet and no new content is stored. The retweet_count on the original tweet row is incremented asynchronously by a Kafka consumer. When user A retweets a post, it fans out to user A's followers, not the original author's followers. The original author receives only a notification.

### Likes Table (PostgreSQL)

Likes  
like_id     UUID, primary key  
tweet_id    UUID, foreign key -> Tweets  
user_id     UUID, foreign key -> Users  
liked_at    TIMESTAMP  
UNIQUE (tweet_id, user_id)

The UNIQUE constraint enforces like idempotency at the database level. Like counts on the Tweet row are the fast read path and the Likes table is the source of truth.

### Write Spike Handling

During a global event, millions of users tweet simultaneously. Writing every tweet synchronously to PostgreSQL under this load would cause the database to collapse. The mitigation is a write buffer in Redis:

1. Tweet is written to Redis immediately on creation
1. tweet.created event published to Kafka
1. Kafka consumer writes to PostgreSQL asynchronously off the hot path
1. Redis write buffer absorbs the spike and PostgreSQL writes at a sustainable rate

Like and retweet counts follow the same pattern, incremented in Redis first and flushed to PostgreSQL asynchronously via Kafka.

### Bottlenecks in the Tweet Service

The Transcoding Service is the bottleneck for media tweets. Horizontal scaling of the worker pool handles this. For text tweets, the bottleneck is the write spike problem described above, which is mitigated by the Redis write buffer and Kafka decoupling.

<<<SECTION 5>>>
## 6. Feed Service

Twitter's feed has two modes that operate differently at the infrastructure level: algorithmic feed and chronological feed.

### Algorithmic Feed

The algorithmic feed ranks tweets by relevance, engagement, and relationship closeness. This ranking is expensive to compute at read time, so it is precomputed via fan-out on write.

### Fan-out strategy:

- **Normal users (below follower threshold):** Fan-out on write. When user A tweets, the Feed Fanout Worker writes the tweet into the feed sorted sets of all of user A's followers immediately.
- **Celebrity users (above follower threshold, say 1 million followers):** Fan-out on read. Their tweets are stored in a Celebrity Tweets Cache in Redis. At feed read time, the Feed Service fetches the latest celebrity tweets and merges them with the precomputed feed.

### Redis Sorted Set structure:

Key: feed:{user_id}:algorithmic  
Member: tweet_id  
Score: relevance score (combination of recency, engagement signals, relationship closeness)

ZREVRANGE feed:user_123:algorithmic 0 19 returns the top 20 tweet IDs instantly.

### Chronological Feed

The chronological feed is pure reverse time order with the latest tweets from followed accounts first. Because ranking is not needed, read time computation is viable and avoids the fan-out write problem for high-follower accounts entirely.

At read time:

1. Fetch the list of accounts the user follows from Redis
1. Query PostgreSQL: SELECT tweet_id FROM Tweets WHERE user_id IN (followed_accounts) ORDER BY posted_at DESC LIMIT 20
1. With a composite index on (user_id, posted_at), this query is fast even across thousands of followed accounts
1. Result cached in Redis per user with a short TTL: feed:{user_id}:chronological

Repeat opens of the chronological feed hit Redis, not PostgreSQL.

### Feed Hydration

Both feed modes return tweet IDs. Full tweet content is hydrated via Redis MGET:

MGET tweet:101 tweet:202 tweet:303 ... tweet:2020

Single round trip, all 20 tweet metadata records fetched simultaneously. On cache miss, falls back to PostgreSQL and writes back to Redis.

### Hot Key Problem

When a celebrity with 50 million followers tweets something viral, that single tweet's cache key is read millions of times per minute. Standard Redis caching struggles because all reads hit the same Redis node for the same key.

The solution is **multi-layer caching (L1/L2/L3)**:

- **L1 - Local in-memory cache** on each application server (using an LRU cache like Caffeine in Java). Each app server caches the viral tweet in its own memory. Zero network hop, sub-microsecond reads.
- **L2 - Redis** for tweets that are hot but not viral enough to warrant L1 caching on every server
- **L3 - PostgreSQL** as the source of truth, hit only on full cache misses

A viral tweet read by 50 million users is served from thousands of app server local caches simultaneously. Redis is only hit when a server's local cache is cold. The hot key problem disappears entirely.

### Bottlenecks in the Feed Service

The Fan-out Worker for the algorithmic feed is the primary bottleneck during high tweet volume from moderately popular accounts. The hybrid model mitigates this for celebrities. The merge step for celebrity tweets at read time adds latency proportional to the number of celebrity accounts a user follows, mitigated by caching the merged result with a short TTL.

<<<SECTION 6>>>
## 7. Trending Service

The Trending page shows what the entire world is talking about right now, updated in near real-time. This is unique to Twitter.  
  
Trending is not simply the hashtags with the most total tweets. [#FIFA](https://x.com/search?q=%23FIFA&src=hashtag_click) has billions of tweets over its lifetime and should not trend forever. Trending means a **spike in activity right now** compared to the historical baseline. A hashtag trending means its usage in the last hour is significantly above its average usage over the last 24 hours.

### Sliding Window Counter with Redis Sorted Sets

For every hashtag extracted from an incoming tweet, the Trending Service maintains a Redis Sorted Set:

Key: hashtag:FIFA  
Member: tweet_id (unique event identifier)  
Score: Unix timestamp of the tweet

To count how many times [#FIFA](https://x.com/search?q=%23FIFA&src=hashtag_click) was used in the last hour:

ZCOUNT hashtag:FIFA (now - 3600) now

This is an O(log N) operation, extremely fast even with millions of entries. Old entries outside the window are periodically cleaned up:

ZREMRANGEBYSCORE hashtag:FIFA 0 (now - 3600)

This is a **sliding window counter**. The window moves forward with time automatically, keeping counts fresh without any manual reset.

Trending Computation Worker

A Trending Computation Worker runs every 1-5 minutes and:

1. Fetches the top hashtags by recent tweet count using ZCOUNT across all active hashtag keys
1. Computes the 24-hour baseline tweet count for each hashtag
1. Ranks hashtags by spike ratio, the percentage jump above baseline, not raw count
1. Writes the top 50 trending topics to a Redis key: trending:global with a short TTL

The client reads trending:global on every page load, a single Redis GET returning the precomputed list. No computation happens at read time.

### Hashtag Extraction Pipeline

When a tweet is created, a **Hashtag Extraction Worker** consumes from the tweet.created Kafka topic, parses the tweet content for hashtags, and for each hashtag calls:

ZADD hashtag:{tag} <timestamp> <tweet_id>

This is decoupled from the tweet creation hot path via Kafka. Tweet creation does not wait for hashtag extraction.

### Personalized Trending

Twitter also shows personalized trending, topics relevant to your location and interests. This is computed by the same Worker but filtered by the user's location (country, city) and interest graph (accounts they follow, topics they engage with). Personalized trending results are cached per user with a longer TTL since they change less frequently than global trending.

### Bottlenecks in the Trending Service

The Hashtag Extraction Worker must process 150 million tweets per day, roughly 1700 tweets per second. Each tweet can contain multiple hashtags. At this rate, the Worker pool must be horizontally scaled to keep up. The Redis Sorted Set operations are sub-millisecond each and not a concern. The Trending Computation Worker running every few minutes is a batch job and does not affect real-time performance.

<<<SECTION 7>>>
## 8. Search Service

Twitter search covers three entities: tweets (by content and hashtag), users (by username and display name), and hashtags as first-class searchable objects.

### Storage Engine - Elasticsearch

Elasticsearch handles full-text search, partial matching, and relevance ranking across all three entity types. Twitter search combines text match score with engagement signals. A highly liked tweet ranks above an obscure tweet for the same search query.

### Elasticsearch Documents

### Tweet document:

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

### User document:

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

Like count, retweet count, and follower count act as ranking signals. Verified accounts rank higher for user searches. Hashtags in tweets are indexed as separate terms so searching [#rust](https://x.com/search?q=%23rust&src=hashtag_click) returns all tweets containing that hashtag.

### Keeping Elasticsearch in Sync

The Search Indexing Worker consumes from the tweet.created and tweet.transcoded Kafka topics. Engagement count updates are batched and synced to Elasticsearch periodically rather than on every interaction since exact counts in search results do not need to be real-time.

Hot search queries are cached in Redis with a short TTL to reduce Elasticsearch load.

### Bottlenecks in Search

Same pattern as all previous designs. Redis caching for hot queries filters the majority of repeat traffic before hitting Elasticsearch. Horizontal scaling of the Elasticsearch cluster handles remaining query volume.

<<<SECTION 8>>>
## 9. Interaction Service

The Interaction Service handles likes, replies, retweets, and bookmarks. These are the highest volume write operations in the system after tweet creation itself.

Like Flow

1. Client sends POST /likes with { user_id, tweet_id }
1. Idempotency check: SISMEMBER likes:tweet_123 user_456 in Redis. If already liked, ignore.
1. SADD likes:tweet_123 user_456 to record the like in Redis
1. INCR tweet:tweet_123:like_count to update the counter in Redis
1. Publish like.created event to Kafka
1. Kafka consumers:**Like Persistence Worker** writes to Likes Table in PostgreSQL asynchronously  
**Counter Sync Worker** periodically syncs Redis like counts to the like_count column on the Tweets row in PostgreSQL  
**Notification Worker** triggers a notification to the tweet author via APNs/FCM

### Retweet Flow

1. Client sends POST /retweets with { user_id, tweet_id }
1. Idempotency check in Redis, a user can only retweet a tweet once
1. Write to Retweets Table asynchronously via Kafka
1. Increment retweet_count on the original tweet in Redis
1. **Feed Fanout Worker** fans out the retweeted tweet to the retweeter's followers' feed sorted sets, not the original author's followers
1. Notification sent to the original author

### Reply Flow

Replies are tweets with a non-null reply_to_id. A reply is created through the same Tweet Service flow as an original tweet, with the additional reply_to_id field set. The original tweet's reply_count is incremented asynchronously via Kafka.

### Bottlenecks in the Interaction Service

Likes are the highest volume operation. A viral tweet can receive thousands of likes per second. The Redis idempotency check and counter increment absorb this entirely in-memory. Kafka handles durability and decouples the hot path from PostgreSQL writes.

<<<SECTION 9>>>
## 10. Notification Service

Same architecture as Instagram. Kafka fanout from all interaction services, APNs for iOS, FCM for Android, with notification coalescing to prevent spam. "Harry and 4,999 others liked your tweet" instead of 5,000 individual push notifications.

The Notification Service subscribes to:

- like.created topic
- retweet.created topic
- reply.created topic
- follow.created topic
- mention.created topic (extracted from tweet content by the Hashtag Extraction Worker)

Device tokens stored in a simple Redis hash per user. In-app notifications stored in a Notifications Table in PostgreSQL, served via WebSocket when the app is open.

## 11. Full Data Flow Summary

**Tweet Creation Flow (text):**  
Client -> API Gateway (auth) -> Tweet Service  
-> Redis write buffer (absorb spike)  
-> Kafka (tweet.created)  
    -> Metadata Worker       -> Tweets DB + Redis Metadata Cache  
    -> Search Worker         -> Elasticsearch  
    -> Feed Fanout Worker    -> Redis feed sorted sets (normal user followers)  
                             -> Celebrity Tweet Cache (for celebrity authors)  
    -> Hashtag Worker        -> ZADD hashtag:{tag} <timestamp> <tweet_id>  
    -> Notification Worker   -> mentions extracted -> APNs / FCM  
  
**Tweet Creation Flow (media):**  
Client -> API Gateway (auth) -> Tweet Service -> presigned S3 URL  
Client -> S3 (direct upload)  
S3 -> Kafka -> Transcoding Service -> S3 (all variants)  
Transcoding Service -> Kafka (tweet.transcoded)  
    -> Metadata Worker    -> Tweets DB + Redis Cache  
    -> Search Worker      -> Elasticsearch  
    -> Feed Fanout Worker -> Redis feed sorted sets  
  
**Algorithmic Feed Read Flow:**  
Client -> Feed Service  
-> Redis ZREVRANGE feed:{user_id}:algorithmic 0 19  
-> Redis GET celebrity tweets (merged at read time for celebrity followees)  
-> Redis MGET tweet:1 tweet:2 ... tweet:20 (hydrate metadata)  
-> L1 local cache (viral tweets served from app server memory)  
-> CDN (media URLs served directly)  
  
**Chronological Feed Read Flow:**  
Client -> Feed Service  
-> Redis GET feed:{user_id}:chronological (cache hit)  
-> PostgreSQL: SELECT tweet_id FROM Tweets WHERE user_id IN (...) ORDER BY posted_at DESC LIMIT 20  
-> Redis MGET (hydrate metadata)  
-> Write result back to Redis with short TTL  
  
**Like Flow:**  
Client likes tweet -> Interaction Service  
-> Redis SISMEMBER likes:tweet_id user_id (idempotency)  
-> Redis INCR tweet:tweet_id:like_count  
-> Kafka (like.created)  
    -> Like Persistence Worker  -> PostgreSQL Likes Table  
    -> Counter Sync Worker      -> PostgreSQL [Tweets.like](https://x.com//Tweets.like)_count (periodic batch)  
    -> Notification Worker      -> APNs / FCM (coalesced)  
  
**Trending Flow:**  
tweet.created -> Kafka -> Hashtag Extraction Worker  
-> ZADD hashtag:{tag} <timestamp> <tweet_id>  
Trending Computation Worker (every 1-5 min)  
-> ZCOUNT hashtag:{tag} (now-3600) now (last hour count)  
-> Compare against 24hr baseline  
-> ZREMRANGEBYSCORE (evict old entries)  
-> SET trending:global \[top 50 hashtags\] with TTL  
Client -> GET trending:global (single Redis read)  
  
**Search Flow:**  
Client -> Search Service  
-> Redis (hot query cache)  
-> Elasticsearch (cache miss)  
-> Redis MGET (hydrate tweet metadata for results)

<<<SECTION 10>>>
## 12. Resilience and Fault Tolerance

**Redis write buffer** for tweet creation and interactions absorbs thundering herd write spikes during global events. PostgreSQL never receives the raw spike and processes writes at a sustainable rate from the Kafka queue.

**Multi-layer caching (L1/L2/L3)** for viral tweets eliminates the hot key problem. App server local caches serve the vast majority of reads for viral content with zero network hops. Redis handles warm content. PostgreSQL is only hit on full cache misses.

**Kafka durability** throughout the pipeline means no tweet, like, or retweet is ever lost even if downstream services are temporarily unavailable. All consumers can fall behind and catch up on recovery without data loss.

**Idempotency at two layers** for likes and retweets: Redis Set check on the hot path and a PostgreSQL UNIQUE constraint as a safety net. A user can never like the same tweet twice even under retry conditions.

**Sliding window counters in Redis** for trending are self-maintaining. Old entries expire automatically via ZREMRANGEBYSCORE. The Trending Computation Worker is a stateless batch job that can be restarted at any time without data loss.

**CDN caching** for all media means profile photos, tweet images, and video chunks are served from edge nodes globally. Origin infrastructure is only hit on cache misses.

**Read replicas on PostgreSQL** for all tables ensure no single point of failure for reads. Writes go to the primary and reads fan out across replicas.

**Chronological feed fallback** means if the algorithmic feed precomputation pipeline is lagging, users can always switch to chronological mode which computes at read time from PostgreSQL independently of the fan-out pipeline.

<<<SECTION 11>>>
## 13. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, write spike shedding)

**Blob Storage** -> AWS S3 (Immutable media files, durable, CDN-native)

**CDN** -> CloudFront / Akamai (Edge caching for tweet media and profile photos)

**Transcoding** -> Horizontally scaled worker pool via Kafka (Image variants, HLS video chunking)

**Decoupling** -> Apache Kafka (Tweet fanout, like durability, trending extraction, search indexing)

**Search Engine** -> Elasticsearch (Full-text search, hashtag indexing, engagement-weighted ranking)

**Users / Tweets / Likes DB** -> PostgreSQL sharded + replicas (Relational structure, strong consistency, composite indexes)

**Algorithmic Feed Store** -> Redis Sorted Sets per user (Precomputed ranked feed, sub-millisecond reads)

**Chronological Feed Cache** -> Redis with short TTL (Cached read-time computed feed)

**Tweet Metadata Cache** -> Redis MGET (Batch hydration of tweet content in single round trip)

**Hot Tweet Cache** -> L1 local in-memory (Caffeine LRU) + L2 Redis (Multi-layer hot key mitigation)

**Write Buffer** -> Redis (Absorb thundering herd write spikes before Kafka and PostgreSQL)

**Trending Store** -> Redis Sorted Sets with sliding window (ZCOUNT for time-windowed hashtag frequency)

**Interaction Idempotency** -> Redis Set + PostgreSQL UNIQUE constraint (Two-layer duplicate prevention)

**Follows Graph** -> PostgreSQL + Neo4j / AWS Neptune (Simple follow in SQL, suggested follows via graph traversal)  
  
That's all, folks...Cheers!!
