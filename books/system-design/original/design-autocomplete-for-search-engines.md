# Design Autocomplete For Search Engines

<<<SECTION 1>>>
Every time you type into Google Search, autocomplete suggestions appear before you even finish your word. Designing this system is one of the most latency-sensitive and data-heavy problems in system design. Let's go, legends.

**Functional requirements**  
1. Suggest the most searched words and sentences based on the prefix typed so far  
2. Record every search and update suggestion frequencies over time

### Non-functional requirements

Latency is the most critical one here. Suggestions must appear as the user is still typing, which means every keystroke triggers a query, and the response must come back in under 100ms, ideally under 50ms. Scalability and availability follow from that constraint.

The core data structure is **Trie**

A Trie is a prefix tree where each node represents a character. Traversing from the root spells out a word, and every node branches into all possible next characters.

a

|

p

|

p

/ \

l   s

|   |

e  tore

(apple) (app store)

Type "app" and you're already at the "app" node. Every child beneath it is a valid suggestion. Prefix lookups are instant i.e. O(length of prefix) time, regardless of how many words are in the Trie.

Ranking suggestions == frequency + priority queue

There could be thousands of words starting with "app." You only show 5-10. The way to rank them is by storing search frequency directly inside each Trie node, every node keeps a precomputed list of the top N most searched completions reachable from it.

"app" node -> top 5:

("apple",       9M searches)

("app store",   7M searches)

("application", 4M searches)

("appetizer",   1M searches)

("apparel",    800k searches)

A priority queue sorted by frequency descending ensures the most searched completions always bubble to the top. These are precomputed and cached at each node so retrieval requires zero extra computation at query time.

The update problem is **"why real-time writes don't work?"**

Google handles 8.5 billion searches per day, roughly 100,000 per second. If every search immediately updated the Trie in memory, you'd have 100,000 concurrent writes hammering your fastest asset while millions of users are reading from it simultaneously. Race conditions, slowdowns, chaos.

The fix is batch processing. You don't update the Trie instantly. You collect searches continuously and rebuild the Trie in bulk every few hours.

User searches "apple"

↓

Logged into Kafka instantly (async, fast)

↓

Kafka accumulates millions of searches

↓

Batch job runs every few hours (Apache Spark)

↓

Recomputes frequencies from search logs

↓

Rebuilds Trie → pushes to Redis + S3

↓

Trie servers reload fresh Trie

The Trie users query is always a snapshot, a few hours old. Nobody notices. This is called eventual consistency. The system doesn't need to be perfectly up to date every millisecond, it just needs to get there eventually.

Splitting the Trie - sharding

The Trie for all possible English prefixes is massive It can't fit on one machine. You split it across multiple servers by alphabetical prefix range, a technique called Trie sharding.

But you can't split purely alphabetically, as not all letters carry equal traffic. Searches starting with "s" are enormous (sports, shopping, spotify, samsung...) while "x" is almost nothing. So you shard based on traffic load:

Server 1 → a, b, c, d, e, f, g, h, i, j, k, l, m

Server 2 → n, o, p, q, r

Server 3 → s           ← "s" alone needs its own server

Server 4 → t, u, v, w, x, y, z

A Zookeeper coordination service maintains the mapping of which prefix range lives on which server. Every request hits Zookeeper first, gets directed to the right shard, and the shard returns suggestions instantly.

<<<SECTION 2>>>
### The database layer - two stores

Search log DB (Cassandra)

Every search gets logged here - searchID, userID, query, timestamp, location. This feeds the batch job. Cassandra is the right choice because it's built for massive write throughput and scales horizontally with ease. Billions of writes per day is its comfort zone.

Trie store (S3 + Redis)

After the batch job rebuilds the Trie, it needs to be persisted so servers can reload it on restart. The batch job serializes the Trie and dumps it to S3 as the source of truth. Each shard server then loads its portion into Redis for in-memory serving.

S3 for persistence, Redis for speed. Both together give you durability without sacrificing latency.

### The full architecture

User types "app"

↓

API Gateway

↓

Zookeeper → "a" prefix lives on Server 1

↓

Server 1 → queries Redis Trie shard for "app"

↓

Returns top 5 suggestions in <50ms

↓

Meanwhile — search logged to Kafka

↓

Batch job (Spark) every few hours

→ reads Cassandra logs

→ recomputes frequencies

→ rebuilds Trie

→ dumps to S3 + pushes to Redis

### Non-functional requirements

<<<SECTION 3>>>
### Latency

Every layer is optimized for speed. Trie in Redis (in-memory), top suggestions precomputed at each node, Zookeeper routing in microseconds. Target: under 50ms end to end per keystroke.

Scalability

Trie sharding distributes read load across servers. Cassandra handles write load for search logs. The batch pipeline scales horizontally via Spark, throw more workers at it to process faster.

Availability

Each Trie shard has replicas. If one goes down, a replica takes over with no interruption. Kafka ensures no search log is lost even if the batch job is delayed. S3 ensures the Trie is never permanently lost even if Redis goes down, servers reload from S3 on restart.  
  
That's all folks...Cheers!
