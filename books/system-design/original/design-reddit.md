# Design Reddit

<<<SECTION 1>>>
## High-Level Design: Reddit

## 1. Requirements

### Functional Requirements

- Create posts (text, image, video)
- Upvote and downvote posts and comments
- Threaded nested comments
- Join subreddits and follow users
- Home feed based on joined subreddits
- Subreddit feed with sorting modes: Hot, New, Top, Controversial
- Search for posts, subreddits, and users
- Create a subreddit

Out of Scope

- Chat (same WebSocket architecture as Tinder)
- Reddit Awards and coins
- Moderation tools
- Reddit Ads

### Non-Functional Requirements

- High availability across feed, voting, and media serving
- Low latency feed reads under 100ms
- Votes must never be lost even under traffic spikes
- Hotness scores must reflect recent activity with time decay
- Eventual consistency acceptable for vote counts and feed ranking
- Strong consistency required for vote idempotency (a user cannot vote twice on the same post)

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 50 million
- **Posts per day:** 10 million (20% of DAU)
- **Average post size:** ~2 MB weighted average across text (100 KB), images (500 KB to 1 MB), and videos (up to 10 MB)
- **Post storage per day:** 10M x 2 MB = 20 TB/day
- **Votes per day:** 50M DAU x 5 votes each = 250 million votes/day = ~3000 votes/second at peak, with viral spikes far higher
- **Comments per day:** roughly 100 million (2 comments per DAU on average)

The dominant write load is votes at 3000 per second, not posts. Every vote potentially triggers a hotness score recomputation. This is the primary design constraint for the voting and feed systems. Media storage at 20 TB/day is significant but manageable with S3 and CDN caching.

## 3. API Gateway

All client requests enter through the API Gateway which handles authentication, rate limiting, and routing. The same constraint applies as in every previous design: the API Gateway is never in the path of binary media payloads. Image and video uploads bypass the Gateway after authentication using a presigned S3 URL for direct client-to-S3 upload.

<<<SECTION 3>>>
## 4. Post Service and Upload Pipeline

### Upload Flow

When a user creates a post with media:

1. Client authenticates via API Gateway and requests a presigned S3 URL from the Post Service
1. Client uploads media directly to S3 using the presigned URL
1. S3 emits an upload event which triggers the Transcoding Service via Kafka
1. The Transcoding Service processes media:Images: generates thumbnail, medium, and full resolution variants, applies compression and WebP conversion  
Videos: generates multiple quality variants (360p, 480p, 720p, 1080p), chunks into HLS segments for adaptive streaming, generates a thumbnail frame
1. All variants are written back to S3 under a deterministic path: media/{post_id}/{variant}/
1. Transcoding completes and publishes a post.transcoded event to Kafka
1. Two consumers pick up the event independently:**Metadata Worker** writes post metadata to the Posts DB and populates the Post Metadata Cache in Redis  
**Search Indexing Worker** indexes the post into Elasticsearch

For text-only posts, steps 1 through 6 are skipped entirely. The Post Service writes directly to the Posts DB and publishes a post.created event to Kafka.

### Data Model

### Posts Table (PostgreSQL)

Posts  
post_id         UUID, primary key  
subreddit_id    UUID, foreign key -> Subreddits  
user_id         UUID, foreign key -> Users  
title           VARCHAR  
content         TEXT (null for media posts)  
media_url       TEXT (null for text posts)  
media_type      ENUM('text', 'image', 'video')  
upvotes         INTEGER  
downvotes       INTEGER  
score           INTEGER  
hot_score       FLOAT  
posted_at       TIMESTAMP

upvotes, downvotes, score, and hot_score are denormalized counters maintained asynchronously via Kafka consumers. This avoids expensive aggregation queries at read time.

### Subreddits Table (PostgreSQL)

Subreddits  
  
subreddit_id    UUID, primary key  
name            VARCHAR, unique  
description     TEXT  
member_count    INTEGER  
created_by      UUID, foreign key -> Users  
created_at      TIMESTAMP

### SubredditMembers Table (PostgreSQL)

SubredditMembers  
  
user_id         UUID, foreign key -> Users  
subreddit_id    UUID, foreign key -> Subreddits  
joined_at       TIMESTAMP  
PRIMARY KEY (user_id, subreddit_id)

This is a many-to-many join table. Joining a subreddit is an INSERT, leaving is a DELETE. "Give me all subreddits user X has joined" is a simple WHERE user_id = X query.

### Bottlenecks in the Post Service

The Post Service itself is stateless and horizontally scalable. The Transcoding Service is the bottleneck for media posts since generating multiple video quality variants is CPU-intensive. This is handled by running the Transcoding Service as a horizontally scalable worker pool pulling jobs from a Kafka topic. Text posts have no bottleneck.

<<<SECTION 4>>>
## 5. Voting Service

Voting is the highest volume write path in the system at 3000 votes per second on average, with extreme spikes on viral posts. The voting system must handle burst traffic without data loss, prevent duplicate votes, and keep hotness scores up to date.

Full Vote Flow

**Step 1 - Receive Vote**  
Client sends POST /votes with { user_id, post_id, direction: 'up' | 'down' } to the Vote Service via API Gateway.

**Step 2 - Idempotency Check in Redis**  
Before any processing, the Vote Service checks whether the user has already voted on this post using a Redis Set:

SGET vote:user_123:post_456

If the user has already voted the same direction, the request is ignored. If the user is switching their vote (upvote to downvote), the delta is computed and processed. This idempotency check happens entirely in Redis on the hot path without touching the database.

**Step 3 - Increment Vote Counter in Redis**  
Vote counters are updated immediately in Redis:

INCR post:post_456:upvotes

Clients read vote counts from Redis, not from the database. This ensures near real-time vote count updates on viral posts without any database read pressure.

**Step 4 - Publish to Kafka**  
The Vote Service publishes a vote.created event to Kafka immediately after the Redis update. This decouples the hot path from all downstream processing and provides durability. Even if downstream services are temporarily slow, no vote is lost.

**Step 5 - Kafka Consumers**  
Three consumers process the event independently:

**Vote Persistence Worker** writes the vote to the Votes Table in PostgreSQL asynchronously. This is the permanent record of every vote.

**Score Recomputation Worker** recomputes the hotness score for the post. Reddit's hotness algorithm is a function of the net upvote score and the time elapsed since the post was created. Newer posts with fewer upvotes can outrank older posts with more upvotes because the time decay factor penalizes age aggressively. The recomputed score is written back to the Redis Sorted Set:

ZADD subreddit:programming:hot <new_hot_score> post_456

The subreddit's Hot feed is updated instantly without any read-time computation.

**Controversial Score Worker** separately computes the controversial score. A post is controversial when it has a high total vote count but a nearly equal upvote/downvote split. This score is written to a separate sorted set:

ZADD subreddit:programming:controversial <controversial_score> post_456

**Step 6 - Periodic Reconciliation**  
Redis vote counters are the fast read path. PostgreSQL is the source of truth. A background job periodically reconciles Redis counters against the database to catch any drift caused by Redis restarts or missed events.

### Votes Table (PostgreSQL)

Votes  
vote_id       UUID, primary key  
user_id       UUID, foreign key -> Users  
post_id       UUID, foreign key -> Posts  
direction     ENUM('up', 'down')  
voted_at      TIMESTAMP  
UNIQUE (user_id, post_id)

The UNIQUE constraint on (user_id, post_id) enforces vote idempotency at the database level as a safety net, even though the Redis check handles it on the hot path.

Bottlenecks in the Voting Service

The Redis operations are sub-millisecond and handle the peak vote throughput comfortably. Kafka absorbs burst traffic from viral posts. The Score Recomputation Worker can become a bottleneck if a single post receives thousands of votes per second, since each vote triggers a recomputation. This is mitigated by debouncing recomputation in the worker: instead of recomputing on every single vote event, the worker batches vote events for the same post within a short window (say 5 seconds) and recomputes once per window. This reduces recomputation overhead by orders of magnitude on viral posts while keeping scores fresh.

<<<SECTION 5>>>
## 6. Feed Service

Reddit's feed is subreddit-based, not follow-based. A user joins 50 subreddits. The home feed shows the best posts across all 50 subreddits, ranked by the selected sorting mode.

Redis Sorted Sets per Subreddit per Sorting Mode

Each subreddit maintains four Redis Sorted Sets, one per sorting mode:

subreddit:{subreddit_id}:hot            scored by hot_score (upvotes + time decay)  
subreddit:{subreddit_id}:new            scored by posted_at timestamp  
subreddit:{subreddit_id}:top            scored by net upvote count  
subreddit:{subreddit_id}:controversial  scored by controversial score

These are updated in real time by Kafka consumers as votes come in and new posts are created. Feed reads are always served from Redis and never touch the Posts DB directly in the happy path.

### Fan-out Strategy

Reddit uses a hybrid fan-out model similar to Instagram but based on subreddit size rather than user follower count:

**Fan-out on write (small subreddits):** When a post is created in a small subreddit (below a member threshold, say 100,000 members), the Feed Fanout Worker writes the post directly into the home feed sorted sets of all members. Each member's home feed is a Redis Sorted Set:

Key: feed:{user_id}:home  
Member: post_id  
Score: hot_score

**Fan-out on read (large subreddits):** For large subreddits like r/programming or r/worldnews with millions of members, fan-out on write is impractical. Instead, their subreddit sorted sets are read directly at feed request time and merged with the user's precomputed home feed. A post going viral in r/worldnews does not trigger writes to millions of home feed sorted sets.

Home Feed Read Flow

When a user opens Reddit:

1. Feed Service fetches the user's joined subreddits from the SubredditMembers cache in Redis
1. For small subreddits: reads from the precomputed feed:{user_id}:home sorted set
1. For large subreddits: reads top posts directly from subreddit:{subreddit_id}:hot
1. Merges and re-ranks results across all subreddits
1. Returns top 25 post IDs to the client
1. Feed Service hydrates post IDs via Redis MGET post:1 post:2 ... post:25
1. On cache miss for any post, falls back to Posts DB and writes back to Redis
1. Client renders feed with full post metadata and media URLs pointing to CDN

### Subreddit Feed Read Flow

When a user opens a specific subreddit with a sorting mode:

1. Feed Service reads directly from subreddit:{subreddit_id}:{sort_mode} sorted set
1. ZREVRANGE subreddit:programming:hot 0 24 returns top 25 post IDs instantly
1. Post metadata hydrated via Redis MGET
1. Media served via CDN

Bottlenecks in the Feed Service

The merge step for large subreddits at read time adds latency proportional to the number of large subreddits a user follows. This is mitigated by capping the number of large subreddit reads per request and caching the merged result in Redis with a short TTL (30-60 seconds) per user. Home feed sorted sets for inactive users are evicted from Redis and rebuilt from the Posts DB on next login.

<<<SECTION 6>>>
## 7. Comment Service

Threaded nested comments are Reddit's most distinctive data structure challenge. A comment can have replies, those replies can have replies, to arbitrary depth. Each comment has its own upvote/downvote score.

Adjacency List Data Model

The comment tree is stored using the Adjacency List pattern in PostgreSQL. Each comment stores a reference to its parent:

**Comments**  
comment_id      UUID, primary key  
post_id         UUID, foreign key -> Posts  
parent_id       UUID, foreign key -> Comments (NULL for top-level comments)  
user_id         UUID, foreign key -> Users  
content         TEXT  
upvotes         INTEGER  
downvotes       INTEGER  
score           INTEGER  
created_at      TIMESTAMP

A parent_id of NULL means the comment is a direct reply to the post. A non-null parent_id means it is a reply to another comment. This single column captures the entire tree structure without a graph database.

A composite index on (post_id, parent_id) makes the two primary queries fast:

```
Top-level comments for a post, sorted by score
SELECT * FROM Comments
WHERE post_id = X AND parent_id IS NULL
ORDER BY score DESC
LIMIT 20

Replies to a specific comment, sorted by score
SELECT * FROM Comments
WHERE parent_id = comment_123
ORDER BY score DESC
LIMIT 10
```

### Lazy Loading

Reddit does not load the entire comment tree in one request. The full tree for a popular post could have hundreds of thousands of comments. Instead it uses lazy loading:

1. Fetch top 20 top-level comments sorted by score
1. For each top-level comment, fetch the top 3 replies
1. Deeper levels show a "load more replies" button which triggers a separate request

This keeps initial page load fast regardless of comment tree depth.

Comment Vote Flow

Comment votes follow the exact same Kafka pipeline as post votes. Each comment has its own score counter maintained by the Score Recomputation Worker. The comment sorted order within a thread is recomputed asynchronously after each vote batch.

Hot comments for popular posts are cached in Redis with a short TTL to avoid repeated PostgreSQL queries for the same comment thread.

Bottlenecks in the Comment Service

The Adjacency List pattern works well for fetching one level at a time via lazy loading. The bottleneck is deep recursive fetches if a client tries to load the full tree in one shot. This is prevented by enforcing pagination and depth limits at the API layer. PostgreSQL handles comment writes at the volume Reddit sees comfortably since comments are far less frequent than votes.

<<<SECTION 7>>>
## 8. Search Service

Reddit search covers three entities: posts (by title and content), subreddits (by name and description), and users (by username).

### Storage Engine - Elasticsearch

Elasticsearch handles full-text search, partial matching, and relevance ranking across all three entity types. Reddit search is primarily keyword-based rather than engagement-weighted like Instagram, but subreddit size and post score are still used as ranking signals.

Elasticsearch Documents

### Post document:

```
{
  "post_id": "123",
  "title": "Why Rust is taking over systems programming",
  "content": "A deep dive into memory safety...",
  "subreddit": "programming",
  "subreddit_id": "456",
  "author": "harry_dev",
  "score": 15000,
  "posted_at": "2026-06-10T10:00:00Z"
}
```

### Subreddit document:

```
{
  "subreddit_id": "456",
  "name": "programming",
  "description": "Computer programming discussion",
  "member_count": 5000000
}
```

Post score and subreddit member count act as ranking signals. A highly upvoted post in a large subreddit ranks above a low-score post in a tiny subreddit for the same search query.

Keeping Elasticsearch in Sync

The Search Indexing Worker consumes from the post.transcoded and post.created Kafka topics for new posts. Score updates are batched and synced to Elasticsearch periodically rather than on every vote, since exact scores in search results do not need to be real-time.

Hot search queries are cached in Redis with a short TTL to reduce Elasticsearch load for popular searches.

### Bottlenecks in Search

Same as Instagram and Spotify. Redis caching for hot queries filters the majority of repeat traffic before hitting Elasticsearch. Horizontal scaling of the Elasticsearch cluster handles the remaining query volume.

<<<SECTION 8>>>
## 9. Full Data Flow Summary

**Post Upload Flow:**  
Client -> API Gateway (auth) -> Post Service -> presigned S3 URL  
Client -> S3 (direct upload)  
S3 -> Kafka -> Transcoding Service -> S3 (all variants)  
Transcoding Service -> Kafka (post.transcoded)  
  -> Metadata Worker      -> Posts DB + Redis Cache  
  -> Search Worker        -> Elasticsearch  
  -> Feed Fanout Worker   -> Redis home feed sorted sets (small subreddits)  
                          -> Subreddit sorted sets (all subreddits)  
  
**Vote Flow:**  
Client upvotes post -> Vote Service  
  -> Redis idempotency check (SGET vote:user:post)  
  -> Redis INCR post:post_id:upvotes  
  -> Kafka (vote.created)  
      -> Vote Persistence Worker   -> PostgreSQL Votes Table  
      -> Score Recomputation Worker -> ZADD subreddit:id:hot <new_score> post_id  
      -> Controversial Score Worker -> ZADD subreddit:id:controversial <score> post_id  
  
**Home Feed Read Flow:**  
Client opens Reddit -> Feed Service  
  -> Redis: fetch joined subreddits for user  
  -> Redis ZREVRANGE feed:{user_id}:home (small subreddit posts)  
  -> Redis ZREVRANGE subreddit:{id}:hot (large subreddit posts, merged at read time)  
  -> Redis MGET post:1 post:2 ... post:25 (hydrate metadata)  
  -> CDN (media URLs served directly)  
  
Subreddit Feed Read Flow:  
Client opens r/programming -> Feed Service  
  -> Redis ZREVRANGE subreddit:programming:hot 0 24  
  -> Redis MGET (hydrate post metadata)  
  -> CDN (media)  
  
**Comment Flow:**  
Client loads post -> Comment Service  
  -> PostgreSQL: top-level comments WHERE post_id = X AND parent_id IS NULL ORDER BY score DESC LIMIT 20  
  -> PostgreSQL: top 3 replies per top-level comment  
  -> Lazy load deeper levels on demand  
  
**Search Flow:**  
Client searches "rust programming" -> Search Service  
  -> Redis (hot query cache)  
  -> Elasticsearch (cache miss)  
  -> Redis MGET (hydrate post metadata for results)

<<<SECTION 9>>>
## 10. Resilience and Fault Tolerance

**Redis Sorted Sets for feeds** mean feed reads never touch the Posts DB in the happy path. If PostgreSQL is slow or temporarily unavailable, users continue seeing their feeds from Redis. New posts stop appearing until the DB recovers, but existing feed content is unaffected.

**Kafka durability** means no vote is ever lost even during traffic spikes. Votes sit in Kafka until the Score Recomputation Worker processes them. A viral post generating 100,000 votes per hour does not overwhelm the system because Kafka absorbs the burst and workers process at their own pace.

**Vote debouncing** prevents the Score Recomputation Worker from being overwhelmed on viral posts. Batching vote events in 5-second windows reduces recomputation overhead by orders of magnitude while keeping scores acceptably fresh.

**Idempotency at two layers** for votes: Redis check on the hot path and a PostgreSQL UNIQUE constraint as a safety net. A user can never vote twice on the same post even under retry conditions or network failures.

**Adjacency List lazy loading** prevents comment fetches from becoming unbounded. Enforcing depth limits and pagination at the API layer protects PostgreSQL from runaway recursive queries.

**Cassandra replication** for any high-volume write stores ensures no data loss under node failures.

**CDN caching** for media means profile photos, post images, and video chunks are served from edge nodes globally with no origin involvement for cache hits.

<<<SECTION 10>>>
## 11. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, routing)

**Blob Storage** -> AWS S3 (Immutable media files, durable, CDN-native)

**CDN** -> CloudFront / Akamai (Edge caching for post media and profile photos)

**Transcoding** -> Horizontally scaled worker pool via Kafka (Image variants, HLS video chunking)

**Decoupling** -> Apache Kafka (Vote durability, post fanout, score recomputation, search indexing)

**Search Engine** -> Elasticsearch (Full-text search, partial matching, score-weighted ranking)

**Posts / Users / Subreddits DB** -> PostgreSQL sharded + replicas (Relational structure, strong consistency, composite indexes)

**Feed Store** -> Redis Sorted Sets per subreddit per sort mode (Sub-millisecond ranked feed reads)

**Vote Counters** -> Redis INCR (Near real-time vote counts without DB pressure)

**Vote Idempotency** -> Redis Set + PostgreSQL UNIQUE constraint (Two-layer duplicate prevention)

**Home Feed Cache** -> Redis Sorted Sets per user (Precomputed home feed for small subreddit fanout)

**Post Metadata Cache** -> Redis MGET (Batch hydration of post metadata in single round trip)

**Comment Storage** -> PostgreSQL Adjacency List (Threaded nested comments, lazy loaded by depth)

**Analytics Store** -> Cassandra / ClickHouse (High write volume, time-series voting data)

That's all, folks...Cheers!!!
