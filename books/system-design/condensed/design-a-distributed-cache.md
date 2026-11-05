# Design A Distributed Cache

<<<SECTION 1>>>
A cache is a speed layer in front of the DB: it keeps hot data in RAM and serves most requests without touching disk. Goal: make it work across hundreds of nodes.

### Cache vs distributed KV store

- **KV store:** permanent source of truth, terabytes, data lives forever.
- **Cache:** temporary, in front of the DB, data expires, only hot data that fits in RAM.

Cached data is always a copy; if the cache dies, nothing is lost.

### Functional requirements

- `put(key, value, TTL)`: store with expiry
- `get(key)`: value or miss
- Eviction (LRU/LFU) when full
- Invalidation of stale data when origin updates
- Miss handling: fetch from DB, store, return

### Cache writing strategies

**Cache Aside (Lazy Loading):** on a miss the app fetches from DB and writes to cache. Only requested data is cached, but the first request is always slow, and a cache outage sends all traffic to the DB.
`get("user:123")` -> miss -> app reads DB -> app writes cache -> return.

**Write Through:** writes go to cache and DB simultaneously; never stale. Cost: slower writes, cache fills with data that may never be read.
`put("user:123", "Rahul")` -> cache + DB -> both confirm -> success.

**Write Behind (Write Back):** write cache only, DB updated async later. Very fast, but a crash before the async write loses data forever. Use only when some loss is acceptable.
`put("user:123", "Rahul")` -> cache -> success -> async DB write.

**Rule of thumb:** read-heavy: Cache Aside. Write-heavy + consistency: Write Through. Write-heavy + speed: Write Behind.

### Consistent hashing across nodes

Nodes sit on a virtual ring; each key routes clockwise to the nearest node. O(1) lookup; a node failure remaps only 1/N of keys.

<<<SECTION 2>>>
### Eviction policies

- **LRU:** evicts the least recently accessed data. For recency patterns: feeds, sessions, recent searches.
- **LFU:** evicts the least frequently accessed data. For popularity patterns: YouTube videos, Spotify songs; popular items stay even if not recently used.

Redis-style production systems combine LFU eviction + TTL expiry to handle both frequency and stale historical data.

### Cache invalidation

**TTL:** stale data simply expires. Fine for non-critical data tolerating a short stale window.

**Event-driven:** DB changes publish to Kafka; a cache consumer deletes the key immediately. No stale window; best for critical data.
Profile update -> DB write -> "user:123 updated" to Kafka -> consumer deletes user:123 -> next read fetches fresh.

**Version-based:** each entry stores the DB version; a mismatch on read means stale, so refetch. Precise, but needs version tracking in the DB schema.

**Cold start:** a restart wipes RAM. The cache rewarms as misses repopulate from DB, an accepted trade-off for the speed.

<<<SECTION 3>>>
### The data layer

No persistent DB of its own:

1. **RAM** per node: key, value, TTL, version (lost on restart, fine).
2. **Zookeeper:** hash ring config, node health (via Gossip Protocol), eviction policy, TTL defaults, per-node size limits.
3. **Kafka:** invalidation events from the DB; consumers delete stale keys.

**Full architecture:** Client -> App Server -> Cache Cluster (consistent hashing picks node).
- Hit: return in microseconds.
- Miss: fetch from DB -> store with TTL -> return.
- Background: Kafka (invalidation), Gossip (node health), Zookeeper (ring config, eviction policy, TTL defaults).

### Non-functional requirements

**Latency:** all in RAM; hits in microseconds; O(1) routing. Target sub-millisecond hits, minimal DB load.

**Scalability:** add nodes to the ring with minimal remapping. Nodes need no cross-node coordination for reads/writes; near-zero-overhead horizontal scaling.

**Availability:** a dead node means fallback to DB (slower, still works). Gossip detects it within seconds, Zookeeper updates the ring, traffic reroutes automatically: graceful degradation.
