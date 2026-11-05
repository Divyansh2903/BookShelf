# Distributed Systems Part-5 (Consensus Algorithms)

<<<SECTION 1>>>
In Part 4, we talked about linearizability as the strongest consistency guarantee a system can offer, and mentioned that providing it requires real coordination between nodes. This part is about what that coordination actually looks like in practice. Consensus algorithms are the machinery that lets a group of unreliable nodes, running on an unreliable network, agree on a single value or a single sequence of operations, even when some of them crash along the way.

This is also where the FLP impossibility result from Part 1 comes back into the picture. FLP tells us that perfect, guaranteed consensus is impossible in a fully asynchronous system if even one node can fail. Every algorithm in this part is a practical way of living with that limitation, usually by leaning on timeouts and the partially synchronous model we discussed back then, rather than trying to defeat it outright.

## What consensus actually means

Before getting into specific algorithms, it helps to be precise about what problem they are solving. Consensus means getting a group of nodes to agree on one single value, even if multiple nodes propose different values at the same time, and even if some nodes crash or messages get delayed along the way.

This sounds abstract, but it shows up constantly in real systems. Electing a leader is a consensus problem, since every node needs to agree on who the leader is. Committing a transaction across multiple nodes is a consensus problem. Appending an entry to a replicated log, the kind of log a database uses to keep replicas in sync, is a consensus problem too, since every replica needs to agree on the exact sequence of entries.

A correct consensus algorithm needs to guarantee two things. Safety, meaning nodes never agree on two different values for the same decision, no matter what fails. And liveness, meaning the system eventually makes progress and actually reaches a decision, as long as enough nodes are healthy and can talk to each other. Safety is usually the easier property to guarantee. Liveness is where FLP bites, which is why every practical algorithm accepts some risk of temporarily stalling rather than promising it can always make progress no matter what.

<<<SECTION 2>>>
## Paxos

Paxos, introduced by Leslie Lamport in the late 1980s, was the first widely studied algorithm to solve this problem rigorously. It has a reputation for being difficult to understand, and that reputation is largely deserved, but the core idea is not as scary as it sounds.

Paxos works in rounds, and involves nodes playing one or more of three roles: proposers, who suggest values, acceptors, who vote on proposed values, and learners, who find out what value was chosen. A single node can play multiple roles at once.

Each round happens in two phases. In the first phase, a proposer picks a round number higher than any it has used before, and asks a majority of acceptors if they will promise to consider a proposal with that number. If a majority agrees, the proposer moves to the second phase, where it actually proposes a value, and acceptors either accept it or reject it depending on what they have already promised. A value is considered chosen once a majority of acceptors have accepted it, which is why Paxos, like most consensus algorithms, needs a majority of nodes to be alive and reachable to make progress at all.

The tricky part of Paxos, and the reason it has a reputation for being hard to implement correctly, is handling competing proposers, retries, and edge cases around crashes mid round, all while still preserving safety. Basic Paxos also only agrees on a single value at a time, so real systems use a variant called Multi-Paxos, which streamlines the process for agreeing on a long sequence of values, like the entries in a replicated log, without repeating the full two phase process for every single entry.

<<<SECTION 3>>>
## Raft

Raft was designed specifically to be easier to understand and implement correctly than Paxos, without sacrificing the same safety guarantees. It has become extremely popular in real systems precisely because of this, showing up in etcd, Consul, and CockroachDB, among others.

Raft splits the problem into three separate, more approachable pieces: leader election, log replication, and safety.

Leader election works through randomized timeouts. Every node starts as a follower. If a follower does not hear from a leader within a random amount of time, it assumes the leader is gone, becomes a candidate, and requests votes from the other nodes. Whichever candidate gets votes from a majority becomes the new leader. Randomizing the timeout is a small but important detail, since it makes it unlikely that two nodes become candidates at exactly the same time and split the vote repeatedly.

Log replication is the leader's job once elected. All client requests go through the leader, which appends them to its own log and then replicates them to followers. An entry is considered committed, meaning it is safe and will not be lost, once a majority of nodes have it in their log. Followers apply committed entries to their own state in the same order the leader did, which is what keeps replicas consistent with each other.

Safety in Raft comes from a set of rules around exactly which node is allowed to become leader. Roughly speaking, a node can only become leader if its log is at least as up-to-date as a majority of the cluster, which prevents a node with stale or missing data from ever overwriting more recent, committed entries.

The reason Raft feels more approachable than Paxos is that it maps very directly onto an actual implementation. Where Paxos is often described as an abstract protocol, Raft was designed from the start with real systems and real logs in mind, which is a big part of why it has become the default choice for new systems that need consensus.

<<<SECTION 4>>>
## ZAB

ZAB, short for ZooKeeper Atomic Broadcast, is the consensus protocol behind Apache ZooKeeper, one of the older and still widely used coordination services in distributed systems.

ZAB is conceptually similar to Raft in that it relies on a single leader that proposes updates, and followers that acknowledge and apply them once a majority has agreed. Where ZAB differs is that it was designed specifically around ZooKeeper's use case, atomic broadcast of state changes, meaning every node applies the exact same sequence of updates in the exact same order, which is exactly the kind of primitive tools like distributed locks and configuration management need underneath them.

ZooKeeper predates Raft, and part of the reason Raft exists is that Diego Ongaro and John Ousterhout, its creators, wanted to build something with ZAB and Paxos's guarantees but with a specification that was actually easy to reason about and teach. That said, ZAB has been running in production for a very long time, and plenty of real systems still depend on it today through ZooKeeper directly.

<<<SECTION 5>>>
## Why consensus is expensive

It is worth being honest about the cost of all this. Every consensus algorithm in this part requires a round trip to a majority of nodes before anything can be considered official, whether that is electing a leader or committing a log entry. That majority requirement is not a detail, it is the actual mechanism that provides safety, since any two majorities in a cluster are guaranteed to overlap by at least one node, which is what prevents the system from making two contradictory decisions at once.

This is exactly why consensus is reserved for the operations that genuinely need it, like leader election or committing critical metadata, rather than being used for every single read and write an application makes. Using it everywhere would mean paying a majority round trip on every operation, which defeats the point of having fast, highly available systems in the first place. Most real architectures use consensus sparingly and specifically, often through a small dedicated coordination service like etcd or ZooKeeper, rather than baking it directly into every part of the application.

### That's all for part 5, folks..Cheers!
