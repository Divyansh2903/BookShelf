# Distributed Systems Part-6 (Partitioning and Sharding)

<<<SECTION 1>>>
In Part 5, we looked at consensus, the machinery that lets a small group of nodes agree on a single value or a single log of operations. Consensus works well for coordination, but it does not scale to storing huge amounts of data on a handful of nodes. At some point, your dataset simply gets too big, or your write throughput gets too high, for any single machine to handle alone. That is the problem this part is about, splitting data across many nodes so that no single machine has to hold all of it or serve all the traffic for it.

## Why partition data at all

Replication, which we covered in Part 3, solves availability and durability by keeping copies of the same data on multiple nodes. Partitioning solves a different problem entirely. It splits your dataset into smaller pieces, called partitions or shards, and spreads those pieces across multiple nodes, so each node only has to store and serve a fraction of the total data.

In most real systems, replication and partitioning are used together. Each partition is itself replicated across multiple nodes for durability, and the total dataset is split across many such partitions for scale. Think of a large cluster as a grid, partitions along one axis, replicas of each partition along the other. Understanding the two separately makes it much easier to reason about the whole picture.

The core question in partitioning is simple to state and surprisingly hard to answer well. Given a piece of data, which node should it live on, and how do you answer that question quickly, consistently, and without creating hotspots where one node ends up doing far more work than the others?

<<<SECTION 2>>>
## Range partitioning

The most intuitive approach is range partitioning. You pick a key for each record, sort all possible key values, and divide that sorted range into contiguous chunks, one per partition. A system storing user data by signup date might give one partition to January, another to February, and so on.

Range partitioning has a big advantage for certain workloads. Range queries, like "give me everything between these two keys," are efficient because the relevant data is likely to sit on a small number of adjacent partitions rather than being scattered across the entire cluster.

The downside shows up when your key has some kind of natural order that correlates with access patterns. If you partition by signup date and today's users are the ones actually writing data right now, all of today's writes land on a single partition, while every other partition sits idle. This is called a hot partition, and it defeats the entire purpose of partitioning, since you are back to one machine being a bottleneck, just with extra steps. Systems like Bigtable and early versions of HBase use range partitioning and have to deal with this problem directly, often through careful key design or automatic splitting of overloaded ranges.

<<<SECTION 3>>>
## Hash partitioning

Hash partitioning takes a different approach. Instead of using the key directly to decide placement, you run the key through a hash function, and use the hash output to decide which partition it belongs to.

Because a good hash function scatters similar keys across very different output values, this approach spreads load evenly across partitions almost by construction. The user signup problem from before mostly disappears, since today's signups get hashed to essentially random partitions instead of all landing in the same place.

The tradeoff is that you lose the range query advantage. Since keys are scattered based on their hash rather than their actual value, a query like "give me everything between these two keys" now has to check every single partition, because there is no way to know in advance which partitions might contain relevant data. This is a real cost, and it is why some systems, like Cassandra, let you combine both approaches, hashing on part of the key to spread load, while keeping a range structure within each partition for efficient queries on the rest of the key.

<<<SECTION 4>>>
## Consistent hashing

Plain hash partitioning has a problem of its own. If you hash keys into, say, ten buckets using something simple like hash of the key modulo ten, adding or removing a node changes the number of buckets, which changes almost every single key's assigned bucket at once. That means adding one node to a ten-node cluster could force you to move nearly all your data around, which is obviously not something you want happening every time you scale up.

Consistent hashing solves this specific problem. Instead of hashing keys into a fixed number of buckets, you imagine a circle, usually called a hash ring, and hash both the keys and the nodes onto positions on that same ring. Each key belongs to the next node found by moving clockwise around the ring from the key's position.

The benefit becomes clear when a node joins or leaves. Adding a new node only affects the keys that fall between the new node and its nearest neighbour on the ring, not the entire dataset. Removing a node only affects the keys that were assigned to it, which now get picked up by the next node clockwise. This means scaling the cluster up or down only requires moving a small, proportional slice of the data, instead of reshuffling everything.

In practice, plain consistent hashing can still leave some nodes with more data than others, purely by chance in how the hash values land on the ring. Real systems fix this with virtual nodes, where each physical node is given many positions on the ring instead of just one. This smooths out the distribution, since imbalances from any single position tend to average out across the many positions each node holds. Both Cassandra and Dynamo use this virtual node approach for exactly this reason.

<<<SECTION 5>>>
## Rebalancing

Even with a good partitioning scheme, data does not stay perfectly balanced forever. Nodes get added for more capacity, nodes get removed after failures, and access patterns shift over time in ways that were never intended when the scheme was first chosen. Rebalancing is the process of moving data between nodes to restore a reasonable balance.

Good rebalancing has a few properties worth aiming for. It should move as little data as possible for a given change, ideally just the data that genuinely needs to move to reflect the new set of nodes. It should keep the system available and responsive while the rebalancing is happening, rather than requiring a pause in service. And it should be automatic where possible, since manually shuffling data around on a large cluster does not scale as an operational practice.

This is exactly where the properties of consistent hashing pay off. Because adding or removing a node only affects a small, well-defined slice of keys, rebalancing after a scaling event tends to be a bounded, predictable operation, rather than a full reshuffle of the entire dataset.

<<<SECTION 6>>>
## Hot partitions and secondary indexes

Even hash partitioning does not fully eliminate hotspots. If your access pattern is skewed, for example, one celebrity account on a social platform being read far more often than everyone else combined, that single key still lives on a single partition, no matter how well distributed the rest of your keys are. Solving this usually requires application-level tricks, like splitting a single hot key into multiple subkeys and combining the results at read time, since no generic partitioning scheme can fully solve a problem caused by real-world skew in how people actually use the system.

Secondary indexes add another layer of complexity on top of all this. A primary key tells you exactly which partition to look at, but a secondary index, like looking up users by email instead of by user ID, does not map cleanly onto the same partitioning scheme. Systems generally solve this in one of two ways. A local secondary index lives alongside the data on each partition, which makes writes fast but means a lookup by that secondary field has to check every single partition, similar to the range query problem we saw earlier. A global secondary index is partitioned separately from the primary data, based on the indexed field itself, which makes lookups fast but means a single write might now need to update two different partitions: the one holding the actual data and the one holding the index entry, which reintroduces some of the coordination challenges from earlier parts of this series.

### That's all for part 6, folks...Cheers!!
