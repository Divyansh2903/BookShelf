# Design a Distributed Key-Value store

<<<SECTION 1>>>
A distributed key-value store is a giant HashMap spread across hundreds of machines - storing, retrieving, and surviving failures at massive scale. Redis, Cassandra, and DynamoDB are all built on these principles. Here's the full breakdown.

### Functional requirements

put(key, value) -> store a key-value pair   
get(key) -> retrieve value by key   
delete(key) -> remove a key-value pair   
Replication -> data survives server failures   
Distribution -> data spreads across machines

### Distributing data - consistent hashing

With 1000 machines and billions of keys, you need to know instantly which machine holds a key. Consistent hashing places servers on a virtual ring and routes each key clockwise to the nearest server:

put("user:123", "Rahul") hash -> position 145 -> clockwise -> Server B at 180 stored on Server B   
get("user:123") hash -> position 145 → clockwise → Server B at 180 fetched from Server B in O(1) time

When a server goes down, only 1/N of keys remap, not everything. This is why Cassandra and Redis Cluster both use consistent hashing internally.

<<<SECTION 2>>>
### Surviving failures - replication

Data on one server is data at risk. The fix is to write to N servers simultaneously at write time, not to move data reactively after failure. Production systems use a replication factor of 3 - one primary, two replicas. If the primary goes down, replicas already have the data.

put("user:123", "Rahul") consistent hash -> Server B (primary) also write to -> Server C (replica 1) also write to -> Server D (replica 2) Server B crashes ->C and D have the data

Consistency vs availability - CAP and quorum

The CAP Theorem states that a distributed system can only guarantee two of: Consistency, Availability, and Partition Tolerance. Network partitions always happen, so Partition Tolerance is non-negotiable. The real choice is always between C and A, and it depends on the data .

This is controlled by Quorum settings:

N = replication factor = 3 W = nodes confirming a write R = nodes confirming a read W + R > N -> strong consistency guaranteed Bank transaction -> W=3, R=2 -> consistent (CP) Twitter likes → W=1, R=1 → available (AP)

Financial data needs consistency. Social data can tolerate slight staleness in exchange for availability. The interview answer is knowing which to pick and why.

Resolving conflicts - vector clocks

When two clients write to the same key simultaneously on different nodes, which write wins? Wall clock timestamps fail due to clock skew - every machine's clock drifts slightly. Vector clocks use logical counters instead:

Server A writes -> version {A:1} Server B writes -> version {B:1} Server A writes -> version {A:2} {A:2} beats {A:1} -> clear winner {A:1} vs {B:1} concurrent -> conflict, needs resolution

Conflict resolution strategies: Last Write Wins (simple, can lose data), Merge (works for counters and carts), or Push to Client (let the application decide, what Amazon's shopping cart does).

<<<SECTION 3>>>
### Detecting failures - gossip protocol

With thousands of nodes, you can't have one central server pinging everyone, that's a bottleneck and single point of failure. Instead, every node periodically exchanges health information with a few random neighbors. Bad news spreads organically across the cluster within seconds, like gossip spreading through an office.

Server A tells B -> "Server F hasn't responded in 10s" Server B tells C -> "A and I both can't reach F" Server C tells D -> same story -> entire cluster knows F is down within seconds Two stages: F silent 10s -> suspected down F silent 30s -> confirmed dead, keys rerouted

This is exactly what Cassandra uses, every node gossips with 3 random nodes every second. No central master needed.

### The data layer

### LSM Tree - local storage on each node

A distributed key-value store is itself a database. It doesn't use another DB to store data. Each node stores its key-value pairs locally using an LSM Tree (Log Structured Merge Tree), optimized for fast writes:

write("user:123", "Rahul") -> MemTable (in memory, blazing fast) -> when full, flush to SSTable (on disk) -> periodic compaction merges SSTables keeps reads fast over time

### Write-Ahead Log (WAL)

MemTable lives in memory, a crash wipes it. The WAL prevents data loss by appending every write to disk first, before touching memory. On restart, the node replays the WAL and rebuilds the MemTable. Zero data loss even on hard crashes.

write("user:123", "Rahul") 1. Append to WAL on disk (fast, sequential write) 2. Write to MemTable in memory 3. Server crashes -> MemTable gone 4. Restart -> replay WAL -> MemTable rebuilt

### Zookeeper - config and coordination

Stores the hash ring mapping, replication factor, quorum settings (W and R), and cluster membership. All nodes watch Zookeeper for real-time changes. The Gossip Protocol feeds node health status back into Zookeeper so the ring mapping stays current.

The full architecture

{{IMG:1}}

### Non-functional requirements

<<<SECTION 4>>>
### Scalability

Add nodes to the ring. Consistent hashing automatically redistributes only the affected keys. No reshuffling of the entire dataset. Scales horizontally with near-zero coordination overhead.

Latency

Writes go to MemTable first (in-memory), with a microsecond write latency. Reads query R nodes in parallel and returns the fastest valid response. WAL writes are sequential on disk — the fastest possible disk operation.

Availability  
Replication factor of 3 means the system tolerates up to 2 simultaneous node failures without data loss. Gossip Protocol detects failures within seconds, and Zookeeper updates the ring so coordinators stop routing to dead nodes automatically.
