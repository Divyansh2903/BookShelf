# Distributed Systems Part-7 (Failure Detection and Fault Tolerance)

<<<SECTION 1>>>
Part 6 spread data across many nodes. More machines means more things that can fail, and failing quietly is often worse than failing loudly. This part asks: how does a distributed system know a node is dead?

## Why failure detection is hard

From Part 1: in an asynchronous network there is no upper bound on message delay. If a node doesn't respond, you cannot tell whether it crashed, is just slow, or the network dropped your message or the reply. All three look identical.

This is a fundamental limit: no failure detector can be perfectly accurate in an asynchronous system, because that would require knowing whether a silent node is dead or slow. Every practical detector accepts this and trades off detecting failures quickly against avoiding false alarms.

<<<SECTION 2>>>
## Heartbeats

The simplest and most widely used mechanism: each node periodically sends a small "I am still alive" message to the others. If heartbeats stop for some period, others assume the node failed.

The timeout matters:
- **Too short:** false positives; healthy nodes declared dead because a heartbeat was delayed by normal network jitter or a brief garbage collection pause.
- **Too long:** real failures are detected later, so the system keeps sending work to a node that is gone.

This is the same fundamental trade-off in its most basic form. A fixed timeout is one number trying to capture a decision that depends on constantly changing network conditions.

<<<SECTION 3>>>
## Phi accrual failure detectors

Since a fixed timeout is blunt, some systems use an adaptive **phi accrual failure detector**, described in a paper and used by systems like Cassandra and Akka.

Instead of yes/no, it outputs a continuously changing suspicion level, **phi**, computed from the history of recent heartbeat arrival times from that specific node:
- If heartbeats usually arrive regularly every second and two seconds pass with nothing, phi rises.
- If the node's heartbeats have always been irregular (0.5 to 2 seconds apart), the same two-second gap raises phi much less, since it is within that node's observed normal range.

The detector adapts to each node's normal behaviour and current network conditions instead of one arbitrary cluster-wide threshold. Applications choose their own phi threshold: react quickly and accept more false positives, or wait longer and reduce false alarms, depending on what a false positive costs them.

<<<SECTION 4>>>
## Gossip protocols

Heartbeats and phi accrual cover how one node judges another. In clusters of hundreds or thousands of nodes, every node monitoring every other doesn't scale; the number of connections grows extremely fast.

**Gossip protocols** spread information like rumours. Periodically, each node picks a few random nodes and exchanges information, including what it believes about the health of every node it knows. Each node that learns something new spreads it next round, so information propagates exponentially.

Benefits:
- **Scales** far better: each node talks to a handful of others at a time, not the whole cluster.
- **Resilient:** no single node tracks everyone's health, so no single failure blinds the cluster. Cassandra uses gossip so nodes learn about failures and membership changes without a centralized coordinator.

**Trade-off:** gossip information is a little stale. Propagation takes a few rounds, so nodes can briefly disagree about which nodes are up or down: the eventual consistency of Part 4, applied to cluster membership instead of application data.

<<<SECTION 5>>>
## Split brain

Split brain is what failure detection partly exists to prevent, and can sometimes cause by mistake. A network partition splits a cluster into groups that can talk within themselves but not to each other.

Each side may conclude the other is dead and elect its own leader or keep operating independently. Now two parts of one system both believe they are in charge and may both accept writes, with no way to reconcile until the partition heals. Then you may have two conflicting versions of the truth to resolve manually or automatically, the same conflict resolution problem as multi-leader replication in Part 3.

This is why consensus algorithms (Part 5) require a **majority** to make progress. If a five-node cluster splits into groups of three and two, only the three can reach a majority and elect a leader or commit operations. The group of two is deliberately unable to progress, which feels restrictive but is exactly what prevents split brain. This is the payoff of the majority overlap property from Part 5.

<<<SECTION 6>>>
## Self-healing systems

Good distributed systems recover from failure automatically wherever possible; paging a human at 3 a.m. for every node failure doesn't scale.

Self-healing combines ideas from this series:
- **Failure detection** (heartbeats or gossip) identifies that something went wrong.
- **Replication** (Part 3) means the failed node's data still exists elsewhere.
- **Consensus** (Part 5) lets the cluster safely agree on a new leader or arrangement of responsibilities without split brain.
- **Rebalancing** (Part 6) moves data and load to compensate for the missing node, restoring a healthy distribution.

None works well in isolation. A fault-tolerant system's strength comes from combining them, each covering gaps the others leave open.
