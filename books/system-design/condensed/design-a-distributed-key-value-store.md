# Design a Distributed Key-Value store

<<<SECTION 1>>>
A distributed key-value store is a giant HashMap spread across hundreds of machines, surviving failures at massive scale. Redis, Cassandra, and DynamoDB use these principles.

### Functional requirements

put(key, value), get(key), delete(key); replication (data survives server failures); distribution (data spreads across machines).

### Distributing data - consistent hashing

With 1000 machines and billions of keys, you must instantly know which machine holds a key. **Consistent hashing** puts servers on a virtual ring; each key goes clockwise to the nearest server. E.g. "user:123" hashes to position 145 -> clockwise -> Server B at 180; put stores it there, get fetches it from there in O(1).

If a server dies, only 1/N of keys remap. Cassandra and Redis Cluster use this internally.

<<<SECTION 2>>>
### Surviving failures - replication

Write to N servers at write time instead of moving data after failure. Production uses **replication factor 3** (one primary, two replicas): put("user:123") -> Server B (primary) + C and D (replicas). B crashes -> C and D have the data.

**CAP and quorum.** A distributed system can guarantee only two of Consistency, Availability, Partition Tolerance. Partitions always happen, so the real choice is C vs A, per data type. Quorum controls it: N = replication factor = 3, W = nodes confirming a write, R = nodes confirming a read; **W + R > N** guarantees strong consistency. Bank transaction: W=3, R=2 (CP). Twitter likes: W=1, R=1 (AP). Financial data needs consistency; social data tolerates staleness. Interviews test knowing which and why.

**Vector clocks.** For simultaneous writes to one key on different nodes, wall-clock timestamps fail due to clock skew. Vector clocks use logical counters: A writes {A:1}, B writes {B:1}, A writes {A:2}. {A:2} beats {A:1}; {A:1} vs {B:1} is concurrent, a conflict. Resolution: **Last Write Wins** (simple, can lose data), **Merge** (counters, carts), or **Push to Client** (app decides; Amazon's shopping cart).

<<<SECTION 3>>>
### Detecting failures - gossip protocol

A central pinger is a bottleneck and single point of failure. Instead each node periodically swaps health info with a few random neighbors: A tells B "F silent 10s", B tells C "A and I can't reach F", C tells D, and the cluster knows within seconds. F silent 10s = suspected down; 30s = confirmed dead, keys rerouted. Cassandra: each node gossips with 3 random nodes every second, no central master.

### The data layer

### LSM Tree - local storage on each node

The store is itself a database. Each node stores pairs in an **LSM Tree** (Log Structured Merge Tree), optimized for writes: write -> MemTable (in memory) -> when full, flush to SSTable (disk) -> periodic compaction merges SSTables to keep reads fast.

### Write-Ahead Log (WAL)

A crash wipes the in-memory MemTable. The WAL appends each write to disk first: 1) append to WAL (fast, sequential), 2) write to MemTable, 3) crash loses MemTable, 4) restart replays WAL to rebuild it. Zero data loss even on hard crashes.

### Zookeeper - config and coordination

Stores the hash ring mapping, replication factor, quorum settings (W, R), and cluster membership. Nodes watch it for real-time changes; gossip feeds node health into it to keep the ring current.

**The full architecture**

{{IMG:1}}

### Non-functional requirements

<<<SECTION 4>>>
### Scalability

Add nodes to the ring; consistent hashing moves only affected keys, no full reshuffle. Horizontal scaling with near-zero coordination overhead.

**Latency:** writes hit the in-memory MemTable (microseconds); reads query R nodes in parallel and take the fastest valid response; WAL writes are sequential, the fastest disk operation.

**Availability:** replication factor 3 tolerates 2 simultaneous node failures without data loss. Gossip detects failures within seconds; Zookeeper updates the ring so coordinators stop routing to dead nodes.
