# Distributed Systems Part-5 (Consensus Algorithms)

<<<SECTION 1>>>
Part 4 covered linearizability, the strongest consistency guarantee, which requires real coordination between nodes. Consensus algorithms are that coordination: they let a group of unreliable nodes on an unreliable network agree on a single value or sequence of operations, even when some crash.

The **FLP impossibility result** (Part 1) says guaranteed consensus is impossible in a fully asynchronous system if even one node can fail. Every algorithm here lives with that limit, usually by relying on timeouts and the partially synchronous model, rather than defeating it.

## What consensus actually means

Consensus: getting a group of nodes to agree on one value, even if several propose different values at once, and even if nodes crash or messages are delayed.

Real examples:
- **Leader election:** every node must agree on who the leader is.
- **Committing a transaction** across multiple nodes.
- **Appending to a replicated log** (as databases use to sync replicas): every replica must agree on the exact entry sequence.

A correct algorithm guarantees:
- **Safety:** nodes never agree on two different values for the same decision, whatever fails. Usually the easier property.
- **Liveness:** the system eventually reaches a decision, as long as enough nodes are healthy and can communicate. This is where FLP bites, so practical algorithms accept some risk of temporarily stalling rather than promising progress no matter what.

<<<SECTION 2>>>
## Paxos

Introduced by Leslie Lamport in the late 1980s, Paxos was the first widely studied algorithm to solve consensus rigorously. It is known for being hard to understand, though the core idea is manageable.

Paxos runs in rounds with three roles (one node can play several):
- **Proposers** suggest values.
- **Acceptors** vote on proposed values.
- **Learners** find out which value was chosen.

Each round has two phases:
1. A proposer picks a round number higher than any it has used and asks a majority of acceptors to promise to consider a proposal with that number.
2. If a majority agrees, the proposer proposes a value; acceptors accept or reject it based on what they've already promised.

A value is chosen once a majority of acceptors accept it, so Paxos (like most consensus algorithms) needs a majority of nodes alive and reachable to make progress.

The hard part to implement correctly is handling competing proposers, retries, and crashes mid-round while preserving safety. Basic Paxos agrees on only one value at a time, so real systems use **Multi-Paxos**, which agrees on a long sequence of values (e.g. replicated log entries) without repeating the full two-phase process for every entry.

<<<SECTION 3>>>
## Raft

Raft was designed to be easier to understand and implement than Paxos, with the same safety guarantees. That is why it's popular in real systems: etcd, Consul, CockroachDB, and others. It splits the problem into three parts.

**Leader election** uses randomized timeouts. Every node starts as a follower. If a follower doesn't hear from a leader within a random time, it assumes the leader is gone, becomes a candidate, and requests votes. A candidate with votes from a majority becomes leader. Randomizing the timeout makes it unlikely two nodes become candidates simultaneously and repeatedly split the vote.

**Log replication** is the leader's job. All client requests go through the leader, which appends them to its log and replicates them to followers. An entry is **committed** (safe, won't be lost) once a majority of nodes have it. Followers apply committed entries in the same order as the leader, keeping replicas consistent.

**Safety** comes from rules about which node may become leader: roughly, only a node whose log is at least as up-to-date as a majority of the cluster. This prevents a node with stale or missing data from overwriting newer committed entries.

Raft feels more approachable because it maps directly onto an implementation. Paxos is often described as an abstract protocol; Raft was designed from the start around real systems and logs, which is why it's the default choice for new systems needing consensus.

<<<SECTION 4>>>
## ZAB

ZAB (ZooKeeper Atomic Broadcast) is the consensus protocol behind Apache ZooKeeper, one of the older, still widely used coordination services.

Like Raft, ZAB uses a single leader that proposes updates and followers that acknowledge and apply them once a majority agrees. It differs in being designed around ZooKeeper's use case: **atomic broadcast** of state changes, where every node applies the exact same sequence of updates in the same order. That is the primitive that distributed locks and configuration management need.

ZooKeeper predates Raft. Raft's creators, Diego Ongaro and John Ousterhout, built it partly to get ZAB's and Paxos's guarantees with a specification that is easier to reason about and teach. ZAB has nonetheless run in production for a long time, and many systems still depend on it through ZooKeeper.

<<<SECTION 5>>>
## Why consensus is expensive

Every algorithm here needs a round trip to a majority of nodes before anything is official, whether electing a leader or committing a log entry. The majority requirement is the mechanism that provides safety: any two majorities overlap by at least one node, which prevents two contradictory decisions.

So consensus is reserved for operations that need it, like leader election or committing critical metadata, not every read and write. Using it everywhere would mean a majority round trip per operation, defeating the point of fast, highly available systems. Most architectures use it sparingly, often via a small dedicated coordination service like etcd or ZooKeeper, rather than building it into every part of the application.
