# Design A News-Feed System

<<<SECTION 1>>>
## Problem statement

A news feed like Facebook or Inshorts: users publish posts and see a personalized, chronological feed from people they follow.

## Requirements and scope

- **Functional:** create post (`POST /api/v1/newPost`), fetch feed (`GET /api/v1/posts`), chronological order.
- **Non-functional:** 10M DAU; highly available, low-latency reads; eventual consistency OK for feed delivery.

**Estimates:** read:write 10:1; avg post 200 KB (with image URLs); 60 writes/sec; 580 reads/sec; 600 GB new data/day; 2.3 GB/sec served. High reads make **caching non-negotiable**.

### Fan-out: hybrid model

**Fan-out on Write (push):** a post is pushed immediately into every follower's pre-built feed cache (1000 followers = 1000 writes). Reads are just cache reads. But a celebrity with 100M followers means **100M cache writes in seconds**: the **Hotkey / Celebrity problem**.

**Fan-out on Read (pull):** the feed is assembled on open from everyone followed. Cheap writes, slower reads; 580 reads/sec each hitting ~500 followers is a **massive DB fan-out per request**.

**Hybrid** (Facebook/Twitter): regular users use fan-out on write; celebrities/high-follower accounts use fan-out on read.

## Chronological ordering

Feeds are Redis sorted sets keyed `UserFeed:{userId}`, score = timestamp. No ranking needed for news.

## Write path

1. `POST /api/v1/newPost` -> API Gateway -> Post service.
2. Post service writes to Post DB (NoSQL) and Post Cache (Redis), then publishes to Kafka.
3. Fan-out workers consume async: query Graph DB for the author's followers, push the postId into each follower's Redis feed set.
4. Notification service also consumes from Kafka and sends push alerts.

## Read path

1. `GET /api/v1/posts` -> API Gateway -> Get service.
2. Get service reads the pre-built feed (postIds) from Feed Cache (Redis).
3. Hit: hydrate postIds from Post Cache. Miss: fall back to Post DB and backfill.

<<<SECTION 2>>>
## Database choices

- **Post DB:** NoSQL (e.g. Cassandra); high write throughput, flexible schema
- **Graph DB:** Neo4j / adjacency list; fast follower traversal
- **Feed Cache:** Redis sorted set; O(log n) inserts, instant ranked reads
- **Post Cache:** Redis; low-latency hydration

### CDN for media

At 2.3 GB/sec, serving media from Post DB would be catastrophic. Media lives in an object store (e.g. S3) behind a CDN like CloudFront; posts store only the URL. Cache-Control headers let the nearest edge serve images, cutting origin load and latency.

### Load balancing

LBs sit between the API Gateway and each service (Post, Get, fan-out workers, Notification) to avoid single-instance bottlenecks and allow horizontal scaling; health checks absorb instance failures.

### Feed pagination

Cursor-based, not offset-based (offsets get expensive as feeds grow). Each response returns `nextCursor` (last post's timestamp); the next request fetches the next N postIds from Redis from that score. O(log n) at any feed size.

### Kafka scalability

Topics are partitioned by author userId, keeping each user's events ordered on one partition. Fan-out pods form a consumer group, each owning one or more partitions, scaling horizontally. Partitions can be added without downtime.

### Data retention in Redis

Each feed set is capped at the latest 1000 postIds; workers run `ZREMRANGEBYRANK` on push to trim. Older posts come from Post DB, the source of truth.

### Auth and rate limiting

The API Gateway validates JWTs on every request. It also rate-limits: writes like `POST /api/v1/newPost` are throttled per user (prevents abuse, protects Kafka from ingest spikes); reads get a looser but bounded limit to protect the Get service.

### Search

A separate **Elasticsearch** cluster, fed asynchronously by a change-data-capture (CDC) pipeline from Post DB. A dedicated Search service handles post/topic/keyword search, decoupled from the feed path.

<<<SECTION 3>>>
## Bottlenecks and trade-offs

**Celebrity problem:** millions of followers cause a thundering herd under fan-out on write. Less severe on a news platform with few celebrity accounts; a general system would use the hybrid model.

**Feed staleness:** async Kafka fan-out adds a small delay before posts reach feeds; acceptable for news.

**Storage:** Redis holds postId lists, not content, keeping memory manageable; content is fetched only at hydration.
