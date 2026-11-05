# Design Tinder

<<<SECTION 1>>>
## High-Level Design: Tinder

## 1. Requirements

### Functional Requirements

- User profile management like photos, bio, age, gender, relationship preferences
- Location-based user discovery like finding potential matches within a configurable radius
- Swipe right (like) and swipe left (pass) on profiles
- Match detection. Mutual like triggers a match
- Real-time chat between matched users only

### Out of Scope

- Tinder Gold / Boost (paid profile promotion in discovery)
- Video calls
- Advanced ML ranking for swipe ordering (acknowledged but not designed)
- Push notifications (same APNs/FCM architecture the last Instagram article already covered) + I have a separate article for a proper notification-based system.

### Non-Functional Requirements

- High availability: Discovery and chat must never go down
- Low latency: Profiles must appear on screen within 100ms of opening the app
- Location accuracy: Discovery must reflect the user's current position in near real-time
- No repeated profiles: A user must never see a profile they have already swiped on
- Strong consistency for match detection: A match must never be missed or double-triggered
- Eventual consistency is acceptable for profile updates and like counts

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 10 million
- **Swipes per day:** ~50 swipes per user -> 500 million swipes/day -> ~6000 swipes/second at peak
- **Match rate:** ~1-2% of right swipes -> ~5 million matches/day
- **Total registered users:** ~50 million
- **Photos per user:** ~5 photos at ~1 MB each -> 5 MB per user
- **Total media storage:** 50 million × 5 MB = ~250 TB total (profiles are written once, updated rarely)
- **Messages per day:** matched users exchange ~10 messages/day -> 50 million messages/day (relatively low volume)

Key observations from these numbers. Swipe volume at 500 million per day is the dominant load in the system. Every swipe must be recorded, checked for a match, and used to ensure that profile is never shown again. Media storage is manageable since profiles are created once and rarely updated. Chat volume is surprisingly low because only matched users can chat and the match rate is small. This means the system must be optimized primarily for the discovery and swipe paths, not for media serving or messaging.

## 3. API Gateway

All client requests enter through the API Gateway, which handles authentication, rate limiting, and routing to the correct downstream service. The same constraint applies as in every other design, the API Gateway must never be in the path of binary media payloads. Profile photo uploads bypass the Gateway after authentication, using a presigned S3 URL for direct client-to-S3 upload. The Gateway handles only lightweight request orchestration.

<<<SECTION 3>>>
## 4. User Profile Service

The Profile Service manages everything about a user's identity on Tinder; their photos, bio, age, gender, and discovery preferences.

Upload Flow

When a user uploads profile photos:

1. Client sends an upload request to the API Gateway, which authenticates the user and forwards it to the Profile Service
1. The Profile Service generates a **presigned S3 URL** and returns it to the client
1. The client uploads photos directly to S3, the backend never touches the binary payload
1. S3 triggers a processing event via Kafka
1. A **Photo Processing Worker** generates multiple resolution variants- thumbnail for the discovery card stack, medium for full profile view, and stores all variants back in S3
1. The CDN sits in front of S3 and serves profile photos to clients globally with high cache hit rates, since profile photos change rarely

### Data Model

### Users Table (PostgreSQL)

Users  
user_id           UUID, primary key  
name              VARCHAR  
bio               TEXT  
age               INTEGER  
gender            ENUM('male', 'female', 'non_binary')  
looking_for       ENUM('male', 'female', 'everyone')  
relationship_type ENUM('casual', 'serious', 'friendship')  
min_age_pref      INTEGER  
max_age_pref      INTEGER  
radius_km         INTEGER  
created_at        TIMESTAMP  
last_active       TIMESTAMP

### Photos Table (PostgreSQL)

Photos  
photo_id      UUID, primary key  
user_id       UUID, foreign key -> Users  
s3_url        TEXT  
order_index   INTEGER  
uploaded_at   TIMESTAMP

Photos are stored as a separate table with an order_index so users can reorder their photo stack without updating the Users row.

### Indexing Strategy

Discovery queries filter on gender, looking_for, relationship_type, and age. A composite index on (gender, looking_for, relationship_type, age) allows the database to satisfy the full filter in a single index scan without a full table scan. This is what keeps discovery queries fast at scale.

Additionally, frequently accessed profiles (users who appear in many discovery stacks), are cached in Redis with their full metadata, so the database is not hit for every profile hydration request.

Bottlenecks in the Profile Service

The Profile Service is not a high-throughput write path as users update their profiles rarely. The read path is the concern, since profile metadata is fetched constantly during discovery and feed hydration. Redis caching in front of PostgreSQL absorbs the vast majority of this read load.

<<<SECTION 4>>>
## 5. Location Service

Location is the foundational layer of Tinder's discovery system. Every discovery query begins with proximity - find users near me before applying any other filter.

### The Problem with Raw Coordinates

Storing user locations as raw latitude and longitude pairs (e.g. 19.0760, 72.8777 for Mumbai) makes radius queries extremely expensive. Finding all users within 50km requires a range scan across two floating-point columns simultaneously, which does not index well and becomes catastrophically slow at scale.

### Geohashing

Geohashing solves this by converting a 2D coordinate into a single alphanumeric string that encodes both latitude and longitude. The world is recursively divided into a grid of rectangular cells, and each cell is assigned a short string code. The key property is that **geographically close locations share a common geohash prefix**:

- te -> broad region covering most of India
- te7u -> Mumbai region
- te7u3 -> a specific neighborhood in Mumbai
- te7u3x -> a few city blocks

Finding users near Mumbai becomes a simple prefix query- WHERE geohash LIKE 'te7u%', rather than a complex two-dimensional radius calculation. A geohash precision of 5-6 characters gives cells of roughly 5-10 km, which is ideal for Tinder's typical discovery radius.

### Redis GEO

Rather than implementing geohashing manually in a relational database, the Location Service uses **Redis GEO,** which is a native Redis data type that stores coordinates and supports radius queries out of the box. Under the hood Redis GEO uses geohashing internally, storing coordinates in a sorted set scored by their geohash value.

Key operations:

**GEOADD users:locations 72.8777 19.0760 "user_123"**  
this adds user_123 at Mumbai coordinates  
  
**GEORADIUS users:locations 72.8777 19.0760 50 km**  
this returns all users within 50km of those coordinates

### Location Updates

Tinder users move constantly. Home in the morning, office at noon, gym in the evening. The Location Service updates a user's position in Redis GEO whenever the client detects significant movement (typically more than 500 meters) or whenever the user opens the app. This is a simple GEOADD call that overwrites the previous position atomically.

Location updates are also written asynchronously to a **Locations Table** in PostgreSQL for audit and history purposes, but the hot path for discovery always reads from Redis GEO.

### Bottlenecks in the Location Service

Redis GEO is in-memory and extremely fast for both writes and radius reads. The main concern is memory. Storing coordinates for 10 million active users in Redis is manageable (roughly 100 bytes per user  ~1 GB). The secondary concern is location update frequency. If every client sends location updates every few seconds, the write volume becomes significant. This is mitigated by client-side throttling. Only send a location update if the user has moved more than 500 meters since the last update, or when the app is opened.

<<<SECTION 5>>>
## 6. Discovery Service

The Discovery Service is the heart of Tinder. When a user opens the app, it must produce a stack of 20 profiles, filtered by proximity, age, gender, and relationship preference, and excluding everyone they have already seen in under 100ms.

### The Already-Seen Problem

Unlike Instagram where every user sees the same celebrity post, Tinder's discovery stack is unique per user and must never repeat a profile the user has already swiped on. This exclusion check is the most technically interesting requirement in the system.

A naive approach like querying a Swipes table in PostgreSQL with WHERE swiper_id = X AND swiped_id IN (candidate_list) is far too slow at scale. A user who has been on Tinder for a year may have swiped on tens of thousands of profiles. Joining against that history on every discovery request is prohibitively expensive.

### Bloom Filter for Seen Profile Exclusion

A **Bloom Filter** is a probabilistic data structure that answers one question extremely efficiently: "have I seen this item before?"

It uses a fixed-size bit array and multiple hash functions. When user A swipes on user B, user B's ID is run through 3-4 hash functions, each producing an index, and those bits are set to 1 in the array. To check "has user A seen user B?", the same hash functions are applied and all resulting bit positions are checked. If all bits are 1, the answer is "probably yes." If any bit is 0, the answer is "definitely no."

Key properties:

- **No false negatives:** a profile the user has seen will always be excluded. They will never be shown the same profile twice.
- **Small false positive rate:** occasionally a profile is excluded when the user has not actually seen it. On Tinder this is completely acceptable. Occasionally skipping a valid candidate is far better than showing a rejected profile again.
- **Extremely memory efficient:** storing 100,000 user IDs in a Redis Set might take several MB. A Bloom Filter for the same data takes a few KB.

Redis supports Bloom Filters natively via the RedisBloom module:

BF.ADD seen:user_A user_B        -> record that user A has seen user B  
BF.EXISTS seen:user_A user_B     -> 1 (probably seen) or 0 (definitely not seen)

### Full Discovery Pipeline

When user A opens Tinder in Mumbai, the following sequence occurs:

**Step 1 (Proximity Query) -** The Discovery Service calls GEORADIUS users:locations 72.8777 19.0760 50 km on Redis GEO. This returns a list of all user IDs within 50km, potentially thousands of candidates.

**Step 2 (Bloom Filter Exclusion) -** For each candidate user ID, the Discovery Service calls BF.EXISTS seen:user_A candidate_id. Any candidate that returns 1 is excluded from the pool immediately. This reduces the candidate list significantly before any database involvement.

**Step 3 (Preference Filtering) -** The remaining candidates are passed to a PostgreSQL query that filters on age, gender, and relationship type using the composite index:

SELECT user_id FROM Users  
WHERE user_id IN (candidate_list)  
AND gender = 'female'  
AND relationship_type = 'serious'  
AND age BETWEEN 24 AND 30  
LIMIT 50

The composite index on (gender, relationship_type, age) makes this query extremely fast even with a large candidate list.

**Step 4 (Profile Hydration)-** The filtered candidate list (now a manageable set of 20-50 user IDs) is hydrated by fetching full profile metadata from Redis using a single MGET call:

MGET profile:user_1 profile:user_2 ... profile:user_50

MGET fetches all records in a single round trip. On a cache miss for any profile, the Discovery Service falls back to PostgreSQL, fetches the missing record, and writes it back to Redis.

**Step 5 (Response)** The Discovery Service returns 20 fully hydrated profiles to the client like name, age, bio, photo URLs (pointing to CDN), distance. The client renders the card stack instantly.

### Bottlenecks in Discovery

The Bloom Filter and Redis GEO operations are sub-millisecond. The PostgreSQL preference filter is the only step that touches a disk-based store, and the composite index keeps it fast. The remaining concern is the candidate pool size, in a dense city like Mumbai, a GEORADIUS query might return 100,000 users within 50km. Passing 100,000 IDs through Bloom Filter checks and then into a SQL IN clause is still fast at this scale, but for extreme density scenarios the radius can be dynamically reduced or the candidate pool capped before the SQL step.

<<<SECTION 6>>>
## 7. Swipe Service

The Swipe Service handles the highest-volume write path in the system, 500 million swipes per day, or roughly 6000 per second at peak. Every swipe must be recorded durably, used to update the Bloom Filter, and checked for a mutual match.

### Swipe Flow

**Step 1 (Receive Swipe) -** Client sends POST /swipes with { swiper_id, swiped_id, direction: 'left' | 'right' } to the Swipe Service via the API Gateway.

**Step 2 (Publish to Kafka) -** The Swipe Service immediately publishes a swipe.created event to Kafka. This decouples the hot path from all downstream processing and provides durability, even if downstream services are temporarily slow, no swipe is lost.

**Step 3 (Update Bloom Filter)-** BF.ADD seen:user_A user_B, records that user A has now seen user B. This ensures user B never appears in user A's discovery stack again.

**Step 4 (Match Detection for right swipes only)**If the swipe direction is right (like), the Swipe Service checks Redis:

SISMEMBER likes:user_B user_A

This checks whether user B has previously liked user A. User B's pending likes are stored in a Redis Set keyed by their user ID.

- If SISMEMBER returns 1 -> **match detected**. The Swipe Service writes the match to the Matches DB, publishes a match.created event to Kafka, and the Notification Service picks this up to alert both users via APNs/FCM.
- If SISMEMBER returns 0 -> no match yet. The Swipe Service adds user A to user B's pending likes set: SADD likes:user_B user_A.

**Step 5 (Async Persistence)-** A Kafka consumer writes all swipes asynchronously to the **Swipes Table** in PostgreSQL (the permanent record of every swipe in the system). This write happens off the hot path and does not affect swipe latency.

Data Model

### Swipes Table (PostgreSQL)

Swipes  
swipe_id      UUID, primary key  
swiper_id     UUID, foreign key -> Users  
swiped_id     UUID, foreign key -> Users  
direction     ENUM('left', 'right')  
swiped_at     TIMESTAMP

### Matches Table (PostgreSQL)

Matches  
match_id      UUID, primary key  
user_1_id     UUID, foreign key -> Users  
user_2_id     UUID, foreign key -> Users  
matched_at    TIMESTAMP

Bottlenecks in the Swipe Service

The hot path i.e. Bloom Filter update and Redis Set check, is entirely in-memory and handles 6000 operations per second comfortably. Kafka absorbs the write burst and smooths it out for downstream consumers. The async PostgreSQL write is the only disk operation and happens off the critical path. The main Redis memory concern is the pending likes Sets, a very attractive user might accumulate hundreds of thousands of pending likes. This is managed by capping the likes Set size per user and periodically evicting old entries that are unlikely to result in a match.

<<<SECTION 7>>>
## 8. Chat Service

Only matched users can chat with each other. Chat volume is relatively low, like 50 million messages per day across 5 million daily matches, but the latency requirement is strict. Messages must feel real-time.

Protocol will be WebSockets

HTTP is a request-response protocol where the client asks, the server answers. For real-time chat, the server needs to push messages to the client without waiting for a request. **WebSockets** provide a persistent, bidirectional connection between the client and server that stays open for the duration of the session. Once a WebSocket connection is established, the server can push messages to the client at any time with sub-millisecond overhead.

### The Multi-Server Problem

WebSocket connections are stateful. A user is connected to a specific Chat Server instance. User A might be connected to Chat Server 1 in Mumbai, and User B might be connected to Chat Server 3. When User A sends a message to User B, Chat Server 1 has no direct connection to User B. It cannot push the message to User B's WebSocket connection because that connection lives on Chat Server 3.

The solution is **Redis Pub/Sub**. Every Chat Server subscribes to a Redis channel for every active conversation on that server. When User A sends a message:

1. Chat Server 1 receives the message
1. Chat Server 1 publishes the message to Redis channel chat:{match_id}
1. Chat Server 3 is subscribed to chat:{match_id} and receives the message instantly
1. Chat Server 3 pushes the message to User B's WebSocket connection

No direct server-to-server communication is needed. Redis acts as the message bus between Chat Servers.

### Message Storage

Messages need to be stored persistently so users can scroll back through conversation history. The access pattern is always "give me messages for conversation X in chronological order, paginated" . This is a perfect fit for **Cassandra**.

### Messages Table (Cassandra)

Messages  
match_id      UUID, partition key  
message_id    UUID, clustering key (ordered by timestamp)  
sender_id     UUID  
content       TEXT  
sent_at       TIMESTAMP

Partitioning by match_id means all messages for a conversation are stored together on the same Cassandra node, making conversation history fetches extremely fast. The message_id clustering key orders messages chronologically within the partition.

For the active conversation view, the most recent 50 messages, messages are also cached in a **Redis Sorted Set**:

Key: conversation:{match_id}  
Member: message_id  
Score: timestamp

ZREVRANGE conversation:match_id 0 49 returns the 50 most recent messages in order in a single Redis call. Older messages are fetched from Cassandra on scroll.

### Online Presence

Users need to know if their match is currently online (the green dot indicator). Online presence is stored in Redis:

Key: presence:{user_id}  
Value: { status: "online", last_seen: timestamp }  
TTL: 30 seconds

The client sends a **heartbeat** to the Chat Service every 15 seconds while the app is open. Each heartbeat resets the Redis key's TTL to 30 seconds. If a user closes the app or loses connectivity, they stop sending heartbeats. After 30 seconds the key expires naturally, and the user appears offline, so no explicit logout needed, and no polling required. This handles unexpected disconnections gracefully.

### Bottlenecks in the Chat Service

WebSocket connections are long-lived and stateful, which means each Chat Server instance can only hold a finite number of concurrent connections, typically 10,000-50,000 per server depending on memory. At 10 million DAU, this requires hundreds of Chat Server instances. A **load balancer with sticky sessions** (or consistent hashing on user ID) ensures that a user always reconnects to the same Chat Server instance after a brief disconnection, avoiding session loss. Redis Pub/Sub is the bottleneck if a single conversation receives extreme message volume.. In practice this is not a concern for a dating app where conversations are between exactly two users.

<<<SECTION 8>>>
## 9. Full Data Flow Summary

Profile Upload Flow:  
Client -> API Gateway (auth) -> Profile Service -> presigned S3 URL  
Client -> S3 (direct upload)  
S3 -> Kafka -> Photo Processing Worker -> S3 (thumbnail + medium variants)  
Profile Service -> PostgreSQL (user metadata)  
Profile Service -> Redis GEO (GEOADD user location)  
  
Discovery Flow:  
Client opens app -> Discovery Service  
-> Redis GEO GEORADIUS (nearby user IDs within radius)  
-> Redis Bloom Filter BF.EXISTS (exclude already seen users)  
-> PostgreSQL (filter by age, gender, relationship type via composite index)  
-> Redis MGET (hydrate profile metadata)  
-> CDN (profile photo URLs served directly)  
-> 20 profiles returned to client in <100ms  
  
Swipe Flow:  
Client right/left swipes -> Swipe Service  
-> Kafka (swipe.created, durability)  
-> Redis BF.ADD seen:user_A user_B (update Bloom Filter)  
-> If right swipe:  
    Redis SISMEMBER likes:user_B user_A  
    -> Match: write to Matches DB + Kafka match.created -> Notification Service -> APNs/FCM  
    -> No match: Redis SADD likes:user_B user_A  
-> Kafka consumer -> PostgreSQL Swipes Table (async persistence)  
  
Chat Flow:  
Client -> WebSocket connection -> Chat Server  
Message sent -> Chat Server 1  
-> Redis Pub/Sub publish chat:{match_id}  
-> Chat Server N (subscribed) -> WebSocket push to recipient  
-> Cassandra (persistent message storage)  
-> Redis Sorted Set ZADD conversation:{match_id} (recent message cache)  
  
Presence Flow:  
Client heartbeat every 15s -> Chat Service  
-> Redis SET presence:{user_id} TTL 30s  
-> Key expires on disconnect -> user appears offline

<<<SECTION 9>>>
## 10. Resilience and Fault Tolerance

**Redis GEO for location** means location data is in-memory and extremely fast, but Redis is not durable by default. Location data is also asynchronously written to PostgreSQL, so on a Redis failure, the Location Service can rebuild from the persistent store. Location data is also low-stakes, a brief period of slightly stale location during a Redis recovery is acceptable.

**Bloom Filter durability** is a nuanced concern. If the Redis Bloom Filter for a user is lost, they might temporarily see profiles they have already swiped on until the filter is rebuilt. This is acceptable. It is a minor UX issue, not a data integrity issue. The permanent swipe history in PostgreSQL can be used to rebuild the Bloom Filter for a user on cache miss.

**Kafka decoupling** throughout the swipe and upload pipelines means every downstream consumer can fail and recover independently without data loss. Swipes are never lost, they sit in Kafka until the consumer processes them.

**Cassandra replication** for chat messages ensures no message is lost even under node failures. Replication factor of 3 across availability zones is standard.

**WebSocket reconnection** is handled gracefully. If a Chat Server goes down, clients reconnect automatically via the load balancer to a new server instance. The new server subscribes to the relevant Redis Pub/Sub channels and Redis Sorted Set for recent messages, rebuilding state without any data loss.

**Match detection consistency-** The Redis Set check for mutual likes (SISMEMBER) is atomic. Redis is single-threaded for command execution, so there is no race condition where two simultaneous right swipes between user A and user B could both fail to detect the match. One will execute first, add to the likes Set, and the second will find it there.

<<<SECTION 10>>>
## 11. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, routing)

**Blob Storage** -> AWS S3 (Immutable profile photos, durable, CDN-native)

**CDN** -> CloudFront / Akamai (Edge caching for profile photos, high cache hit rate)

**Decoupling** -> Apache Kafka (Swipe durability, photo processing fanout, match events)

**Location Store** -> Redis GEO (In-memory radius queries, real-time location updates)

**Seen Profile Exclusion** -> Redis Bloom Filter (Memory-efficient already-seen tracking, no false negatives)

**Pending Likes Store** -> Redis Set (O(1) mutual like detection, match triggering)

**User / Profile DB** -> PostgreSQL with composite indexes (Structured data, preference filtering)

**Swipes / Matches DB** -> PostgreSQL (Permanent swipe and match history)

**Chat Protocol** -> WebSockets (Persistent bidirectional connection, real-time message delivery)

**Chat Message Bus** -> Redis Pub/Sub (Cross-server message routing between WebSocket servers)

**Message Storage** -> Cassandra (High write throughput, partition by match_id, chronological ordering)

**Recent Message Cache** -> Redis Sorted Set (Sub-millisecond recent conversation fetch)

**Online Presence** -> Redis with TTL + heartbeat (Automatic offline detection on disconnect)

That's all, folks...Cheers!!
