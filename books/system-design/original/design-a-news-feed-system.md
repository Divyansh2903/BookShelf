# Design A News-Feed System

<<<SECTION 1>>>
## Problem statement

Design a news feed system similar to Facebook or Inshorts, where users can publish posts and see a personalized, chronological feed of content from people they follow.

## Requirements and scope

### Functional requirements:

- Users can create a post: POST /api/v1/newPost
- Users can fetch their feed: GET /api/v1/posts
- Feed is ordered chronologically

### Non-functional requirements:

- 10 million DAU
- Highly available and low-latency feed reads
- Eventual consistency is acceptable for feed delivery

### Back-Of-The-Envelope Estimation

DAU - 10M  
Read : Write ratio - 10 : 1  
Avg post size - 200 KB (with image URLs)  
Write throughput - 60 writes/sec  
Read throughput - 580 reads/sec  
New data written/day - 600 GB/day  
Read data served/sec - 2.3 GB/sec

The high read throughput makes **caching non-negotiable**.

### Core design decisions

### Fan-out on Write & Fan-out on Read (Hybrid model)

### Fan-out on Write (Push Model)

When User A makes a post, you immediately push that post to the feed of all of User A's followers.  
So if A has 1000 followers, you write that post to 1000 users' pre-built feed cache at write time.

**Result:** When a follower opens their feed, it's already ready, just read from cache. Super fast reads.

**Problem:** What if a celebrity (100M followers) posts something? **100M cache writes in seconds.** This is called the **Hotkey / Celebrity problem.**

### Fan-out on Read (Pull Model)

When a user opens their feed, you go and fetch posts from everyone they follow at that moment and assemble the feed.

**Result:** Reads are slower since you're computing on the fly, but writes are cheap.

**Problem:** At 580 reads/sec with each read hitting maybe 500 followers. That's a **massive DB fan-out on every request.**

### The Safe Spot (Hybrid)

Most real systems like Facebook/Twitter use a **hybrid approach:**

- **Regular users** -> Fan-out on Write
- **Celebrities / High follower accounts** -> Fan-out on Read

## Chronological ordering

Feeds are stored in Redis as sorted sets, keyed by UserFeed:{userId}, with the timestamp as the score. No ranking algorithm needed for a news-focused product.

## Write path

1. Client calls POST /api/v1/newPost -> hits the API Gateway
1. Gateway routes to the Post service, which writes the post to Post DB (NoSQL) and Post Cache (Redis)
1. Post service publishes an event to Kafka
1. Fan-out workers consume from Kafka asynchronously:Query Graph DB to fetch all followers of the author  
For each follower, push the new postId into their Redis feed sorted set
1. Notification service also consumes from Kafka and sends push alerts

## Read path

1. Client calls GET /api/v1/posts -> hits the API Gateway
1. Gateway routes to the Get service
1. Get service fetches the user's pre-built feed from Feed Cache (Redis) i.e. a list of postIds
1. On cache hit: hydrate each postId with full post content from Post Cache
1. On cache miss: fall back to Post DB and backfill the cache

<<<SECTION 2>>>
## Database choices

Post DB - NoSQL (e.g. Cassandra) - High write throughput, flexible schema

Graph DB - Neo4j / adjacency list - Efficient follower/following traversal

Feed Cache - Redis sorted set - O(log n) inserts, instant ranked reads

Post Cache - Redis - Low-latency post hydration

### CDN for media

At 2.3 GB/sec of read throughput, serving images and videos directly from the Post DB would be catastrophic. All media assets are stored in an object store (e.g. S3) and served via a CDN like CloudFront. The post record in the DB stores only the media URL, not the binary content itself. Cache-Control headers ensure images are served from edge nodes closest to the user, drastically reducing origin load and latency.

### Load balancing

A load balancer sits between the API Gateway and each downstream microservice - Post service, Get service, Fan-out workers, and Notification service. This ensures no single instance becomes a bottleneck and allows horizontal scaling. Health checks at the load balancer layer handle instance failures transparently.

### Feed pagination

The GET /api/v1/posts endpoint cannot return all posts in a single response. Cursor-based pagination is used instead of offset-based, because offsets become expensive as the feed grows. Each response returns a nextCursor (the timestamp of the last post returned). The next request passes this cursor, and the Get service fetches the next N postIds from Redis starting from that score. This keeps pagination O(log n) regardless of feed size.

### Kafka scalability

Kafka topics are partitioned by userId of the post author. This ensures all events from the same user land on the same partition, preserving ordering. Fan-out worker pods are part of a consumer group, each pod owns one or more partitions and scales horizontally as write throughput grows. Partition count can be increased without downtime as the system scales.

### Data retention in Redis

Redis memory is finite. Each user's feed sorted set is capped at the most recent 1000 postIds. When a fan-out worker pushes a new postId, it runs a ZREMRANGEBYRANK to trim entries beyond the cap. Requests for older posts fall through to the Post DB, which acts as the source of truth for the full historical feed.

### Auth and rate limiting

Authentication happens at the API Gateway layer using JWT tokens. Every request is validated before reaching any downstream service. Rate limiting is also enforced at the gateway, write endpoints like POST /api/v1/newPost are throttled per user to prevent abuse and protect Kafka from ingest spikes. Read endpoints have a more generous limit but are still bounded to protect the Get service.

### Search

Feed reads and post creation do not serve search. A separate **Elasticsearch** cluster is maintained for this purpose. Whenever a post is written to the Post DB, a change-data-capture (CDC) pipeline syncs it to Elasticsearch asynchronously. Users searching for posts, topics, or keywords hit a dedicated Search service backed by Elasticsearch, completely decoupled from the feed read path.

<<<SECTION 3>>>
## Bottlenecks and trade-offs

**The celebrity problem** : If a user has millions of followers, fan-out on write causes a thundering herd. Since this is a news platform with limited celebrity accounts, this is less severe. For a general-purpose system, a hybrid model (fan-out on read for high-follower accounts) would be used.

**Feed staleness:** Because fan-out is async via Kafka, there is a small delay between a post being published and it appearing in followers' feeds. This is acceptable for a news product.

**Storage:** Storing postId lists per user in Redis rather than full post content keeps memory usage manageable. Full content is only fetched during feed hydration.

That's all folks, Cheers!!
