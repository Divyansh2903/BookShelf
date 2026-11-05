# Design A Distributed Cache

<<<SECTION 1>>>
A cache is not a database; it's a speed layer. It sits in front of your database, stores hot data in RAM, and serves most requests without ever touching disk. Designing one that works across hundreds of nodes is what this breakdown covers, legends.

### Cache vs Distributed Key-Value Store

They look similar but serve fundamentally different purposes:

Distributed KV Store : permanent storage, source of truth handles terabytes, data lives forever

Distributed Cache : temporary storage, speed layer sits in front of DB, data expires only hot data, fits in RAM

Data in a cache is always a copy of something that lives permanently elsewhere. If the cache goes down, nothing is lost, the DB always has the real data.

### Functional requirements

put(key, value, TTL) -> store with expiry   
get(key) -> return value or cache miss   
eviction -> LRU/LFU when cache is full   
invalidation -> remove stale data when origin updates   
cache miss handling -> fetch from DB, store, return

### Cache writing strategies

When a cache miss happens and you fetch from the DB, who puts it back into the cache, and when do writes go to cache? Three strategies, each with different tradeoffs.

### Cache Aside (Lazy Loading)

The application handles everything. On a miss, the application fetches from DB and writes to cache itself. Only requested data gets cached, no wasted memory. But the first request is always slow, and if the cache goes down, all requests hit DB directly.

get("user:123") -> cache miss -> application fetches from DB -> application writes to cache -> returns to user

### Write Through

Every write goes to the cache and DB simultaneously. Cache is always in sync, so, no stale data ever. Tradeoff: every write is slower, and the cache fills with data that might never be read.

put("user:123", "Rahul") -> write to cache -> write to DB simultaneously ->both confirm -> success

### Write Behind (Write Back)

Write to cache only, DB write happens asynchronously later. Blazing fast writes. Dangerous tradeoff: if cache crashes before the async write, data is gone forever. Only use when some data loss is acceptable.

put("user:123", "Rahul") -> write to cache -> return success immediately -> async job writes to DB later

Rule of thumb: read-heavy -> Cache Aside. Write-heavy, needs consistency -> Write Through. Write-heavy, speed over consistency -> Write Behind.

### Distributing across nodes - consistent hashing

With multiple cache nodes, you need to know instantly which node holds a key. Consistent hashing places nodes on a virtual ring and routes each key clockwise to the nearest node i.e. O(1) lookup, and when a node goes down only 1/N of keys remap.

<<<SECTION 2>>>
### Eviction policies

When a cache node's RAM is full, something has to go. Two main policies:

LRU (Least Recently Used) - evicts data that hasn't been accessed in the longest time. Best for recency-based patterns: social media feeds, session data, recent searches.

LFU (Least Frequently Used) - evicts data accessed the fewest times overall. Best for popularity-based patterns: YouTube videos, Spotify songs. Popular content stays cached even if not accessed recently.

Production systems like Redis combine both: LFU eviction + TTL expiry. This handles both the frequency problem and the stale historical data problem.

### Cache invalidation - handling stale data

When the DB updates, the cache still has the old version. Three strategies to handle this:

### TTL

Simplest approach - let stale data expire naturally. Set a TTL on every entry. Fine for non-critical data where a short stale window is acceptable.

### Event-driven invalidation

When DB changes, publish an event to Kafka. Cache consumes the event and deletes the stale key immediately. Near-instant invalidation, no stale window. Best for critical data.

User updates profile -> DB write -> publish "user:123 updated" to Kafka -> cache consumer deletes user:123 -> next read fetches fresh from DB

### Version-based invalidation

Every cached entry carries a version number matching the DB. On each read, compare versions, mismatch means stale, fetch fresh. Precise but requires version tracking in DB schema.

Cold start - what happens when a node restarts

Cache data lives in RAM,so a restart wipes everything. That's completely fine. The cache warms up naturally as requests come in, each miss repopulating from DB. This cold start period is an accepted tradeoff for the speed gains a cache provides.

<<<SECTION 3>>>
### The data layer

A distributed cache has no persistent DB of its own. It's a speed layer, not a storage layer:

1. RAM on each node stores key, value, TTL, and version. Lost on restart, which is fine.

2. Zookeeper stores hash ring config, node health (fed by Gossip Protocol), eviction policy, TTL defaults, cache size limits per node.

3. Kafka - event stream for invalidation. DB publishes change events, cache consumers delete stale keys.

The full architecture

Client ↓ Application Server ↓ Cache Cluster (consistent hashing → right node) ↓ Cache Hit → return value instantly in microseconds Cache Miss → fetch from DB → store in cache with TTL → return to client Background: Kafka → invalidation events when DB updates Gossip → node health detection Zookeeper → ring config, eviction policy, TTL defaults

### Non-functional requirements

### Latency

Everything lives in RAM. Cache hits return in microseconds. Consistent hashing means the routing decision is O(1). The goal is sub-millisecond response for every cache hit, keeping DB load minimal.

### Scalability

Add nodes to the consistent hash ring. Keys automatically redistribute with minimal remapping. Each node is independent, no cross-node coordination needed for reads and writes. Scales horizontally with near-zero overhead.

### Availability

If a cache node goes down, requests fall back to DB, slower but functional. Gossip Protocol detects the failure within seconds, Zookeeper updates the ring, and traffic reroutes automatically. The system degrades gracefully rather than failing completely.

That's all, folks...Cheers!
