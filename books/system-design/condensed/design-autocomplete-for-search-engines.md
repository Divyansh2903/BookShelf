# Design Autocomplete For Search Engines

<<<SECTION 1>>>
Autocomplete (e.g. Google Search) suggests completions before you finish typing; one of the most latency-sensitive, data-heavy design problems.

**Functional requirements**
1. Suggest the most searched words/sentences for the typed prefix.
2. Record every search and update suggestion frequencies over time.

### Non-functional requirements

Latency is most critical: every keystroke is a query, answered in under 100ms (ideally 50ms). Scalability and availability follow.

**Core structure: Trie**, a prefix tree with one character per node; root-to-node paths spell words. Example: a → p → p, branching to "le" (apple) and "s → tore" (app store). At the "app" node every descendant is a valid suggestion; lookup is O(prefix length) regardless of Trie size.

**Ranking = frequency + priority queue.** Thousands of words start with "app"; you show 5-10. Each node stores a precomputed top-N list of most searched completions, e.g. "app" → apple (9M), app store (7M), application (4M), appetizer (1M), apparel (800k). A priority queue by descending frequency keeps the top ones first; lists are cached per node, so queries need zero extra computation.

**Why not real-time writes:** Google handles 8.5B searches/day (~100,000/s). Updating the in-memory Trie per search means 100,000 concurrent writes on data millions are reading: race conditions, slowdowns. Instead, **batch processing** rebuilds the Trie every few hours:

1. User searches "apple"
2. Logged to Kafka instantly (async)
3. Kafka accumulates millions of searches
4. Apache Spark batch job every few hours recomputes frequencies from logs
5. Rebuilds Trie → pushes to Redis + S3
6. Trie servers reload it

Users query a snapshot a few hours old, which nobody notices: **eventual consistency**.

**Trie sharding.** The full prefix Trie can't fit on one machine, so it's split by prefix range. Not purely alphabetically, since traffic is uneven ("s": sports, shopping, spotify, samsung; "x": almost nothing). Shard by load:

- Server 1 → a–m
- Server 2 → n–r
- Server 3 → s (alone)
- Server 4 → t–z

**Zookeeper** maps prefix ranges to servers; each request hits it first and is routed to the right shard.

<<<SECTION 2>>>
### The database layer - two stores

- **Search log DB (Cassandra):** logs searchID, userID, query, timestamp, location; feeds the batch job. Built for massive write throughput (billions/day) and easy horizontal scaling.
- **Trie store (S3 + Redis):** the batch job serializes the rebuilt Trie to S3 (source of truth, for reload on restart); each shard loads its portion into Redis. S3 for durability, Redis for speed.

### The full architecture

1. User types "app" → API Gateway
2. Zookeeper → "a" lives on Server 1
3. Server 1 queries its Redis Trie shard
4. Returns top 5 in <50ms
5. Meanwhile the search is logged to Kafka
6. Spark batch every few hours: reads Cassandra logs → recomputes frequencies → rebuilds Trie → dumps to S3 + pushes to Redis

### Non-functional requirements

<<<SECTION 3>>>
### Latency

Trie in Redis (in-memory), precomputed top suggestions per node, microsecond Zookeeper routing. Target: under 50ms end to end per keystroke.

**Scalability:** Trie sharding spreads reads; Cassandra absorbs log writes; Spark scales horizontally with more workers.

**Availability:** shard replicas take over on failure without interruption; Kafka loses no logs if the batch is delayed; S3 keeps the Trie safe, and servers reload from it if Redis goes down.
