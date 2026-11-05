# Distributed Systems Part-2 (Time, Order, and Causality)

<<<SECTION 1>>>
## Distributed Systems, Part 2: Time, Order, and Causality

Part 1 showed that distributed systems are asynchronous: you cannot always tell if a node is slow or dead. The same uncertainty affects the question "which of two events happened first?", which underlies leader election, conflict resolution, and much distributed debugging.

On one machine this is trivial: one clock, one timeline. Across machines it is one of the hardest problems in the field, because there is no single shared clock every machine can trust.

## Why physical clocks can't be trusted

**Physical clocks drift.** Cheap quartz oscillators gain or lose a few milliseconds per day, and machines drift in different directions, so the gap between two clocks keeps changing. Most systems use **NTP** (Network Time Protocol) to periodically sync against a reference time server.

NTP doesn't fully solve it: sync happens over a network with variable delay and jitter, so two NTP machines can still disagree by tens of milliseconds or more. With thousands of events per second, that is enough to get event order wrong. Google's Spanner addresses this with **TrueTime**, using GPS and atomic clocks in every data center, but that setup is expensive and rare.

So a smaller timestamp does not prove A happened before B. Trusting clocks blindly causes subtle bugs, such as a system thinking a write happened after a later read when the opposite is true.

<<<SECTION 2>>>
## Lamport timestamps

In 1978, Leslie Lamport proposed discarding physical clocks for a **logical clock**. We don't need the exact time of an event, only the relative order of events that could have affected each other.

Every node keeps a counter starting at zero:

- Before doing anything, a node increments its counter.
- When sending a message, it attaches its current counter value.
- When receiving, it sets its counter to max(own, received), then increments by one.

If A happened before B in a way that could have influenced B, A's number is guaranteed smaller. This is useful for ordering log entries or operations in a replicated system without relying on wall-clock time.

**The catch:** Lamport timestamps only capture the "happened-before" relationship. For two unrelated events (neither could influence the other), they still assign an order, even though there is no cause-and-effect. This looks like a real timeline even when part of it is arbitrary, which can mislead.

<<<SECTION 3>>>
## Vector clocks

Each node keeps an array of counters, one slot per node; in a five-node cluster every event carries five numbers.

- A node increments its own slot before local work.
- When sending, it attaches the entire vector.
- On receiving, it sets every slot to the max of its own and the incoming vector, then increments its own slot.

Vector clocks can tell three things:

- A happened before B
- B happened before A
- Neither: they are **concurrent**

The third case lets a system detect real conflicts, e.g. two users updating the same record on different replicas at the same time without knowledge of each other. Amazon's original Dynamo used vector clocks to detect diverging replica versions that a human or application had to resolve, sometimes by showing the user both versions; an old version of Amazon's shopping cart merged conflicting carts instead of silently picking one.

**Tradeoff: size.** A vector clock grows with the number of nodes, so with thousands of nodes, storing, comparing, and sending vectors gets expensive in memory and bandwidth. This is a main reason they are less common in very large-scale systems today.

<<<SECTION 4>>>
## Hybrid logical clocks

Hybrid logical clocks (**HLC**) combine a physical timestamp with a logical counter.

Normally an HLC behaves like a physical clock, so timestamps roughly track real time, useful for human debugging and time-based queries ("what did the data look like at 3 pm yesterday?"). When clock drift would make events appear out of order, the logical counter corrects the ordering like a Lamport timestamp, nudging the timestamp forward just enough to preserve causality without drifting far from real time.

Result: near-real-time timestamps that respect causality, without vector clocks' size overhead. CockroachDB uses HLCs to keep transaction ordering correct across nodes without perfectly synchronized clocks or specialized hardware like Spanner's TrueTime.

<<<SECTION 5>>>
## Causal consistency

All this machinery exists to preserve cause and effect across a distributed system.

**Causal consistency** guarantees that if B was caused by A, every node observes A before B. Causally unrelated events may be observed in any order on different nodes. It is weaker than strong consistency but far easier and cheaper at scale, since nodes coordinate only on related events, not every event.

Example: in a comment thread, a reply depends causally on the original comment. No user ever sees the reply before the comment, even reading from different replicas. Two unrelated comments posted around the same time may appear in different orders for different readers, which is acceptable.

This matches how humans expect systems to behave: we care about ordering when there is a real cause-and-effect relationship, not perfect global ordering of every event.
