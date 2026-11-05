# Distributed Systems Part-6 (Partitioning and Sharding)

<<<SECTION 1>>>
Part 5 covered consensus, which lets a small group of nodes agree on a value or a log of operations. Consensus works for coordination but doesn't scale to storing huge data on a few nodes. Eventually the dataset or write throughput is too big for one machine. This part covers splitting data across many nodes so no single machine holds all of it or serves all its traffic.

## Why partition data at all

Replication (Part 3) keeps copies of the same data on multiple nodes for availability and durability. **Partitioning** solves a different problem: it splits the dataset into pieces (**partitions** or **shards**) spread across nodes, so each node stores and serves only a fraction.

Real systems use both: each partition is replicated for durability, and the dataset is split across many partitions for scale. Picture a grid: partitions on one axis, replicas of each on the other.

The core question: given a piece of data, which node should it live on, and how do you answer quickly, consistently, and without **hotspots** where one node does far more work than others?

<<<SECTION 2>>>
## Range partitioning

Pick a key per record, sort all key values, and divide the sorted range into contiguous chunks, one per partition. E.g. user data by signup date: one partition for January, another for February, and so on.

**Advantage:** range queries ("everything between these two keys") are efficient, since the data likely sits on a few adjacent partitions.

**Downside:** when key order correlates with access patterns. Partitioned by signup date, all of today's writes hit one partition while others sit idle. This **hot partition** puts you back to one machine being the bottleneck. Bigtable and early HBase use range partitioning and handle this through careful key design or automatic splitting of overloaded ranges.

<<<SECTION 3>>>
## Hash partitioning

Run the key through a hash function and use the output to choose the partition. A good hash scatters similar keys to very different values, so load spreads evenly almost by construction; today's signups land on essentially random partitions.

**Trade-off:** you lose efficient range queries. Keys are scattered by hash, so "everything between these two keys" must check every partition. Some systems, like Cassandra, combine both: hash on part of the key to spread load, and keep a range structure within each partition for efficient queries on the rest of the key.

<<<SECTION 4>>>
## Consistent hashing

Plain hashing (e.g. hash(key) modulo ten) breaks when nodes change: adding or removing a node changes the bucket count, which reassigns almost every key. Adding one node to a ten-node cluster could force moving nearly all data.

Consistent hashing fixes this. Picture a circle (the **hash ring**); hash both keys and nodes onto it. Each key belongs to the next node clockwise from its position.

- Adding a node only affects keys between the new node and its nearest neighbour.
- Removing a node only affects its keys, which move to the next node clockwise.

So scaling moves only a small, proportional slice of data instead of reshuffling everything.

Plain consistent hashing can still leave some nodes with more data by chance. Real systems use **virtual nodes**: each physical node gets many positions on the ring, so imbalances average out. Cassandra and Dynamo both do this.

<<<SECTION 5>>>
## Rebalancing

Data doesn't stay balanced: nodes are added for capacity, removed after failures, and access patterns shift. **Rebalancing** moves data between nodes to restore balance. Good rebalancing should:

- Move as little data as possible, ideally only what must move for the new node set.
- Keep the system available and responsive throughout, with no pause in service.
- Be automatic where possible; manual shuffling doesn't scale on a large cluster.

Consistent hashing pays off here: since adding/removing a node affects only a small, well-defined slice of keys, rebalancing is a bounded, predictable operation rather than a full reshuffle.

<<<SECTION 6>>>
## Hot partitions and secondary indexes

Hash partitioning doesn't remove hotspots from skewed access. A celebrity account read more than everyone else combined is still one key on one partition. The fix is usually application-level, e.g. split the hot key into multiple subkeys and combine results at read time; no generic scheme can solve real-world usage skew.

**Secondary indexes** add complexity. A primary key identifies the partition, but a secondary index (e.g. users by email instead of user ID) doesn't map onto the same scheme. Two approaches:

- **Local secondary index:** stored alongside the data on each partition. Writes are fast, but a lookup by that field must check every partition (like the range query problem).
- **Global secondary index:** partitioned separately, by the indexed field. Lookups are fast, but one write may update two partitions (data and index entry), reintroducing coordination challenges from earlier parts of this series.
