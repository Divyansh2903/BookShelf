# Distributed Systems Part-8 (Distributed Transactions Revisited)

<<<SECTION 1>>>
In Part 7, we looked at how systems detect failure and recover from it automatically. Now we come back to a problem that failure makes especially difficult, making sure a single logical operation that touches multiple nodes either happens completely everywhere, or does not happen at all. This is the distributed transaction problem, and it pulls together almost everything covered so far in this series, replication, consensus, ordering, and failure detection, into one final coordination challenge.

## Why single machine transactions don't just scale up

On a single machine, a database gives you ACID guarantees more or less for free, since everything lives in one place with one clock and one failure domain. Atomicity, meaning a transaction either fully commits or fully rolls back, is easy to implement when there is only one participant that needs to make that decision.

The moment a transaction spans multiple nodes, atomicity becomes a genuinely hard problem. Say a transaction needs to update data on node A and node B. What happens if node A commits its half successfully, but node B crashes right before committing its half? Now the system is in an inconsistent state: half the transaction happened, and half did not, and there is no single machine that can simply roll everything back on its own, since the two halves live on two different machines that may not even be aware of each other's status at that exact moment.

<<<SECTION 2>>>
## Two-phase commit

Two-phase commit, usually shortened to 2PC, is the classic answer to this problem, and it works roughly the way its name suggests, in two distinct phases.

In the first phase, called the prepare phase, a coordinator node asks every participant in the transaction whether it is ready to commit. Each participant does whatever work is needed to guarantee it can commit if asked, typically writing its intended changes to a durable log, and then replies either yes or no.

In the second phase, called the commit phase, the coordinator looks at the responses. If every participant said yes, the coordinator tells everyone to commit. If even one participant said no, or failed to respond, the coordinator tells everyone to abort instead. Because every participant already promised in phase one that it could commit if asked, once the coordinator sends the commit instruction, every participant is obligated to follow through, even if it briefly loses contact with the coordinator afterwards.

This gives you the atomicity guarantee you want: either everyone commits, or everyone aborts, but it comes with a serious weakness. If the coordinator crashes after phase one but before sending its final decision in phase two, participants are left stuck. They have already promised they can commit, so they cannot unilaterally abort, but they also do not know what the coordinator actually decided. They are forced to sit and wait, holding locks on their data, until the coordinator recovers and tells them what happened. This blocking behaviour is the single biggest criticism of 2PC, and it is a direct consequence of relying on one coordinator whose failure can freeze the entire transaction.

<<<SECTION 3>>>
## Three-phase commit

Three-phase commit, or 3PC, was designed specifically to fix this blocking problem by adding an extra phase between prepare and commit, giving participants enough information to make progress on their own even if the coordinator disappears partway through.

The added phase, usually called pre-commit, tells participants that a decision to commit has been made, without actually asking them to commit yet. This extra step means that if the coordinator fails after this point, participants can look at each other, see that at least one of them received the pre-commit message, and safely conclude that the decision was to commit, allowing them to proceed without the coordinator's involvement.

In practice, 3PC is rarely used in real systems, for two main reasons. First, it assumes a synchronous network with known timeout bounds, an assumption we already saw is unrealistic back in Part 1, and if that assumption is violated, 3PC can actually produce incorrect results rather than just blocking. Second, it adds an extra network round trip to every single transaction, which is a real cost for something that is meant to be used constantly. Most real systems have decided that avoiding this cost, and instead handling the rare blocking scenario from 2PC through operational tooling or timeouts, is a better tradeoff than paying for 3PC on every transaction.

<<<SECTION 4>>>
## Percolator-style transactions

Google's Percolator system, built originally to run incremental processing on top of Bigtable, took a different approach that has since influenced several other systems, including parts of how modern distributed databases implement transactions.

Percolator uses a two phase commit style protocol, but layers it on top of multi-version storage rather than plain locks. Every piece of data can have multiple timestamped versions, and a transaction reads the version that was valid at the time the transaction started, rather than whatever the latest value happens to be at read time. This means a transaction gets a consistent view of the data across every node it touches, even if other transactions are actively modifying that same data concurrently.

Percolator designates one cell involved in a transaction as the primary, and uses it to record the ultimate commit or abort decision for the whole transaction, similar in spirit to the coordinator's decision in 2PC, but persisted as actual data rather than living only in a coordinator's memory. If a client crashes partway through a transaction, another client that later stumbles onto the incomplete transaction can look at the primary cell and figure out whether to complete it or clean it up, rather than blocking forever, which addresses the same blocking weakness that plain 2PC suffers from, though not identically to how 3PC attempts to solve it.

<<<SECTION 5>>>
## Distributed snapshot isolation and Spanner

Google Spanner takes a fundamentally different approach, made possible by hardware most organizations do not have access to: tightly synchronized physical clocks across every data center, using GPS receivers and atomic clocks, through a system called TrueTime.

Recall from Part 2 that we said trusting physical clocks for ordering is dangerous because of drift and uncertainty. TrueTime does not eliminate that uncertainty, but it does something clever: it exposes the uncertainty explicitly. Instead of returning a single timestamp, TrueTime returns a range, guaranteed to contain the actual current time. Spanner then simply waits out the width of that uncertainty window before committing a transaction, a technique called commit wait. This guarantees that any transaction which commits after another transaction has actually finished committing, in real time, will be assigned a later timestamp, giving Spanner external consistency, a guarantee even stronger than the linearizability we discussed in Part 4, since it holds across the entire globally distributed system rather than just within a single replicated group.

This lets Spanner offer distributed transactions with strong consistency at a global scale, something that seemed impractical before TrueTime. The tradeoff is the literal cost of the infrastructure, GPS and atomic clock hardware in every data center, which is why this specific approach has largely stayed inside Google and its cloud offering, rather than becoming a general technique every team can casually adopt.

<<<SECTION 6>>>
## A quicker path: sagas

It is worth remembering that 2PC, 3PC, and Percolator-style protocols all assume you actually need atomic, all or nothing transactions across nodes. Many real systems avoid this requirement entirely by using the saga pattern instead, breaking a larger operation into a sequence of smaller local transactions, each with a corresponding compensating action that can undo it if a later step fails. This trades strict atomicity for availability and simplicity, and it was covered in detail in the microservices series, so we will not repeat it here, but it is worth remembering as the alternative path whenever 2PC-style coordination starts to feel like more machinery than a problem actually needs.

## Case Studies

Across this series, we have covered the theory piece by piece, impossibility results, time and ordering, replication, consistency, consensus, partitioning, failure detection, and distributed transactions. Real systems do not use these ideas in isolation; they combine several of them at once to solve a specific set of problems. This final part looks at a handful of well-known systems and shows how the pieces actually fit together in practice.

<<<SECTION 7>>>
## Dynamo

Amazon's Dynamo, described in a widely read 2007 paper, was built to solve a very specific problem for Amazon's shopping cart: availability had to win over consistency, since a shopping cart that refuses to accept an add-to-cart request because of a network hiccup is a worse outcome than one that occasionally shows a slightly stale cart.

Dynamo is leaderless, using the quorum-based reads and writes we covered in Part 3, with data partitioned across nodes using consistent hashing from Part 6, including virtual nodes to keep load balanced. When replicas disagree because of concurrent writes, Dynamo uses vector clocks from Part 2 to detect the conflict, and in the original design, sometimes pushes the conflicting versions back to the application to resolve, exactly the kind of shopping cart merge behaviour we mentioned back in Part 2. Read repair and hinted handoff, also from Part 3, keep replicas converging over time without needing a leader to coordinate any of it.

<<<SECTION 8>>>
## Cassandra

Cassandra borrowed heavily from Dynamo's design, using the same leaderless architecture, consistent hashing, and quorum based reads and writes, but combined it with a data model closer to Bigtable's, organizing data into column families rather than Dynamo's simpler key value structure.

Cassandra also relies heavily on gossip, from Part 7, for cluster membership and failure detection, and specifically uses a phi accrual failure detector rather than a simple fixed heartbeat timeout, letting it adapt to each node's own normal network behavior rather than applying one blunt threshold across a potentially large and geographically spread out cluster.

## Spanner

We already covered Spanner's approach to distributed transactions in Part 8, but it is worth restating how many pieces of this series come together in a single system. Spanner uses Paxos, from Part 5, to replicate each partition of data across multiple nodes, giving it strong consistency within each replica group. It partitions data much like we described in Part 6, splitting large tables into smaller ranges that get distributed and rebalanced across the cluster. And it layers TrueTime and commit wait on top of all of that to achieve external consistency for transactions that span multiple partitions, something none of the individual pieces alone would be enough to provide.

Spanner is a good example of a system that chose strong consistency deliberately, accepting the latency and infrastructure cost, because its use cases, things like Google's advertising systems, genuinely needed correctness guarantees that eventual consistency could not offer.

<<<SECTION 9>>>
## Kafka

Kafka is not a database in the traditional sense, but its replication protocol is a useful case study in its own right. Each partition of a Kafka topic has a single leader broker and several follower brokers that replicate its log, similar in structure to the single-leader replication we discussed in Part 3.

Kafka uses a concept called the in-sync replica set, the group of followers that are currently caught up closely enough with the leader to be considered safe. A write is only considered committed once it has been acknowledged by every replica in this set, not just the leader, which is a configurable durability versus latency tradeoff very much in the spirit of PACELC from Part 1. If the leader fails, a new leader is elected, but only from among the in-sync replica set, which prevents a replica that was badly behind from suddenly becoming leader and silently losing recently committed data, the same kind of safety rule that Raft enforces around which node is allowed to become leader, which we discussed in Part 5.

<<<SECTION 10>>>
## etcd and Raft in practice

We spent time on Raft's design in Part 5, and etcd is one of the clearest real world examples of it in action. etcd is a small, strongly consistent key value store, and it is the component Kubernetes uses under the hood to store all of its cluster state, which nodes exist, what is scheduled where, and so on.

Because etcd uses Raft, every write goes through an elected leader and is only considered committed once a majority of nodes have it in their log, giving etcd the linearizability we discussed in Part 4. This is exactly why etcd, rather than a faster but weaker system, was chosen for something like Kubernetes cluster state, since briefly inconsistent cluster state could mean scheduling the same workload twice, or losing track of a node entirely, problems far worse than the extra latency consensus requires.

## Bringing it all together

Looking back across these five systems, a pattern becomes clear. None of them invented a completely new theoretical idea. They combined the same building blocks covered across this series, replication strategies, consistency models, consensus algorithms, partitioning schemes, and failure detection mechanisms, in a specific combination suited to their particular problem. Dynamo and Cassandra chose availability and leaderless replication because their use cases could tolerate eventual consistency. Spanner and etcd chose consensus and stronger consistency because their use cases genuinely could not.

This is really the central lesson of the entire series. There is no universally best distributed system design, only a set of well understood tradeoffs, and the skill worth building is recognizing which tradeoff a given problem actually calls for, rather than reaching for the most sophisticated or most familiar tool out of habit.

That wraps up this series on distributed systems, from the impossibility results that shape everything else, through time, replication, consistency, consensus, partitioning, failure detection, and transactions, and finally to how real systems put all of it together. Thanks for following along through all eight parts.
