# Design Tinder

<<<SECTION 1>>>
## High-Level Design: Tinder

## 1. Requirements

**Functional**
- Profile management: photos, bio, age, gender, relationship preferences
- Location-based discovery within a configurable radius
- Swipe right (like) / left (pass)
- Match detection: mutual like triggers a match
- Real-time chat between matched users only

**Out of scope:** Tinder Gold / Boost (paid promotion in discovery); video calls; advanced ML swipe ranking (acknowledged, not designed); push notifications (same APNs/FCM architecture as the Instagram design; covered in a separate notification-system article).

**Non-functional**
- High availability: discovery and chat never go down
- Low latency: profiles on screen within 100ms of opening the app
- Location accuracy: discovery reflects current position in near real time
- No repeated profiles: never show a profile already swiped on
- Strong consistency for match detection: never missed or double-triggered
- Eventual consistency OK for profile updates and like counts

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 10 million
- **Swipes:** ~50/user/day -> 500 million/day -> ~6000/second at peak
- **Match rate:** ~1-2% of right swipes -> ~5 million matches/day
- **Registered users:** ~50 million
- **Photos:** ~5 per user at ~1 MB -> 5 MB/user; total 50M × 5 MB = ~250 TB (written once, rarely updated)
- **Messages:** ~10/day per matched pair -> 50 million/day (low)

**Observations:** swipes (500M/day) are the dominant load; each must be recorded, checked for a match, and used to never show that profile again. Media is manageable since profiles rarely change. Chat is low because only matches can chat and the match rate is small. So optimize primarily for discovery and swipes, not media or messaging.

## 3. API Gateway

All requests enter via the API Gateway (authentication, rate limiting, routing). It must never carry binary media: after authentication, photo uploads go directly client-to-S3 via a presigned URL. The Gateway does only lightweight orchestration.

<<<SECTION 3>>>
## 4. User Profile Service

Manages identity: photos, bio, age, gender, discovery preferences.

**Upload flow**
1. Client sends upload request to API Gateway, which authenticates and forwards to the Profile Service.
2. Profile Service returns a **presigned S3 URL**.
3. Client uploads photos directly to S3; the backend never touches the binary.
4. S3 triggers a processing event via Kafka.
5. A **Photo Processing Worker** generates resolution variants (thumbnail for the card stack, medium for full profile view) and stores them in S3.
6. A CDN in front of S3 serves photos globally with high cache hit rates, since photos change rarely.

### Data Model

**Users (PostgreSQL):** user_id UUID PK; name VARCHAR; bio TEXT; age INTEGER; gender ENUM('male', 'female', 'non_binary'); looking_for ENUM('male', 'female', 'everyone'); relationship_type ENUM('casual', 'serious', 'friendship'); min_age_pref INTEGER; max_age_pref INTEGER; radius_km INTEGER; created_at TIMESTAMP; last_active TIMESTAMP.

**Photos (PostgreSQL):** photo_id UUID PK; user_id UUID FK -> Users; s3_url TEXT; order_index INTEGER; uploaded_at TIMESTAMP.

Photos are a separate table with order_index so users can reorder photos without updating the Users row.

**Indexing:** discovery filters on gender, looking_for, relationship_type, age. A composite index on (gender, looking_for, relationship_type, age) satisfies the full filter in one index scan, avoiding full table scans. Frequently accessed profiles (in many discovery stacks) are cached in Redis with full metadata, so hydration doesn't hit the DB each time.

**Bottlenecks:** writes are rare (profiles change seldom). The read path matters, since metadata is fetched constantly during discovery and hydration; Redis in front of PostgreSQL absorbs most of it.

<<<SECTION 4>>>
## 5. Location Service

Location is the foundation of discovery: every query starts with proximity before other filters.

**Problem with raw coordinates:** storing lat/long pairs (e.g. 19.0760, 72.8777 for Mumbai) makes radius queries expensive. Finding users within 50km needs a range scan on two floating-point columns at once, which indexes poorly and is catastrophically slow at scale.

**Geohashing** converts a 2D coordinate into one alphanumeric string encoding both. The world is recursively divided into rectangular cells, each with a short code. **Nearby locations share a common prefix:**

- te -> most of India
- te7u -> Mumbai region
- te7u3 -> a Mumbai neighborhood
- te7u3x -> a few city blocks

"Near Mumbai" becomes a prefix query, WHERE geohash LIKE 'te7u%', instead of a 2D radius calculation. Precision of 5-6 characters gives ~5-10 km cells, ideal for Tinder's typical radius.

**Redis GEO.** Rather than hand-rolling geohashing in a relational DB, the service uses Redis GEO, a native type that stores coordinates and supports radius queries. Internally it uses geohashing, storing coordinates in a sorted set scored by geohash.

- **GEOADD users:locations 72.8777 19.0760 "user_123"** adds user_123 at Mumbai coordinates
- **GEORADIUS users:locations 72.8777 19.0760 50 km** returns all users within 50km

**Location updates.** Users move (home, office, gym). Position is updated in Redis GEO when the client detects significant movement (typically >500 meters) or the app opens: a GEOADD that atomically overwrites the old position. Updates are also written asynchronously to a **Locations Table** in PostgreSQL for audit/history; discovery always reads from Redis GEO.

**Bottlenecks:** Redis GEO is in-memory and fast for writes and radius reads. Memory is the main concern: 10 million users at ~100 bytes each ≈ 1 GB, manageable. Secondary concern is update frequency if clients send every few seconds; mitigated by client-side throttling (send only after >500 meters moved, or on app open).

<<<SECTION 5>>>
## 6. Discovery Service

The heart of Tinder. On app open it must return a stack of 20 profiles filtered by proximity, age, gender, and relationship preference, excluding everyone already seen, in under 100ms.

**The already-seen problem.** Unlike Instagram, where everyone sees the same celebrity post, each user's stack is unique and must never repeat a swiped profile. A naive PostgreSQL query (WHERE swiper_id = X AND swiped_id IN (candidate_list)) is too slow: a year-long user may have swiped tens of thousands of profiles, and joining that history per request is prohibitively expensive.

### Bloom Filter for Seen Profile Exclusion

A **Bloom Filter** is a probabilistic structure answering "have I seen this item before?" It uses a fixed-size bit array and multiple hash functions. When A swipes on B, B's ID goes through 3-4 hash functions, each giving an index whose bit is set to 1. To check, apply the same hashes: all bits 1 → "probably yes"; any bit 0 → "definitely no".

- **No false negatives:** a seen profile is always excluded; never shown twice.
- **Small false positive rate:** occasionally an unseen profile is skipped, acceptable since skipping a valid candidate beats re-showing a rejected one.
- **Memory efficient:** 100,000 user IDs take several MB in a Redis Set, a few KB in a Bloom Filter.

Redis supports it natively via the RedisBloom module:

- BF.ADD seen:user_A user_B -> record that A has seen B
- BF.EXISTS seen:user_A user_B -> 1 (probably seen) or 0 (definitely not seen)

### Full Discovery Pipeline

When user A opens Tinder in Mumbai:

1. **Proximity query:** GEORADIUS users:locations 72.8777 19.0760 50 km returns all user IDs within 50km, potentially thousands.
2. **Bloom Filter exclusion:** BF.EXISTS seen:user_A candidate_id per candidate; any returning 1 is dropped, shrinking the list before touching the DB.
3. **Preference filtering:** remaining candidates go to PostgreSQL using the composite index:

   SELECT user_id FROM Users
   WHERE user_id IN (candidate_list)
   AND gender = 'female'
   AND relationship_type = 'serious'
   AND age BETWEEN 24 AND 30
   LIMIT 50

   The composite index on (gender, relationship_type, age) keeps this fast even with a large candidate list.
4. **Profile hydration:** the 20-50 remaining IDs are hydrated from Redis in one round trip: MGET profile:user_1 profile:user_2 ... profile:user_50. On a miss, fall back to PostgreSQL and write the record back to Redis.
5. **Response:** 20 hydrated profiles (name, age, bio, CDN photo URLs, distance); the client renders the card stack instantly.

**Bottlenecks:** Bloom Filter and Redis GEO ops are sub-millisecond; the PostgreSQL filter is the only disk step, kept fast by the composite index. Remaining concern: candidate pool size. In dense Mumbai, GEORADIUS might return 100,000 users within 50km. That's still fast through Bloom checks and a SQL IN clause, but for extreme density the radius can be reduced dynamically or the pool capped before the SQL step.

<<<SECTION 6>>>
## 7. Swipe Service

Highest-volume write path: 500 million swipes/day, ~6000/second at peak. Each swipe is recorded durably, updates the Bloom Filter, and is checked for a mutual match.

### Swipe Flow

1. **Receive:** client sends POST /swipes with { swiper_id, swiped_id, direction: 'left' | 'right' } via the API Gateway.
2. **Publish to Kafka:** a swipe.created event is published immediately, decoupling the hot path from downstream processing and providing durability; no swipe is lost even if downstream is slow.
3. **Update Bloom Filter:** BF.ADD seen:user_A user_B, so B never appears in A's stack again.
4. **Match detection (right swipes only):** check SISMEMBER likes:user_B user_A, i.e. whether B already liked A. B's pending likes are a Redis Set keyed by B's user ID.
   - Returns 1 -> **match**. Write to Matches DB, publish match.created to Kafka; the Notification Service alerts both users via APNs/FCM.
   - Returns 0 -> no match yet; add A to B's pending likes: SADD likes:user_B user_A.
5. **Async persistence:** a Kafka consumer writes all swipes to the **Swipes Table** in PostgreSQL (permanent record), off the hot path, not affecting latency.

### Data Model

**Swipes (PostgreSQL):** swipe_id UUID PK; swiper_id UUID FK -> Users; swiped_id UUID FK -> Users; direction ENUM('left', 'right'); swiped_at TIMESTAMP.

**Matches (PostgreSQL):** match_id UUID PK; user_1_id UUID FK -> Users; user_2_id UUID FK -> Users; matched_at TIMESTAMP.

**Bottlenecks:** the hot path (Bloom update, Redis Set check) is in-memory and handles 6000 ops/second comfortably. Kafka absorbs write bursts for downstream consumers. The async PostgreSQL write is the only disk op, off the critical path. Main Redis memory concern: a very attractive user may accumulate hundreds of thousands of pending likes; managed by capping the Set size per user and periodically evicting old entries unlikely to become matches.

<<<SECTION 7>>>
## 8. Chat Service

Only matched users chat. Volume is low (50 million messages/day across 5 million daily matches), but messages must feel real-time.

**Protocol: WebSockets.** HTTP is request-response; chat needs server push. WebSockets give a persistent, bidirectional connection for the session, letting the server push at any time with sub-millisecond overhead.

**Multi-server problem.** WebSocket connections are stateful and pinned to a Chat Server. If A is on Chat Server 1 (Mumbai) and B on Chat Server 3, Server 1 can't push to B's connection.

**Solution: Redis Pub/Sub.** Each Chat Server subscribes to a Redis channel for every active conversation it hosts. When A sends a message:

1. Chat Server 1 receives it
2. Publishes it to Redis channel chat:{match_id}
3. Chat Server 3, subscribed to chat:{match_id}, receives it instantly
4. Chat Server 3 pushes it to B's WebSocket

No server-to-server communication; Redis is the message bus.

### Message Storage

History must persist for scroll-back. The access pattern is always "messages for conversation X, chronological, paginated", a perfect fit for **Cassandra**.

**Messages (Cassandra):** match_id UUID partition key; message_id UUID clustering key (ordered by timestamp); sender_id UUID; content TEXT; sent_at TIMESTAMP.

Partitioning by match_id keeps a conversation on one node, making history fetches fast; the message_id clustering key orders messages chronologically within the partition.

The active view's 50 most recent messages are cached in a **Redis Sorted Set** (Key: conversation:{match_id}; Member: message_id; Score: timestamp). ZREVRANGE conversation:match_id 0 49 returns them in order in one call; older messages come from Cassandra on scroll.

### Online Presence

The green-dot status is in Redis: Key presence:{user_id}; Value { status: "online", last_seen: timestamp }; TTL 30 seconds.

The client sends a **heartbeat** every 15 seconds while the app is open, resetting the TTL to 30 seconds. On app close or connectivity loss, heartbeats stop, the key expires after 30 seconds, and the user appears offline. No explicit logout or polling; unexpected disconnects are handled gracefully.

**Bottlenecks:** each Chat Server holds a finite number of long-lived connections, typically 10,000-50,000 depending on memory, so 10 million DAU needs hundreds of instances. A **load balancer with sticky sessions** (or consistent hashing on user ID) reconnects a user to the same server after a brief disconnect, avoiding session loss. Redis Pub/Sub would bottleneck only if one conversation had extreme volume, not a concern for two-person dating chats.

<<<SECTION 8>>>
## 9. Full Data Flow Summary

**Profile upload:**
- Client -> API Gateway (auth) -> Profile Service -> presigned S3 URL
- Client -> S3 (direct upload)
- S3 -> Kafka -> Photo Processing Worker -> S3 (thumbnail + medium variants)
- Profile Service -> PostgreSQL (user metadata)
- Profile Service -> Redis GEO (GEOADD user location)

**Discovery:** client opens app -> Discovery Service -> Redis GEO GEORADIUS (nearby IDs) -> Redis Bloom Filter BF.EXISTS (exclude seen) -> PostgreSQL (age, gender, relationship type via composite index) -> Redis MGET (hydrate metadata) -> CDN (photo URLs served directly) -> 20 profiles to client in <100ms.

**Swipe:** client swipes -> Swipe Service -> Kafka (swipe.created, durability) -> Redis BF.ADD seen:user_A user_B -> if right swipe: Redis SISMEMBER likes:user_B user_A
- Match: write to Matches DB + Kafka match.created -> Notification Service -> APNs/FCM
- No match: Redis SADD likes:user_B user_A
- Then Kafka consumer -> PostgreSQL Swipes Table (async persistence)

**Chat:** client -> WebSocket -> Chat Server; message to Chat Server 1 -> Redis Pub/Sub publish chat:{match_id} -> Chat Server N (subscribed) -> WebSocket push to recipient -> Cassandra (persistent storage) -> Redis Sorted Set ZADD conversation:{match_id} (recent cache).

**Presence:** heartbeat every 15s -> Chat Service -> Redis SET presence:{user_id} TTL 30s -> key expires on disconnect -> user appears offline.

<<<SECTION 9>>>
## 10. Resilience and Fault Tolerance

- **Redis GEO for location:** fast but not durable by default. Location is also written async to PostgreSQL, so the service can rebuild after a Redis failure. Briefly stale location during recovery is acceptable (low stakes).
- **Bloom Filter durability:** if a user's filter is lost, they may temporarily see already-swiped profiles until it's rebuilt; a minor UX issue, not data integrity. It can be rebuilt from permanent swipe history in PostgreSQL on cache miss.
- **Kafka decoupling** in swipe and upload pipelines lets each consumer fail and recover independently without data loss; swipes wait in Kafka until processed.
- **Cassandra replication:** replication factor 3 across availability zones (standard) ensures no message loss under node failures.
- **WebSocket reconnection:** if a Chat Server dies, clients reconnect via the load balancer to a new instance, which subscribes to the relevant Redis Pub/Sub channels and reads the Redis Sorted Set for recent messages, rebuilding state with no data loss.
- **Match detection consistency:** SISMEMBER is atomic, and Redis executes commands single-threaded, so two simultaneous right swipes between A and B can't both miss the match: one runs first and adds to the likes Set, the second finds it.

<<<SECTION 10>>>
## 11. Technology Choices Summary

- **API Gateway** -> Kong / AWS API Gateway (auth, rate limiting, routing)
- **Blob Storage** -> AWS S3 (immutable profile photos, durable, CDN-native)
- **CDN** -> CloudFront / Akamai (edge caching for photos, high hit rate)
- **Decoupling** -> Apache Kafka (swipe durability, photo processing fanout, match events)
- **Location Store** -> Redis GEO (in-memory radius queries, real-time updates)
- **Seen Profile Exclusion** -> Redis Bloom Filter (memory-efficient, no false negatives)
- **Pending Likes Store** -> Redis Set (O(1) mutual like detection, match triggering)
- **User / Profile DB** -> PostgreSQL with composite indexes (structured data, preference filtering)
- **Swipes / Matches DB** -> PostgreSQL (permanent swipe and match history)
- **Chat Protocol** -> WebSockets (persistent bidirectional, real-time delivery)
- **Chat Message Bus** -> Redis Pub/Sub (cross-server routing between WebSocket servers)
- **Message Storage** -> Cassandra (high write throughput, partition by match_id, chronological ordering)
- **Recent Message Cache** -> Redis Sorted Set (sub-millisecond recent fetch)
- **Online Presence** -> Redis with TTL + heartbeat (automatic offline detection)
