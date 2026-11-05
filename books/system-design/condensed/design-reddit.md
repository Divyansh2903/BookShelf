# Design Reddit

<<<SECTION 1>>>
## High-Level Design: Reddit

## 1. Requirements

**Functional**
- Create posts (text, image, video)
- Upvote/downvote posts and comments
- Threaded nested comments
- Join subreddits, follow users
- Home feed from joined subreddits
- Subreddit feed sorted by Hot, New, Top, Controversial
- Search posts, subreddits, users
- Create a subreddit

**Out of scope:** chat (same WebSocket architecture as Tinder), Awards and coins, moderation tools, Ads.

**Non-functional**
- High availability for feed, voting, media serving
- Feed reads under 100ms
- Votes never lost, even under spikes
- Hotness scores reflect recent activity with time decay
- Eventual consistency OK for vote counts and feed ranking
- Strong consistency for vote idempotency (no double voting on a post)

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 50M
- **Posts/day:** 10M (20% of DAU)
- **Avg post size:** ~2 MB weighted across text (100 KB), images (500 KB-1 MB), videos (up to 10 MB)
- **Post storage:** 10M x 2 MB = 20 TB/day
- **Votes:** 50M x 5 = 250M/day = ~3000/sec at peak, viral spikes far higher
- **Comments:** ~100M/day (2 per DAU)

The dominant write load is votes (3000/sec), not posts, and each vote may trigger a hotness recompute: the primary constraint for voting and feeds. 20 TB/day of media is manageable with S3 and CDN caching.

## 3. API Gateway

Handles auth, rate limiting, and routing. As in every design, it is never in the path of binary media: after auth, uploads go directly client-to-S3 via a presigned URL.

<<<SECTION 3>>>
## 4. Post Service and Upload Pipeline

### Upload flow (media post)

1. Client authenticates via the Gateway and requests a presigned S3 URL from the Post Service.
2. Client uploads media directly to S3.
3. S3 emits an upload event that triggers the Transcoding Service via Kafka.
4. Transcoding:
   - Images: thumbnail, medium, full-res variants; compression and WebP conversion.
   - Videos: 360p, 480p, 720p, 1080p variants; HLS segments for adaptive streaming; thumbnail frame.
5. Variants are written to S3 at `media/{post_id}/{variant}/`.
6. Transcoding publishes `post.transcoded` to Kafka.
7. Two independent consumers: **Metadata Worker** writes to Posts DB and populates the Post Metadata Cache (Redis); **Search Indexing Worker** indexes into Elasticsearch.

Text-only posts skip steps 1-6: the Post Service writes directly to Posts DB and publishes `post.created`.

### Data model (PostgreSQL)

**Posts:** post_id (UUID PK), subreddit_id (UUID FK -> Subreddits), user_id (UUID FK -> Users), title (VARCHAR), content (TEXT, null for media posts), media_url (TEXT, null for text posts), media_type (ENUM 'text', 'image', 'video'), upvotes, downvotes, score (INTEGER), hot_score (FLOAT), posted_at (TIMESTAMP).

upvotes, downvotes, score, and hot_score are denormalized counters maintained async by Kafka consumers, avoiding expensive aggregation at read time.

**Subreddits:** subreddit_id (UUID PK), name (VARCHAR, unique), description (TEXT), member_count (INTEGER), created_by (UUID FK -> Users), created_at (TIMESTAMP).

**SubredditMembers:** user_id (UUID FK -> Users), subreddit_id (UUID FK -> Subreddits), joined_at (TIMESTAMP), PRIMARY KEY (user_id, subreddit_id).

A many-to-many join table: join = INSERT, leave = DELETE; "subreddits user X joined" is `WHERE user_id = X`.

### Bottlenecks

The Post Service is stateless and horizontally scalable. Transcoding is the media bottleneck (multi-quality video is CPU-intensive), handled by a horizontally scalable worker pool pulling jobs from a Kafka topic. Text posts have no bottleneck.

<<<SECTION 4>>>
## 5. Voting Service

The highest-volume write path: 3000 votes/sec average, extreme spikes on viral posts. It must absorb bursts without loss, prevent duplicates, and keep hotness fresh.

**Full vote flow**

1. **Receive:** client sends `POST /votes` with `{ user_id, post_id, direction: 'up' | 'down' }` via the Gateway.
2. **Idempotency check (Redis Set):** `SGET vote:user_123:post_456`. Same direction already voted: ignore. Switching (up to down): compute and process the delta. Done entirely in Redis, no DB on the hot path.
3. **Increment counter in Redis:** `INCR post:post_456:upvotes`. Clients read counts from Redis, not the DB: near real-time counts on viral posts with no DB read pressure.
4. **Publish `vote.created` to Kafka** right after the Redis update, decoupling the hot path and providing durability; slow downstream services lose no votes.
5. **Three independent consumers:**
   - **Vote Persistence Worker:** writes to the Votes table asynchronously, the permanent record.
   - **Score Recomputation Worker:** recomputes hotness, a function of net upvotes and time since creation. Aggressive time decay lets newer posts with fewer upvotes outrank older ones. Writes `ZADD subreddit:programming:hot <new_hot_score> post_456`, so the Hot feed updates instantly with no read-time computation.
   - **Controversial Score Worker:** a post is controversial with high total votes but a nearly equal up/down split. Writes `ZADD subreddit:programming:controversial <controversial_score> post_456`.
6. **Periodic reconciliation:** Redis counters are the fast read path, PostgreSQL the source of truth. A background job reconciles them to catch drift from Redis restarts or missed events.

**Votes table:** vote_id (UUID PK), user_id (UUID FK -> Users), post_id (UUID FK -> Posts), direction (ENUM 'up', 'down'), voted_at (TIMESTAMP), UNIQUE (user_id, post_id). The UNIQUE constraint is a DB-level idempotency safety net behind the Redis check.

**Bottlenecks:** Redis ops are sub-millisecond and handle peak throughput; Kafka absorbs viral bursts. The Score Recomputation Worker can bottleneck if one post gets thousands of votes/sec. Fix: **debounce**, batching events for the same post within a short window (say 5 seconds) and recomputing once per window, cutting overhead by orders of magnitude while keeping scores fresh.

<<<SECTION 5>>>
## 6. Feed Service

Reddit's feed is subreddit-based, not follow-based. A user in 50 subreddits sees the best posts across all 50, ranked by the chosen sort mode.

**Sorted sets per subreddit per sort mode:**
- `subreddit:{subreddit_id}:hot`: hot_score (upvotes + time decay)
- `subreddit:{subreddit_id}:new`: posted_at timestamp
- `subreddit:{subreddit_id}:top`: net upvotes
- `subreddit:{subreddit_id}:controversial`: controversial score

Kafka consumers update these in real time on votes and new posts. In the happy path, feed reads come from Redis, never the Posts DB.

### Fan-out strategy

Hybrid like Instagram, but keyed on subreddit size instead of follower count:

- **Fan-out on write (small subreddits,** below a threshold, say 100,000 members): the Feed Fanout Worker writes the post into every member's home feed sorted set: key `feed:{user_id}:home`, member post_id, score hot_score.
- **Fan-out on read (large subreddits** like r/programming or r/worldnews with millions of members): their subreddit sets are read at request time and merged with the precomputed home feed. A viral r/worldnews post triggers no writes to millions of home feeds.

### Home feed read flow

1. Fetch the user's joined subreddits from the SubredditMembers cache in Redis.
2. Small subreddits: read precomputed `feed:{user_id}:home`.
3. Large subreddits: read top posts from `subreddit:{subreddit_id}:hot`.
4. Merge and re-rank across all subreddits.
5. Return top 25 post IDs.
6. Hydrate via `MGET post:1 post:2 ... post:25`.
7. On a post cache miss, fall back to Posts DB and write back to Redis.
8. Client renders with full metadata; media URLs point to the CDN.

### Subreddit feed read flow

1. Read `subreddit:{subreddit_id}:{sort_mode}`.
2. `ZREVRANGE subreddit:programming:hot 0 24` returns the top 25 IDs instantly.
3. Hydrate via Redis MGET.
4. Media via CDN.

**Bottlenecks:** read-time merging adds latency proportional to the number of large subreddits followed. Mitigated by capping large-subreddit reads per request and caching the merged result per user in Redis with a short TTL (30-60 seconds). Home feed sets of inactive users are evicted and rebuilt from Posts DB on next login.

<<<SECTION 6>>>
## 7. Comment Service

Threaded comments nest to arbitrary depth, and each has its own vote score: Reddit's most distinctive data structure challenge.

**Adjacency List model (PostgreSQL):** each comment references its parent.

**Comments:** comment_id (UUID PK), post_id (UUID FK -> Posts), parent_id (UUID FK -> Comments, NULL for top-level), user_id (UUID FK -> Users), content (TEXT), upvotes, downvotes, score (INTEGER), created_at (TIMESTAMP).

NULL parent_id = direct reply to the post; non-null = reply to a comment. This one column captures the whole tree without a graph database. A composite index on (post_id, parent_id) makes the two main queries fast:

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

### Lazy loading

A popular post may have hundreds of thousands of comments, so the tree is never loaded in one request:
1. Fetch the top 20 top-level comments by score.
2. Fetch the top 3 replies for each.
3. Deeper levels show "load more replies", triggering a separate request.

Initial load stays fast regardless of depth.

**Comment votes** use the same Kafka pipeline as post votes; the Score Recomputation Worker maintains each comment's score, and thread order is recomputed async after each vote batch. Hot comments for popular posts are cached in Redis with a short TTL to avoid repeat PostgreSQL queries.

**Bottlenecks:** the Adjacency List suits one-level-at-a-time fetching; the risk is deep recursive fetches of the full tree in one shot, prevented by pagination and depth limits at the API layer. PostgreSQL handles comment write volume comfortably since comments are far rarer than votes.

<<<SECTION 7>>>
## 8. Search Service

Covers posts (title, content), subreddits (name, description), and users (username).

### Storage Engine - Elasticsearch

Handles full-text search, partial matching, and relevance ranking for all three. Reddit search is mainly keyword-based, not engagement-weighted like Instagram, but subreddit size and post score are still ranking signals.

**Post document:**

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

**Subreddit document:**

```
{
  "subreddit_id": "456",
  "name": "programming",
  "description": "Computer programming discussion",
  "member_count": 5000000
}
```

For the same query, a highly upvoted post in a large subreddit outranks a low-score post in a tiny one.

**Sync:** the Search Indexing Worker consumes `post.transcoded` and `post.created` for new posts. Score updates are batched and synced periodically, not per vote, since search scores needn't be real-time. Hot queries are cached in Redis with a short TTL.

**Bottlenecks:** same as Instagram and Spotify. Redis caching filters most repeat traffic; horizontal Elasticsearch scaling handles the rest.

<<<SECTION 8>>>
## 9. Full Data Flow Summary

**Post upload:**
- Client -> Gateway (auth) -> Post Service -> presigned S3 URL; Client -> S3 (direct upload)
- S3 -> Kafka -> Transcoding Service -> S3 (all variants) -> Kafka (`post.transcoded`), consumed by:
  - Metadata Worker -> Posts DB + Redis cache
  - Search Worker -> Elasticsearch
  - Feed Fanout Worker -> Redis home feed sets (small subreddits) and subreddit sets (all subreddits)

**Vote:** Client upvote -> Vote Service -> Redis idempotency check (`SGET vote:user:post`) -> Redis `INCR post:post_id:upvotes` -> Kafka (`vote.created`), consumed by:
- Vote Persistence Worker -> PostgreSQL Votes table
- Score Recomputation Worker -> `ZADD subreddit:id:hot <new_score> post_id`
- Controversial Score Worker -> `ZADD subreddit:id:controversial <score> post_id`

**Home feed:** Feed Service -> Redis joined subreddits -> `ZREVRANGE feed:{user_id}:home` (small subreddits) -> `ZREVRANGE subreddit:{id}:hot` (large, merged at read time) -> `MGET post:1 ... post:25` -> CDN for media.

**Subreddit feed:** open r/programming -> Feed Service -> `ZREVRANGE subreddit:programming:hot 0 24` -> Redis MGET -> CDN.

**Comments:** Comment Service -> PostgreSQL top-level (`WHERE post_id = X AND parent_id IS NULL ORDER BY score DESC LIMIT 20`) -> top 3 replies each -> lazy load deeper levels on demand.

**Search:** "rust programming" -> Search Service -> Redis hot query cache -> Elasticsearch on miss -> Redis MGET to hydrate results.

<<<SECTION 9>>>
## 10. Resilience and Fault Tolerance

- **Redis sorted sets for feeds:** reads skip the Posts DB in the happy path. If PostgreSQL is slow or down, feeds still load from Redis; only new posts stop appearing until it recovers.
- **Kafka durability:** no vote is lost in spikes. Votes wait in Kafka; a viral post with 100,000 votes/hour is absorbed and workers process at their own pace.
- **Vote debouncing:** 5-second batching cuts recomputation by orders of magnitude while keeping scores acceptably fresh.
- **Two-layer vote idempotency:** Redis check on the hot path plus PostgreSQL UNIQUE constraint; no double votes even under retries or network failures.
- **Adjacency List lazy loading:** depth limits and pagination at the API layer keep comment fetches bounded and protect PostgreSQL from runaway recursive queries.
- **Cassandra replication** for high-volume write stores prevents data loss on node failures.
- **CDN caching:** profile photos, post images, and video chunks are served from global edge nodes with no origin involvement on hits.

<<<SECTION 10>>>
## 11. Technology Choices Summary

- **API Gateway:** Kong / AWS API Gateway (auth, rate limiting, routing)
- **Blob Storage:** AWS S3 (immutable media, durable, CDN-native)
- **CDN:** CloudFront / Akamai (edge caching for post media, profile photos)
- **Transcoding:** horizontally scaled worker pool via Kafka (image variants, HLS chunking)
- **Decoupling:** Apache Kafka (vote durability, post fanout, score recomputation, search indexing)
- **Search:** Elasticsearch (full-text, partial matching, score-weighted ranking)
- **Posts / Users / Subreddits DB:** PostgreSQL sharded + replicas (relational, strong consistency, composite indexes)
- **Feed Store:** Redis sorted sets per subreddit per sort mode (sub-millisecond ranked reads)
- **Vote Counters:** Redis INCR (near real-time counts, no DB pressure)
- **Vote Idempotency:** Redis Set + PostgreSQL UNIQUE (two-layer duplicate prevention)
- **Home Feed Cache:** Redis sorted sets per user (precomputed for small-subreddit fanout)
- **Post Metadata Cache:** Redis MGET (batch hydration in one round trip)
- **Comment Storage:** PostgreSQL Adjacency List (threaded comments, lazy loaded by depth)
- **Analytics Store:** Cassandra / ClickHouse (high write volume, time-series voting data)
