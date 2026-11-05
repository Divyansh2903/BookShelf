# Distributed Systems Part-8 (Distributed Transactions Revisited)

<<<SECTION 1>>>
Part 7 covered automatic failure detection and recovery. This part covers the **distributed transaction problem**: making one logical operation touching multiple nodes happen completely everywhere or not at all. It combines replication, consensus, ordering, and failure detection.

## Why single machine transactions don't just scale up

On one machine, a database gives ACID nearly for free: one place, one clock, one failure domain. **Atomicity** (fully commit or fully roll back) is easy with a single participant deciding.

Across nodes it is hard. If a transaction updates nodes A and B, and A commits but B crashes just before committing, half the transaction happened. No single machine can roll everything back, since the halves live on different machines that may not know each other's status at that moment.

<<<SECTION 2>>>
## Two-phase commit

**2PC** runs in two phases:

1. **Prepare:** a coordinator asks every participant if it is ready to commit. Each does the work needed to guarantee it can commit (typically writing intended changes to a durable log) and replies yes or no.
2. **Commit:** if all said yes, the coordinator tells everyone to commit. If any said no or didn't respond, it tells everyone to abort. Having promised in phase one, participants must follow a commit instruction even if they briefly lose contact with the coordinator.

This gives atomicity, but if the coordinator crashes after phase one and before sending its decision, participants are stuck. They promised to commit so can't abort unilaterally, but don't know the decision. They wait, holding locks, until the coordinator recovers. This **blocking** is 2PC's biggest criticism, a direct result of depending on one coordinator.

<<<SECTION 3>>>
## Three-phase commit

**3PC** fixes blocking by adding a **pre-commit** phase between prepare and commit. It tells participants a commit decision has been made without asking them to commit yet. If the coordinator then fails, participants can check with each other; if any received pre-commit, they safely conclude the decision was commit and proceed without the coordinator.

It is rarely used in practice:
- It assumes a synchronous network with known timeout bounds, unrealistic (Part 1). If violated, 3PC can produce incorrect results, not just block.
- It adds a network round trip to every transaction.

Most systems prefer 2PC and handle its rare blocking via operational tooling or timeouts.

<<<SECTION 4>>>
## Percolator-style transactions

Google's **Percolator**, built for incremental processing on Bigtable, influenced how several modern distributed databases implement transactions.

It uses a 2PC-style protocol layered on **multi-version storage** rather than plain locks. Data has multiple timestamped versions, and a transaction reads the version valid at its start time, not the latest at read time. So it gets a consistent view across all nodes even while other transactions modify the same data.

One cell in the transaction is the **primary**, recording the final commit/abort decision, like the 2PC coordinator's decision but persisted as data rather than held in coordinator memory. If a client crashes mid-transaction, another client that finds the incomplete transaction checks the primary to complete or clean it up instead of blocking forever. This addresses 2PC's blocking weakness, though differently from 3PC.

<<<SECTION 5>>>
## Distributed snapshot isolation and Spanner

Google **Spanner** relies on hardware most organizations lack: tightly synchronized physical clocks in every data center via GPS receivers and atomic clocks, through **TrueTime**.

Part 2 noted physical clocks are dangerous for ordering due to drift and uncertainty. TrueTime exposes the uncertainty explicitly: it returns a range guaranteed to contain the actual time. Spanner waits out that uncertainty window before committing (**commit wait**). Any transaction that commits after another has finished committing in real time gets a later timestamp. This is **external consistency**, stronger than linearizability (Part 4), since it holds across the whole global system rather than within one replicated group.

This enables strongly consistent distributed transactions at global scale, previously seen as impractical. The cost is GPS and atomic-clock hardware in every data center, so the approach has stayed within Google and its cloud offering.

<<<SECTION 6>>>
## A quicker path: sagas

2PC, 3PC, and Percolator all assume you need atomic all-or-nothing transactions across nodes. Many systems avoid that with the **saga pattern**: a sequence of local transactions, each with a compensating action to undo it if a later step fails. It trades strict atomicity for availability and simplicity (covered in the microservices series). Consider it when 2PC-style coordination is more machinery than the problem needs.

## Case Studies

The series covered impossibility results, time and ordering, replication, consistency, consensus, partitioning, failure detection, and distributed transactions. Real systems combine several of these; the following systems show how.

<<<SECTION 7>>>
## Dynamo

Amazon's **Dynamo** (2007 paper) served Amazon's shopping cart, where availability had to beat consistency: refusing an add-to-cart over a network hiccup is worse than occasionally showing a slightly stale cart.

- Leaderless, with quorum reads and writes (Part 3).
- Partitioned via consistent hashing with virtual nodes for load balance (Part 6).
- Vector clocks (Part 2) detect conflicts from concurrent writes; the original design sometimes pushed conflicting versions to the application to resolve (the shopping cart merge from Part 2).
- Read repair and hinted handoff (Part 3) keep replicas converging without a leader.

<<<SECTION 8>>>
## Cassandra

Borrows Dynamo's leaderless architecture, consistent hashing, and quorum reads/writes, but uses a data model closer to Bigtable's: column families instead of simple key-value.

It relies on gossip (Part 7) for membership and failure detection, using a **phi accrual failure detector** instead of a fixed heartbeat timeout, adapting to each node's normal network behavior rather than one blunt threshold across a large, geographically spread cluster.

## Spanner

Spanner combines many pieces of the series:
- **Paxos** (Part 5) replicates each partition across nodes for strong consistency within each replica group.
- **Partitioning** (Part 6): large tables split into ranges distributed and rebalanced across the cluster.
- **TrueTime and commit wait** on top give external consistency for multi-partition transactions, which no single piece provides alone.

It chose strong consistency deliberately, accepting latency and infrastructure cost, because use cases like Google's advertising systems need correctness that eventual consistency can't give.

<<<SECTION 9>>>
## Kafka

Not a traditional database, but its replication protocol is instructive. Each topic partition has one leader broker and several followers replicating its log, like single-leader replication (Part 3).

The **in-sync replica set** (ISR) is the followers caught up closely enough to be safe. A write commits only once every ISR member acknowledges it, not just the leader: a configurable durability vs. latency tradeoff in the spirit of PACELC (Part 1). On leader failure, the new leader is elected only from the ISR, so a badly lagging replica can't become leader and silently lose committed data. Raft enforces a similar rule on leader eligibility (Part 5).

<<<SECTION 10>>>
## etcd and Raft in practice

**etcd** is a clear real-world Raft example: a small, strongly consistent key-value store that Kubernetes uses to store all cluster state (which nodes exist, what is scheduled where, etc.).

With Raft, every write goes through an elected leader and commits only once a majority of nodes have it in their log, giving linearizability (Part 4). That's why Kubernetes uses etcd rather than a faster, weaker system: briefly inconsistent cluster state could schedule a workload twice or lose track of a node, far worse than consensus latency.

## Bringing it all together

None of these five systems invented a new theoretical idea. Each combined the same building blocks (replication strategies, consistency models, consensus, partitioning, failure detection) to suit its problem. Dynamo and Cassandra chose availability and leaderless replication because they can tolerate eventual consistency. Spanner and etcd chose consensus and stronger consistency because they cannot.

The central lesson of the series: there is no universally best distributed design, only well-understood tradeoffs. The skill is recognizing which tradeoff a problem calls for rather than reaching for the most sophisticated or familiar tool by habit.

This concludes the eight-part series: impossibility results, time, replication, consistency, consensus, partitioning, failure detection, transactions, and how real systems combine them.
