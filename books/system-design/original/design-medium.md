# Design Medium

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

- Writer and reader profile management
- Create, edit, publish, and delete articles (rich text, embedded images, code blocks)
- Draft management with autosave
- Clap on articles (up to 50 claps per user per article)
- Threaded comments on articles
- Follow and unfollow writers
- Home feed (followed writers + topic-based recommendations)
- Tags and topics per article
- Search for articles, writers, and topics
- Reading time estimation
- Notifications (new article from followed writer, clap, comment, new follower)

### Out of Scope

- Premium membership and paywalled articles
- Medium Partner Program (writer earnings)
- Repost feature
- Publications (multi-writer managed blogs)
- Audio narration of articles

### Non-Functional Requirements

- High availability for article reading, the most frequent operation
- Low latency feed reads under 100ms
- Autosave must feel instantaneous, no perceptible write latency for writers
- Eventual consistency acceptable for clap counts, feed ranking, and recommendations
- Strong consistency required for article publish state (draft vs published)
- Read/write ratio of approximately 1000:1, heavily optimized for reads
- A user must never see an article they have already read in their feed

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 1 million
- **Articles published per day:** 1-5% of DAU = ~10,000 articles per day
- **Text content per article:** ~50 KB
- **Images per article:** ~50% of articles have 2 images at 500 KB each
- **Text storage per day:** 10,000 x 50 KB = ~500 MB/day (negligible)
- **Image storage per day:** 10,000 x 0.5 x 2 x 500 KB = ~5 GB/day
- **Total storage per day:** ~5 GB/day, dominated by images
- **Active drafts at any time:** ~10x published articles = ~100,000 drafts being edited
- **Autosave writes:** 100,000 active drafts x 1 autosave per 5 seconds = ~20,000 writes/second during peak writing hours
- **Read/write ratio:** ~1000:1, a viral article is read tens of thousands of times after being written once

The dominant challenge is not storage scale but autosave write volume and feed personalization quality. Medium is a content discovery platform as much as a publishing platform, and the feed experience determines whether readers return daily.

<<<SECTION 3>>>
## 3. API Gateway

All client requests enter through the API Gateway which handles authentication, rate limiting, and routing. Media uploads (article images) bypass the Gateway after authentication using presigned S3 URLs for direct client-to-S3 upload. The API Gateway never handles binary media payloads.

Medium has a meaningful unauthenticated read traffic pattern. Many readers arrive via Google search or shared links without being logged in. The API Gateway routes unauthenticated article reads directly to the Article Read path without authentication overhead, while write operations (clap, comment, follow, publish) always require authentication.

## 4. User Profile Service

Medium has two overlapping user types: writers who publish content and readers who consume it. Most users are both simultaneously.

### Data Model

### Users Table (PostgreSQL)

Users  
user_id             UUID, primary key  
username            VARCHAR, unique  
email               VARCHAR, unique  
display_name        VARCHAR  
bio                 TEXT  
profile_pic_url     TEXT  
website_url         TEXT  
twitter_handle      VARCHAR  
follower_count      INTEGER  
following_count     INTEGER  
article_count       INTEGER  
total_claps_received INTEGER  
created_at          TIMESTAMP

follower_count, following_count, article_count, and total_claps_received are denormalized counters updated asynchronously via Kafka consumers. Aggregating these at read time from raw tables would be too slow at scale.

### Follows Table (PostgreSQL)

Follows  
follower_id     UUID, foreign key -> Users  
followee_id     UUID, foreign key -> Users  
created_at      TIMESTAMP  
PRIMARY KEY (follower_id, followee_id)

A follow is an INSERT, an unfollow is a DELETE. "Give me all writers user X follows" is WHERE follower_id = X. Indexed on both columns for fast lookups in both directions.

### UserTopics Table (PostgreSQL)

UserTopics  
user_id     UUID, foreign key -> Users  
topic       VARCHAR  
interest_score FLOAT (updated by recommendation pipeline)  
created_at  TIMESTAMP  
PRIMARY KEY (user_id, topic)

Explicit topic interests (user manually follows a topic) and inferred interests (derived from reading behavior by the recommendation pipeline) both live here. The interest_score is updated periodically by the ML pipeline based on reading history signals.

### Caching Strategy

Writer profiles are cached in Redis since they are fetched on every article page view. Hot writers (those with many followers whose articles appear in many feeds) benefit most from caching. User topic interest scores are cached per user for fast feed assembly.

<<<SECTION 4>>>
## 5. Post Service

The Post Service manages the full article lifecycle from draft creation through editing, publishing, and deletion.

### Article Storage Architecture

Medium articles are not simple text strings. They are rich documents with headings, paragraphs, images, code blocks, pull quotes, and embedded links. This structure is stored as a **JSON document** in MongoDB, not as raw text in PostgreSQL.

MongoDB is chosen over PostgreSQL for article content because:

- Flexible schema per article (different articles have different block structures)
- Efficient storage and retrieval of large nested JSON documents
- No need for complex joins on article content
- Native support for partial document updates (editing one section without rewriting the entire document)

PostgreSQL stores article metadata (title, slug, status, author, clap count). MongoDB stores article content (the full rich text document). S3 stores embedded images referenced within the article.

Article Content Structure (MongoDB)

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

This block-based structure is similar to how Notion, Substack, and Medium's own editor (backed by a similar format) represent rich content.

### Articles Metadata Table (PostgreSQL)

**Articles**  
article_id        UUID, primary key  
author_id         UUID, foreign key -> Users  
title             VARCHAR  
subtitle          VARCHAR  
cover_image_url   TEXT  
slug              VARCHAR, unique (null until published)  
status            ENUM('draft', 'published', 'deleted')  
reading_time      INTEGER (minutes, computed on publish)  
clap_count        INTEGER (denormalized total)  
comment_count     INTEGER (denormalized counter)  
view_count        INTEGER (denormalized counter)  
published_at      TIMESTAMP (null until published)  
created_at        TIMESTAMP  
updated_at        TIMESTAMP

Tags and Topics

### ArticleTags Table (PostgreSQL)

ArticleTags  
article_id    UUID, foreign key -> Articles  
tag           VARCHAR  
PRIMARY KEY (article_id, tag)

Tags are set by the writer. Topics are broader categories inferred or manually selected. Both are indexed in Elasticsearch for search and used by the recommendation pipeline for topic-based feed personalization.

### Draft Autosave Flow

Medium autosaves every few seconds while a writer is typing. At 100,000 active drafts with saves every 5 seconds, this is ~20,000 writes per second during peak hours. Writing every autosave directly to MongoDB would overwhelm the database.

### The autosave flow uses Redis as a write buffer:

1. Writer types, client debounces keystrokes and sends autosave request every 3-5 seconds
1. Post Service writes draft content to Redis immediately:

Key: draft:{article_id}  
   Value: serialized article content JSON  
   TTL: 7 days

1. Response returned to client instantly (sub-millisecond Redis write)
1. Autosave event published to Kafka: draft.updated
1. Kafka consumer flushes draft content from Redis to MongoDB asynchronously every 30 seconds per draft

The writer never waits for MongoDB. Redis absorbs all autosave writes. MongoDB receives batched updates at a sustainable rate.

On cache miss (Redis evicted the draft, writer returns after 7 days), the draft is fetched from MongoDB and re-populated in Redis.

### Publish Flow

When a writer clicks Publish:

1. Post Service reads final draft content from Redis (or MongoDB on cache miss)
1. Generates unique URL slug from title (e.g. "why-i-switched-to-rust-a1b2c3")
1. Computes reading time: word_count / 200 (average adult reading speed in wpm)
1. Updates Articles Table: status = 'published', slug = generated_slug, published_at = NOW()
1. Writes final content to MongoDB (permanent published version)
1. Publishes article.published event to Kafka
1. Kafka consumers:**Search Indexing Worker** indexes article into Elasticsearch  
**Feed Fanout Worker** writes article into followers' feed sorted sets  
**Notification Worker** notifies all followers of new article  
**Topic Index Worker** updates topic sorted sets in Redis with new article

### Image Upload Flow

### When a writer inserts an image into the editor:

1. Client requests presigned S3 URL from Post Service
1. Client uploads image directly to S3
1. Image Processing Worker generates multiple resolution variants (thumbnail for feed cards, medium for article body, full for expanded view)
1. CDN sits in front of S3, serving images globally with high cache hit rates

### Bottlenecks in the Post Service

The autosave Redis write buffer is the key architectural decision that prevents MongoDB from being overwhelmed. The publish flow is low volume (10,000 per day) and has no bottleneck concerns. The image processing pipeline is the same pattern as all previous systems and scales horizontally via Kafka workers.

<<<SECTION 5>>>
## 6. Feed Service

Medium's feed combines two signals: articles from writers the user follows and topic-based recommendations. This is more complex than Twitter's purely follow-based feed but simpler than Netflix's multi-stage recommendation pipeline.

### Fan-out on Write for All Users

Unlike Instagram and Twitter where celebrities with millions of followers require fan-out on read, Medium's largest writers have at most a few hundred thousand followers. Fan-out on write for all users is perfectly viable. No hybrid model needed.

When an article is published, the Feed Fanout Worker writes it into the feed sorted set of every follower:

Key: feed:{user_id}  
Member: article_id  
Score: weighted relevance score (recency + follow boost + engagement signals)  
TTL: 7 days

Weighted Score Formula

Score = base_engagement_score + follow_boost + recency_decay

- base_engagement_score reflects how much engagement (claps, comments, reads) the article has received since publishing
- follow_boost is added for articles from writers the user follows, ensuring followed content gets priority but does not completely dominate
- recency_decay ensures newer articles score higher than older ones with the same engagement, preventing stale content from staying at the top

This weighted merge means the feed is a blend of follow-based and topic-based content rather than a strict ordering. A highly relevant fresh topic recommendation can surface above a stale article from a followed writer, which matches Medium's actual feed behavior.

### Topic-Based Recommendations

The recommendation pipeline runs periodically and computes topic-based article recommendations per user based on:

- **Reading history signals:** topics of articles the user read to completion (high completion_pct) weighted more than articles they bounced from
- **Collaborative filtering:** users who read the same articles as this user also read Y
- **Topic graph:** adjacent topics (self-help and poetry share readers; backend engineering and system design share readers)
- **Followed writer topics:** infer interest from the topics of writers the user follows

### Top topic-based recommendations are written to Redis per user:

Key: recommendations:{user_id}  
Value: \[article_id_1, article_id_2, ..., article_id_20\]  
TTL: 6 hours

At feed assembly time, the Feed Service merges the precomputed follow feed sorted set with the topic recommendations, applies the weighted scoring, and returns the top 20 article IDs.

### Already-Read Exclusion with Bloom Filter

A user must never see an article they have already read in their feed. The Reading History Service maintains a Bloom Filter per user:

BF.ADD seen:{user_id} article_id       (when user opens an article)  
BF.EXISTS seen:{user_id} article_id    (before inserting into feed sorted set)

Before any article is inserted into a user's feed sorted set or returned as a recommendation, BF.EXISTS is checked. If the article has been read, it is excluded. No false negatives means a read article is never shown again. The small false positive rate (occasionally excluding an unread article) is acceptable.

### Feed Read Flow

When a user opens their Medium home feed:

1. Feed Service fetches top 50 article IDs from feed:{user_id} sorted set via ZREVRANGE feed:user_123 0 49
1. Merges with topic recommendations from recommendations:{user_id} Redis key
1. Applies Bloom Filter exclusion for already-read articles
1. Re-ranks merged list by weighted score
1. Hydrates top 20 article IDs via Redis MGET for article metadata (title, subtitle, cover image, author, reading time, clap count)
1. On cache miss for any article, falls back to PostgreSQL and writes back to Redis
1. Returns rendered feed cards to client

### Bottlenecks in the Feed Service

Fan-out on write for 100,000 followers of a top writer means writing to 100,000 sorted sets per article publish. At 10,000 articles per day with average 500 followers each, this is 5 million sorted set writes per day, which is very manageable with a horizontally scaled Fanout Worker pool. Redis memory for feed sorted sets is capped by the 7-day TTL and a maximum of 200 articles per feed sorted set.

<<<SECTION 6>>>
## 7. Clap Service

The Clap Service handles Medium's unique engagement mechanism. A single reader can clap up to 50 times on a single article. Total claps displayed on an article is the SUM of all readers' clap counts, not a simple count of unique clappers.

### Redis Structure

### Per-user clap count (cap enforcement):

Key: claps:{article_id}:{user_id}  
Value: integer (1 to 50)  
TTL: 30 days

Before processing a clap: GET claps:{article_id}:{user_id}. If value equals 50, reject the clap (cap reached). Otherwise INCR claps:{article_id}:{user_id}.

### Total clap count (display on article):

Key: article:claps:{article_id}  
Value: integer (running total across all users)

Every clap that passes the per-user cap check also increments INCR article:claps:{article_id}. Reading total claps for display is a single GET article:claps:{article_id}. No SUM query needed at read time.

### Full Clap Flow

1. User taps clap button (can tap multiple times rapidly)
1. Client debounces taps and batches them (sends accumulated clap count every 1 second)
1. Clap Service receives { user_id, article_id, clap_increment }
1. GET claps:{article_id}:{user_id} -> current user clap count
1. Compute allowed increment: min(clap_increment, 50 - current_count)
1. If allowed increment > 0:INCRBY claps:{article_id}:{user_id} allowed_increment  
INCRBY article:claps:{article_id} allowed_increment  
Publish clap.created event to Kafka
1. Kafka consumers:**Clap Persistence Worker** upserts to Claps Table in PostgreSQL  
**Counter Sync Worker** periodically syncs Redis total to clap_count on Articles Table  
**Notification Worker** notifies article author (coalesced, not one notification per clap)

### Claps Table (PostgreSQL)

Claps  
user_id       UUID, foreign key -> Users  
article_id    UUID, foreign key -> Articles  
clap_count    INTEGER (1 to 50)  
last_clapped  TIMESTAMP  
PRIMARY KEY (user_id, article_id)

UPSERT on (user_id, article_id) with clap_count = clap_count + allowed_increment handles both first clap and subsequent claps in a single operation.

### Bottlenecks in the Clap Service

Clap bursts on viral articles (thousands of readers clapping simultaneously) are absorbed entirely by Redis INCRBY operations which are atomic and sub-millisecond. The Kafka consumer handles async persistence without any write pressure on PostgreSQL during the burst. Periodic reconciliation between Redis totals and PostgreSQL clap_count catches any drift.

<<<SECTION 7>>>
## 8. Comment Service

Comments on Medium are threaded but shallower than Reddit. Medium encourages responses (separate articles written as replies) more than deep comment threads. Comments are low volume compared to claps.

Data Model

### Comments Table (PostgreSQL)

Comments  
comment_id    UUID, primary key  
article_id    UUID, foreign key -> Articles  
parent_id     UUID, foreign key -> Comments (null for top-level)  
user_id       UUID, foreign key -> Users  
content       TEXT  
clap_count    INTEGER  
created_at    TIMESTAMP  
updated_at    TIMESTAMP

Same Adjacency List pattern as Reddit. parent_id = NULL means top-level comment on the article. Non-null parent_id means reply to another comment. Top-level comments sorted by clap count (most appreciated comments surface first). Replies sorted chronologically within a thread.

Composite index on (article_id, parent_id) makes both primary queries fast:

- Top-level comments: WHERE article_id = X AND parent_id IS NULL ORDER BY clap_count DESC LIMIT 20
- Replies to a comment: WHERE parent_id = comment_123 ORDER BY created_at ASC

Hot article comment sections are cached in Redis with a short TTL. The daily most-read articles benefit significantly from comment caching.

Bottlenecks in the Comment Service

Comment volume is low at Medium's scale. PostgreSQL handles comment writes comfortably. The main concern is comment sections on viral articles receiving thousands of simultaneous reads. Redis caching of top-level comments absorbs this.

<<<SECTION 8>>>
## 9. Search Service

Medium search covers three entities: articles (by title, content, and tags), writers (by name and username), and topics.

Storage Engine - Elasticsearch

Elasticsearch handles full-text search, partial matching, and relevance ranking across all article content. Medium search is primarily keyword and topic-based rather than engagement-weighted like Instagram, but clap count and read count are used as ranking signals.

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

Full article content is not indexed in Elasticsearch., only a content preview (first 500 characters) and tags. Full content search would make the index enormous and most search intent is satisfied by title, tags, and preview matching.

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

Ranking Signals

Medium search ranking combines:

- **Text match score** (title match weighted higher than tag match, tag match weighted higher than preview match)
- **Clap count** (more appreciated articles rank higher for the same query)
- **Recency** (newer articles get a ranking boost for broad queries)
- **Author follower count** (established writers rank slightly higher)

Keeping Elasticsearch in Sync

The Search Indexing Worker consumes from article.published and article.updated Kafka topics. Clap count and view count updates are batched and synced to Elasticsearch periodically rather than on every clap since exact engagement counts in search results do not need to be real-time.

<<<SECTION 9>>>
## 10. Reading History Service

The Reading History Service tracks which articles each user has read and how deeply they read them. This data feeds the recommendation pipeline and powers the Bloom Filter for feed deduplication.

### Data Model

### ReadingHistory Table (PostgreSQL, partitioned by user_id)

ReadingHistory  
user_id         UUID, foreign key -> Users  
article_id      UUID, foreign key -> Articles  
read_at         TIMESTAMP  
completion_pct  FLOAT (0.0 to 1.0, how far the user scrolled)  
time_spent_sec  INTEGER (actual reading time in seconds)

completion_pct is the most valuable signal. A user who reads 95% of an 8-minute article about Rust is far more interested in Rust than a user who opened and immediately bounced. This distinction drives topic interest scoring in the recommendation pipeline.

### Write Flow

Every article view generates a read event. At 1 million DAU reading an average of 5 articles per day, this is 5 million read events per day. Writes are high volume and must not block the reading experience.

Read events are published to Kafka asynchronously from the client:

1. User opens article -> client sends GET /articles/{slug} -> article served
1. Client tracks scroll position and time spent in the background
1. On article close or after 30 seconds: client sends read event { user_id, article_id, completion_pct, time_spent_sec }
1. Reading History Service publishes to Kafka: [article.read](https://x.com//article.read)
1. Kafka consumers:**History Persistence Worker** writes to ReadingHistory Table  
**Bloom Filter Worker** calls BF.ADD seen:{user_id} article_id  
**View Counter Worker** increments INCR article:views:{article_id} in Redis  
**Recommendation Signal Worker** updates UserTopics interest scores based on completion_pct

### Bottlenecks in the Reading History Service

5 million read events per day is ~58 per second on average, well within Kafka's capacity. The Bloom Filter writes are sub-millisecond Redis operations. PostgreSQL partition by user_id keeps per-user history queries fast.

<<<SECTION 10>>>
## 11. Notification Service

Same architecture as all previous systems. Kafka fanout from all interaction services, APNs for iOS, FCM for Android, email via SES.

The Notification Service subscribes to:

- article.published -> "Harry published a new article" to all followers
- clap.created -> coalesced clap notification to article author ("Harry and 42 others clapped for your article")
- comment.created -> comment notification to article author and parent comment author
- follow.created -> "Someone followed you" notification

### Notification Coalescing

Clap notifications must be coalesced aggressively. A viral article receiving 5,000 claps in an hour should not send 5,000 push notifications to the author. The Notification Service batches clap events within a 1-hour window and sends a single notification: "Your article received 5,247 claps in the last hour."

New article notifications from followed writers are delivered individually since each represents a distinct content event the reader wants to know about.

<<<SECTION 11>>>
## 12. Full Data Flow Summary

Article Creation Flow (Draft):  
Writer types -> client debounces -> autosave every 3-5 seconds  
    -> Post Service -> Redis WRITE draft:{article_id} (sub-millisecond)  
    -> Kafka (draft.updated)  
    -> MongoDB Writer (async, flushes every 30 seconds per draft)  
  
Image Upload Flow:  
Writer inserts image -> Post Service -> presigned S3 URL  
Writer -> S3 (direct upload)  
S3 -> Kafka -> Image Processing Worker -> S3 (thumbnail, medium, full variants)  
CDN caches all variants  
  
Publish Flow:  
Writer clicks Publish -> Post Service  
    -> Generate slug, compute reading_time  
    -> UPDATE Articles: status = 'published', published_at = NOW()  
    -> Write final content to MongoDB  
    -> Kafka (article.published)  
        -> Search Worker        -> Elasticsearch index  
        -> Feed Fanout Worker   -> Redis ZADD feed:{follower_id} for all followers  
        -> Notification Worker  -> APNs / FCM / SES to all followers  
        -> Topic Index Worker   -> Redis topic sorted sets updated  
  
Feed Read Flow:  
User opens Medium -> Feed Service  
    -> Redis ZREVRANGE feed:{user_id} 0 49 (follow-based articles)  
    -> Redis GET recommendations:{user_id} (topic-based articles)  
    -> Bloom Filter BF.EXISTS seen:{user_id} for each candidate (exclude read articles)  
    -> Weighted score merge and re-rank  
    -> Redis MGET (hydrate article metadata for top 20)  
    -> CDN (cover images served directly)  
  
Article Read Flow:  
User opens article -> Post Service  
    -> Redis (article metadata cache)  
    -> MongoDB (full article content)  
    -> CDN (embedded images)  
    -> Client tracks scroll + time spent  
    -> On close: read event published to Kafka ([article.read](https://x.com//article.read))  
        -> History Persistence Worker -> ReadingHistory Table (PostgreSQL)  
        -> Bloom Filter Worker        -> BF.ADD seen:{user_id} article_id  
        -> View Counter Worker        -> INCR article:views:{article_id}  
        -> Recommendation Signal Worker -> UPDATE UserTopics interest scores  
  
Clap Flow:  
User claps -> client debounces and batches -> Clap Service  
    -> GET claps:{article_id}:{user_id} (current user clap count)  
    -> Compute allowed increment (cap at 50)  
    -> INCRBY claps:{article_id}:{user_id} allowed_increment  
    -> INCRBY article:claps:{article_id} allowed_increment  
    -> Kafka (clap.created)  
        -> Clap Persistence Worker  -> UPSERT Claps Table (PostgreSQL)  
        -> Counter Sync Worker      -> UPDATE Articles.clap_count (periodic batch)  
        -> Notification Worker      -> coalesced clap notification to author  
  
Search Flow:  
User searches "rust backend" -> Search Service  
    -> Redis (hot query cache)  
    -> Elasticsearch (title + tag + preview match, ranked by claps + recency)  
    -> Redis MGET (hydrate article metadata for results)

<<<SECTION 12>>>
## 13. Resilience and Fault Tolerance

**Redis autosave buffer** ensures writers never lose work even if MongoDB is temporarily unavailable. Drafts survive in Redis with a 7-day TTL. The Kafka consumer catches up on MongoDB writes when the database recovers.

**Bloom Filter for feed deduplication** has no false negatives. A read article is never shown again. The small false positive rate (occasionally excluding an unread article) is completely acceptable and users never notice.

**Fan-out on write for all users** means feed reads are always fast regardless of database health. The feed sorted set in Redis is the primary read path. PostgreSQL is only hit on full cache misses.

**Kafka durability** throughout the pipeline means no article publish event, clap event, or read event is lost even if downstream services are temporarily unavailable. All consumers catch up from Kafka offsets on recovery.

**Redis clap counters with async PostgreSQL sync** absorb clap bursts on viral articles without any write pressure on the database. Periodic reconciliation catches any drift between Redis totals and PostgreSQL clap_count.

**MongoDB for article content** decouples content storage from metadata storage. A MongoDB slowdown affects article body reads but not feed assembly, search results, or profile pages which all use PostgreSQL and Redis.

**CDN caching** for all article images means embedded media is served from edge nodes globally. Article images change rarely (writers do not edit images after publishing) so cache hit rates are very high.

**Elasticsearch eventual consistency** for article indexing is acceptable. A newly published article may not appear in search results for a few seconds while the Search Indexing Worker processes the Kafka event. Readers discover new articles primarily through their feed, not through search.

<<<SECTION 13>>>
## 14. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, unauthenticated read routing)

**Article Content Store** -> MongoDB (Rich text JSON documents, flexible schema, large nested content)

**Article Metadata DB** -> PostgreSQL sharded + replicas (Title, slug, status, counters, strong consistency for publish state)

**Draft Autosave Buffer** -> Redis (Sub-millisecond autosave writes, 7-day TTL, async flush to MongoDB via Kafka)

**Image Storage** -> AWS S3 (Embedded article images, durable, CDN-native)

**CDN** -> CloudFront / Akamai (Edge caching for article images, high cache hit rate)

**Decoupling** -> Apache Kafka (Article publish fanout, clap persistence, read events, notification triggers)

**Search Engine** -> Elasticsearch (Full-text search on title, tags, preview, clap-weighted ranking)

**Feed Store** -> Redis Sorted Sets per user (Weighted score merge of follow-based and topic-based articles)

**Topic Recommendations** -> Redis per user (Precomputed topic-based article recommendations, 6-hour TTL)

**Read Deduplication** -> Redis Bloom Filter per user (Already-read article exclusion from feed)

**Clap Counter (per-user cap)** -> Redis INCRBY with GET cap check (Atomic 50-clap limit enforcement)

**Clap Counter (article total)** -> Redis INCRBY (Running total, single GET for display)

**Claps DB** -> PostgreSQL UPSERT (Source of truth for per-user clap counts)

**Reading History DB** -> PostgreSQL partitioned by user_id (Completion rate, time spent, recommendation signals)

**User Profile Cache** -> Redis (Writer profiles, follower counts, topic interest scores)

**Notification Delivery** -> APNs + FCM + AWS SES (Push notifications and email, aggressive clap coalescing)

That's all, folks...Cheers!!
