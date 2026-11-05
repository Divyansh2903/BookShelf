# Design Medium

<<<SECTION 1>>>
## 1. Requirements

**Functional**
- Writer and reader profile management
- Create, edit, publish, delete articles (rich text, embedded images, code blocks)
- Draft management with autosave
- Claps (up to 50 per user per article)
- Threaded comments
- Follow/unfollow writers
- Home feed (followed writers + topic-based recommendations)
- Tags and topics per article
- Search for articles, writers, topics
- Reading time estimation
- Notifications (new article from followed writer, clap, comment, new follower)

**Out of scope:** premium membership and paywalls; Partner Program (writer earnings); reposts; Publications (multi-writer blogs); audio narration.

**Non-functional**
- High availability for article reading (most frequent operation)
- Feed reads under 100ms
- Autosave feels instantaneous, no perceptible write latency
- Eventual consistency OK for clap counts, feed ranking, recommendations
- Strong consistency for publish state (draft vs published)
- Read/write ratio ~1000:1, heavily read-optimized
- Never show an already-read article in the feed

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 1 million
- **Articles/day:** 1-5% of DAU = ~10,000
- **Text per article:** ~50 KB → 10,000 × 50 KB = ~500 MB/day (negligible)
- **Images:** ~50% of articles have 2 images at 500 KB → 10,000 × 0.5 × 2 × 500 KB = ~5 GB/day
- **Total storage:** ~5 GB/day, dominated by images
- **Active drafts:** ~10x published = ~100,000 being edited
- **Autosave writes:** 100,000 drafts × 1 save per 5 seconds = ~20,000 writes/second at peak writing hours
- **Read/write:** ~1000:1; a viral article is read tens of thousands of times after one write

The main challenge is autosave write volume and feed personalization quality, not storage. Medium is as much a discovery platform as a publishing one; the feed determines whether readers return daily.

<<<SECTION 3>>>
## 3. API Gateway

Handles authentication, rate limiting, routing. Article image uploads bypass it after authentication via presigned S3 URLs; it never carries binary media.

Medium has significant unauthenticated reads (readers from Google or shared links). The Gateway routes unauthenticated article reads straight to the Article Read path without auth overhead; writes (clap, comment, follow, publish) always require authentication.

## 4. User Profile Service

Two overlapping user types: writers and readers; most users are both.

### Data Model

**Users (PostgreSQL):** user_id UUID PK; username VARCHAR unique; email VARCHAR unique; display_name VARCHAR; bio TEXT; profile_pic_url TEXT; website_url TEXT; twitter_handle VARCHAR; follower_count, following_count, article_count, total_claps_received INTEGER; created_at TIMESTAMP.

The four counters are denormalized and updated asynchronously by Kafka consumers; aggregating raw tables at read time would be too slow at scale.

**Follows (PostgreSQL):** follower_id UUID FK -> Users; followee_id UUID FK -> Users; created_at TIMESTAMP; PRIMARY KEY (follower_id, followee_id).

Follow = INSERT, unfollow = DELETE. "Writers X follows" = WHERE follower_id = X. Indexed on both columns for lookups in both directions.

**UserTopics (PostgreSQL):** user_id UUID FK -> Users; topic VARCHAR; interest_score FLOAT (updated by recommendation pipeline); created_at TIMESTAMP; PRIMARY KEY (user_id, topic).

Holds both explicit interests (user follows a topic) and inferred ones (from reading behavior). The ML pipeline periodically updates interest_score from reading history signals.

**Caching:** writer profiles are cached in Redis (fetched on every article view); hot writers whose articles appear in many feeds benefit most. Per-user topic interest scores are cached for fast feed assembly.

<<<SECTION 4>>>
## 5. Post Service

Manages the article lifecycle: draft, edit, publish, delete.

### Article Storage Architecture

Articles are rich documents (headings, paragraphs, images, code blocks, pull quotes, embedded links), stored as **JSON documents in MongoDB**, not raw text in PostgreSQL. MongoDB because:

- Flexible schema per article (different block structures)
- Efficient storage/retrieval of large nested JSON
- No complex joins needed on content
- Native partial document updates (edit one section without rewriting the whole document)

PostgreSQL holds metadata (title, slug, status, author, clap count); MongoDB holds the full content; S3 holds embedded images.

**Article content structure (MongoDB)**

```json
{
  "article_id": "uuid",
  "blocks": [
    { "type": "heading", "level": 1, "text": "Why I Switched to Rust" },
    { "type": "paragraph", "text": "It started on a Tuesday morning..." },
    { "type": "image", "url": "https://cdn.medium.com/...", "caption": "My workspace" },
    { "type": "code", "language": "rust", "content": "fn main() { ... }" },
    { "type": "paragraph", "text": "The borrow checker felt restrictive at first..." }
  ],
  "updated_at": "2026-06-20T10:00:00Z"
}
```

This block-based format resembles how Notion, Substack, and Medium's own editor represent rich content.

**Articles metadata (PostgreSQL):** article_id UUID PK; author_id UUID FK -> Users; title VARCHAR; subtitle VARCHAR; cover_image_url TEXT; slug VARCHAR unique (null until published); status ENUM('draft', 'published', 'deleted'); reading_time INTEGER (minutes, computed on publish); clap_count INTEGER (denormalized total); comment_count INTEGER (denormalized); view_count INTEGER (denormalized); published_at TIMESTAMP (null until published); created_at, updated_at TIMESTAMP.

**ArticleTags (PostgreSQL):** article_id UUID FK -> Articles; tag VARCHAR; PRIMARY KEY (article_id, tag).

Tags are set by the writer; topics are broader categories, inferred or manually selected. Both are indexed in Elasticsearch for search and used by the recommendation pipeline for topic-based feeds.

### Draft Autosave Flow

Autosave every few seconds across 100,000 active drafts (every 5 seconds) is ~20,000 writes/second at peak; writing each directly to MongoDB would overwhelm it. Redis acts as a **write buffer**:

1. Client debounces keystrokes and sends an autosave every 3-5 seconds.
2. Post Service writes the draft to Redis immediately (Key: draft:{article_id}; Value: serialized article content JSON; TTL: 7 days).
3. Response returns instantly (sub-millisecond Redis write).
4. draft.updated event published to Kafka.
5. A Kafka consumer flushes the draft from Redis to MongoDB asynchronously every 30 seconds per draft.

The writer never waits for MongoDB; it receives batched updates at a sustainable rate. On a cache miss (draft evicted, writer returns after 7 days), the draft is loaded from MongoDB back into Redis.

### Publish Flow

1. Read final draft from Redis (MongoDB on miss).
2. Generate a unique slug from the title (e.g. "why-i-switched-to-rust-a1b2c3").
3. Compute reading time: word_count / 200 (average adult reading speed, wpm).
4. Update Articles: status = 'published', slug = generated_slug, published_at = NOW().
5. Write final content to MongoDB (permanent published version).
6. Publish article.published to Kafka.
7. Consumers: **Search Indexing Worker** indexes into Elasticsearch; **Feed Fanout Worker** writes into followers' feed sorted sets; **Notification Worker** notifies all followers; **Topic Index Worker** updates topic sorted sets in Redis.

### Image Upload Flow

1. Client gets a presigned S3 URL from the Post Service.
2. Client uploads directly to S3.
3. Image Processing Worker generates variants: thumbnail (feed cards), medium (article body), full (expanded view).
4. CDN in front of S3 serves images globally with high hit rates.

**Bottlenecks:** the Redis autosave buffer is the key decision protecting MongoDB. Publishing is low volume (10,000/day). Image processing follows the same pattern as previous systems and scales horizontally via Kafka workers.

<<<SECTION 5>>>
## 6. Feed Service

The feed blends articles from followed writers with topic-based recommendations: more complex than Twitter's follow-only feed, simpler than Netflix's multi-stage pipeline.

### Fan-out on Write for All Users

Instagram and Twitter need fan-out on read for celebrities with millions of followers, but Medium's largest writers have at most a few hundred thousand, so fan-out on write works for everyone; no hybrid needed.

On publish, the Feed Fanout Worker writes the article into every follower's sorted set: Key: feed:{user_id}; Member: article_id; Score: weighted relevance (recency + follow boost + engagement signals); TTL: 7 days.

**Score = base_engagement_score + follow_boost + recency_decay**

- base_engagement_score: engagement (claps, comments, reads) since publishing
- follow_boost: added for followed writers; prioritizes but doesn't fully dominate
- recency_decay: newer articles outscore older ones with equal engagement, so stale content doesn't stay on top

The feed is thus a blend, not a strict ordering: a fresh, relevant topic recommendation can outrank a stale followed-writer article, matching Medium's actual behavior.

### Topic-Based Recommendations

A periodic pipeline computes per-user recommendations from:

- **Reading history:** topics of articles read to completion (high completion_pct) weigh more than bounced ones
- **Collaborative filtering:** users who read the same articles also read Y
- **Topic graph:** adjacent topics (self-help and poetry share readers; backend engineering and system design share readers)
- **Followed writer topics:** infer interest from followed writers' topics

Top picks go to Redis per user: Key: recommendations:{user_id}; Value: [article_id_1, article_id_2, ..., article_id_20]; TTL: 6 hours.

At feed time, the Feed Service merges the follow feed sorted set with these recommendations, applies weighted scoring, and returns the top 20 article IDs.

### Already-Read Exclusion with Bloom Filter

The Reading History Service keeps a Bloom Filter per user:

- BF.ADD seen:{user_id} article_id (when the user opens an article)
- BF.EXISTS seen:{user_id} article_id (before inserting into the feed sorted set)

BF.EXISTS is checked before any article is added to a feed or returned as a recommendation; read articles are excluded. No false negatives, so a read article never reappears; the small false positive rate (occasionally excluding an unread article) is acceptable.

### Feed Read Flow

1. Fetch top 50 IDs: ZREVRANGE feed:user_123 0 49
2. Merge with recommendations:{user_id}
3. Apply Bloom Filter exclusion
4. Re-rank by weighted score
5. Hydrate top 20 via Redis MGET (title, subtitle, cover image, author, reading time, clap count)
6. On cache miss, fall back to PostgreSQL and write back to Redis
7. Return feed cards

**Bottlenecks:** a top writer with 100,000 followers means 100,000 sorted set writes per publish. At 10,000 articles/day averaging 500 followers, that's 5 million sorted set writes/day, manageable with a horizontally scaled Fanout Worker pool. Feed memory is capped by the 7-day TTL and a max of 200 articles per feed sorted set.

<<<SECTION 6>>>
## 7. Clap Service

A reader can clap up to 50 times per article. The displayed total is the SUM of all readers' clap counts, not the count of unique clappers.

### Redis Structure

**Per-user count (cap enforcement):** Key: claps:{article_id}:{user_id}; Value: integer (1 to 50); TTL: 30 days. Before a clap: GET claps:{article_id}:{user_id}; if 50, reject; otherwise INCR claps:{article_id}:{user_id}.

**Article total (display):** Key: article:claps:{article_id}; Value: running total. Every clap passing the cap also does INCR article:claps:{article_id}. Display is a single GET article:claps:{article_id}; no SUM at read time.

### Full Clap Flow

1. User taps clap (possibly rapidly, many times).
2. Client debounces and batches, sending the accumulated count every 1 second.
3. Clap Service receives { user_id, article_id, clap_increment }.
4. GET claps:{article_id}:{user_id} -> current count.
5. Allowed increment = min(clap_increment, 50 - current_count).
6. If > 0: INCRBY claps:{article_id}:{user_id} allowed_increment; INCRBY article:claps:{article_id} allowed_increment; publish clap.created to Kafka.
7. Consumers: **Clap Persistence Worker** upserts the Claps Table in PostgreSQL; **Counter Sync Worker** periodically syncs the Redis total to Articles.clap_count; **Notification Worker** notifies the author (coalesced, not one per clap).

**Claps (PostgreSQL):** user_id UUID FK -> Users; article_id UUID FK -> Articles; clap_count INTEGER (1 to 50); last_clapped TIMESTAMP; PRIMARY KEY (user_id, article_id).

An UPSERT on (user_id, article_id) with clap_count = clap_count + allowed_increment handles first and later claps in one operation.

**Bottlenecks:** clap bursts on viral articles (thousands clapping at once) are absorbed by atomic, sub-millisecond Redis INCRBY. Kafka handles async persistence with no write pressure on PostgreSQL during the burst. Periodic reconciliation between Redis totals and PostgreSQL clap_count catches drift.

<<<SECTION 7>>>
## 8. Comment Service

Comments are threaded but shallower than Reddit; Medium favors responses (separate articles written as replies). Volume is low compared to claps.

**Comments (PostgreSQL):** comment_id UUID PK; article_id UUID FK -> Articles; parent_id UUID FK -> Comments (null for top-level); user_id UUID FK -> Users; content TEXT; clap_count INTEGER; created_at, updated_at TIMESTAMP.

Same **adjacency list** pattern as Reddit: parent_id NULL = top-level comment; non-null = reply. Top-level comments are sorted by clap count (most appreciated first); replies chronologically within a thread.

A composite index on (article_id, parent_id) makes both queries fast:
- Top-level: WHERE article_id = X AND parent_id IS NULL ORDER BY clap_count DESC LIMIT 20
- Replies: WHERE parent_id = comment_123 ORDER BY created_at ASC

Hot comment sections are cached in Redis with a short TTL; the daily most-read articles benefit most.

**Bottlenecks:** PostgreSQL handles the low comment write volume comfortably. The concern is thousands of simultaneous reads on viral articles' comments, absorbed by Redis caching of top-level comments.

<<<SECTION 8>>>
## 9. Search Service

Covers articles (title, content, tags), writers (name, username), and topics.

**Elasticsearch** handles full-text search, partial matching, and relevance ranking. Search is mainly keyword and topic-based rather than engagement-weighted like Instagram, though clap count and read count are ranking signals.

### Article document:

```json
{
  "article_id": "123",
  "title": "Why I Switched to Rust After 10 Years of Python",
  "subtitle": "A pragmatic engineer's perspective",
  "author_id": "456",
  "author_name": "harry_dev",
  "tags": ["rust", "python", "programming", "backend"],
  "content_preview": "It started on a Tuesday morning when my service crashed for the third time...",
  "reading_time": 8,
  "clap_count": 4200,
  "view_count": 18000,
  "published_at": "2026-06-20T10:00:00Z"
}
```

Full content is not indexed, only a preview (first 500 characters) and tags. Full-content search would make the index enormous, and most intent is satisfied by title, tags, and preview.

### Writer document:

```json
{
  "user_id": "456",
  "username": "harry_dev",
  "display_name": "Harry Singh",
  "bio": "Backend engineer. Writing about distributed systems and Rust.",
  "follower_count": 12000,
  "article_count": 47
}
```

**Ranking signals:**
- Text match score (title > tag > preview)
- Clap count (more appreciated ranks higher for the same query)
- Recency (boost for broad queries)
- Author follower count (established writers slightly higher)

**Sync:** the Search Indexing Worker consumes article.published and article.updated. Clap and view counts are batched and synced periodically, not per clap, since search engagement counts needn't be real-time.

<<<SECTION 9>>>
## 10. Reading History Service

Tracks which articles each user read and how deeply. Feeds the recommendation pipeline and the feed-deduplication Bloom Filter.

**ReadingHistory (PostgreSQL, partitioned by user_id):** user_id UUID FK -> Users; article_id UUID FK -> Articles; read_at TIMESTAMP; completion_pct FLOAT (0.0 to 1.0, how far the user scrolled); time_spent_sec INTEGER (actual reading time in seconds).

**completion_pct** is the most valuable signal: reading 95% of an 8-minute Rust article shows far more interest than opening and bouncing. It drives topic interest scoring.

### Write Flow

1 million DAU × 5 articles/day = 5 million read events/day. Writes are high volume and must not block reading, so events go to Kafka asynchronously:

1. User opens article -> client sends GET /articles/{slug} -> article served.
2. Client tracks scroll position and time spent in the background.
3. On close or after 30 seconds: client sends { user_id, article_id, completion_pct, time_spent_sec }.
4. Reading History Service publishes article.read to Kafka.
5. Consumers: **History Persistence Worker** writes ReadingHistory; **Bloom Filter Worker** runs BF.ADD seen:{user_id} article_id; **View Counter Worker** runs INCR article:views:{article_id} in Redis; **Recommendation Signal Worker** updates UserTopics interest scores from completion_pct.

**Bottlenecks:** 5 million events/day ≈ 58/second on average, well within Kafka capacity. Bloom Filter writes are sub-millisecond. Partitioning by user_id keeps per-user history queries fast.

<<<SECTION 10>>>
## 11. Notification Service

Same architecture as previous systems: Kafka fanout from interaction services; APNs (iOS), FCM (Android), email via SES.

Subscriptions:
- article.published -> "Harry published a new article" to all followers
- clap.created -> coalesced notice to the author ("Harry and 42 others clapped for your article")
- comment.created -> to the article author and parent comment author
- follow.created -> "Someone followed you"

**Coalescing:** clap notifications are coalesced aggressively. A viral article with 5,000 claps in an hour shouldn't send 5,000 pushes; claps are batched in a 1-hour window into one notice: "Your article received 5,247 claps in the last hour." New-article notifications are sent individually, since each is a distinct content event readers want.

<<<SECTION 11>>>
## 12. Full Data Flow Summary

**Draft creation:** writer types -> client debounces -> autosave every 3-5 seconds -> Post Service -> Redis WRITE draft:{article_id} (sub-millisecond) -> Kafka (draft.updated) -> MongoDB Writer (async, flushes every 30 seconds per draft).

**Image upload:** writer inserts image -> Post Service -> presigned S3 URL; writer -> S3 (direct); S3 -> Kafka -> Image Processing Worker -> S3 (thumbnail, medium, full); CDN caches all variants.

**Publish:** writer clicks Publish -> Post Service -> generate slug, compute reading_time -> UPDATE Articles: status = 'published', published_at = NOW() -> write final content to MongoDB -> Kafka (article.published):
- Search Worker -> Elasticsearch index
- Feed Fanout Worker -> Redis ZADD feed:{follower_id} for all followers
- Notification Worker -> APNs / FCM / SES to all followers
- Topic Index Worker -> Redis topic sorted sets updated

**Feed read:** user opens Medium -> Feed Service -> Redis ZREVRANGE feed:{user_id} 0 49 (follow-based) -> Redis GET recommendations:{user_id} (topic-based) -> BF.EXISTS seen:{user_id} per candidate (exclude read) -> weighted merge and re-rank -> Redis MGET (hydrate top 20) -> CDN (cover images).

**Article read:** user opens article -> Post Service -> Redis (metadata cache) -> MongoDB (full content) -> CDN (embedded images) -> client tracks scroll + time -> on close, article.read to Kafka:
- History Persistence Worker -> ReadingHistory Table (PostgreSQL)
- Bloom Filter Worker -> BF.ADD seen:{user_id} article_id
- View Counter Worker -> INCR article:views:{article_id}
- Recommendation Signal Worker -> UPDATE UserTopics interest scores

**Clap:** user claps -> client debounces and batches -> Clap Service -> GET claps:{article_id}:{user_id} -> compute allowed increment (cap 50) -> INCRBY claps:{article_id}:{user_id} allowed_increment -> INCRBY article:claps:{article_id} allowed_increment -> Kafka (clap.created):
- Clap Persistence Worker -> UPSERT Claps Table (PostgreSQL)
- Counter Sync Worker -> UPDATE Articles.clap_count (periodic batch)
- Notification Worker -> coalesced clap notification to author

**Search:** user searches "rust backend" -> Search Service -> Redis (hot query cache) -> Elasticsearch (title + tag + preview match, ranked by claps + recency) -> Redis MGET (hydrate results).

<<<SECTION 12>>>
## 13. Resilience and Fault Tolerance

- **Redis autosave buffer:** writers never lose work if MongoDB is down; drafts survive in Redis (7-day TTL) and the Kafka consumer catches up when MongoDB recovers.
- **Bloom Filter deduplication:** no false negatives, so read articles never reappear; the small false positive rate goes unnoticed.
- **Fan-out on write:** feed reads stay fast regardless of DB health; Redis sorted sets are the primary read path, PostgreSQL hit only on full cache misses.
- **Kafka durability:** no publish, clap, or read event is lost if downstream is down; consumers catch up from offsets.
- **Redis clap counters with async PostgreSQL sync:** absorb viral clap bursts without DB write pressure; periodic reconciliation fixes drift.
- **MongoDB for content:** decouples content from metadata; a MongoDB slowdown affects article body reads but not feeds, search, or profiles (PostgreSQL and Redis).
- **CDN caching:** article images served from global edges; images rarely change after publishing, so hit rates are very high.
- **Elasticsearch eventual consistency:** a new article may be missing from search for a few seconds while the worker processes the event; acceptable, since readers find new articles mainly via the feed.

<<<SECTION 13>>>
## 14. Technology Choices Summary

- **API Gateway** -> Kong / AWS API Gateway (auth, rate limiting, unauthenticated read routing)
- **Article Content Store** -> MongoDB (rich text JSON, flexible schema, large nested content)
- **Article Metadata DB** -> PostgreSQL sharded + replicas (title, slug, status, counters; strong consistency for publish state)
- **Draft Autosave Buffer** -> Redis (sub-millisecond writes, 7-day TTL, async flush to MongoDB via Kafka)
- **Image Storage** -> AWS S3 (embedded images, durable, CDN-native)
- **CDN** -> CloudFront / Akamai (edge caching for images, high hit rate)
- **Decoupling** -> Apache Kafka (publish fanout, clap persistence, read events, notification triggers)
- **Search Engine** -> Elasticsearch (full-text on title, tags, preview; clap-weighted ranking)
- **Feed Store** -> Redis Sorted Sets per user (weighted merge of follow and topic articles)
- **Topic Recommendations** -> Redis per user (precomputed, 6-hour TTL)
- **Read Deduplication** -> Redis Bloom Filter per user (already-read exclusion)
- **Clap Counter (per-user cap)** -> Redis INCRBY with GET cap check (atomic 50-clap limit)
- **Clap Counter (article total)** -> Redis INCRBY (running total, single GET for display)
- **Claps DB** -> PostgreSQL UPSERT (source of truth for per-user claps)
- **Reading History DB** -> PostgreSQL partitioned by user_id (completion rate, time spent, recommendation signals)
- **User Profile Cache** -> Redis (writer profiles, follower counts, topic interest scores)
- **Notification Delivery** -> APNs + FCM + AWS SES (push and email, aggressive clap coalescing)
