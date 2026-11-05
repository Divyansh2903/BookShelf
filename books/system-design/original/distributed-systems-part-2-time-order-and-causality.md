# Distributed Systems Part-2 (Time, Order, and Causality)

<<<SECTION 1>>>
## Distributed Systems, Part 2: Time, Order, and Causality

In Part 1, we saw that distributed systems live in an asynchronous world, where you cannot always tell if a node is slow or dead. That same uncertainty shows up again the moment you try to answer a question that sounds simple: which of these two events happened first? It turns out this simple-sounding question is the root of leader election, conflict resolution, and half the debugging headaches you will ever run into in a distributed system.

On a single machine, this is trivial. One clock, one timeline, done. Across machines, it turns out to be one of the hardest problems in the field, mostly because there is no single shared clock that every machine can trust.

## Why physical clocks can't be trusted

Every computer has a physical clock, and you might assume that if two machines both check the time, you can just compare the numbers. In practice, this does not work.

Physical clocks drift. Cheap quartz oscillators gain or lose a few milliseconds every day, and that adds up fast across a fleet of machines. Different machines can drift in different directions too, so the gap between two clocks does not stay fixed, it keeps changing. To fix this, most systems rely on NTP, the Network Time Protocol, which periodically syncs a machine's clock against a reference time server.

NTP helps, but it does not solve the problem completely. Sync happens over a network, so it has its own delay and jitter, and that delay is not the same every time. Depending on network conditions, two machines running NTP can still disagree by tens of milliseconds, sometimes more. That might sound tiny, but distributed systems process thousands of events per second, so tens of milliseconds is more than enough room for clocks to get the order of events wrong. Google's Spanner is one of the few systems that tries to solve this properly, using GPS and atomic clocks in every data center through something called TrueTime, but that is an expensive and rare setup, not something most teams have access to.

This means you cannot safely say "event A happened before event B" just because A's timestamp is smaller. The clocks might simply be out of sync, and trusting them blindly can lead to subtle bugs, like a system thinking a write happened after a later read, when in reality the opposite is true.

<<<SECTION 2>>>
## Lamport timestamps

In 1978, Leslie Lamport proposed a clever workaround. Instead of trying to fix physical clocks, throw them out entirely and use a logical clock instead. The insight is that we do not actually need to know the exact time an event happened, we only need to know the relative order of events that could have affected each other.

The idea is simple. Every node keeps a counter, starting at zero.

- Before a node does anything, it increments its own counter.
- When a node sends a message, it attaches its current counter value.
- When a node receives a message, it sets its counter to the maximum of its own value and the received value, then increments by one.

This gives every event a number, and if event A happened before event B in a way that could have influenced B, A's number is guaranteed to be smaller. This is genuinely useful in practice, for example when ordering log entries or operations in a replicated system where you cannot rely on wall clock time.

There is a catch, though. Lamport timestamps only capture what is called a "happened-before" relationship. If two events are unrelated, meaning neither could have influenced the other, Lamport timestamps cannot tell you that. They will still assign them some order, even though there wasn't a real cause-and-effect relationship between them. This false sense of ordering can be misleading if you are not careful, because it looks like a real timeline even when part of it is arbitrary.

<<<SECTION 3>>>
## Vector clocks

Vector clocks fix that gap. Instead of one number per event, each node keeps a full array of counters, one slot per node in the system. So in a five-node cluster, every event carries an array of five numbers instead of just one.

Every node increments its own slot before doing local work, and when it sends a message, it attaches the entire vector. On receiving a message, the node updates every slot to the maximum of its own vector and the incoming one, then increments its own slot.

The payoff is that vector clocks can now tell you three things instead of one:

- Event A happened before event B
- Event B happened before event A
- Neither happened before the other, meaning they are concurrent

That third case is the important one. It lets a system detect real conflicts, for example, two users updating the same record on different replicas at the same time, without one having any knowledge of the other. Systems like Amazon's original Dynamo used vector clocks specifically for this reason, to detect when replicas had diverging versions of the same piece of data that a human or application needed to resolve, sometimes by showing the user both versions and letting them pick, the way an old version of Amazon's shopping cart used to merge conflicting carts instead of silently picking one.

The tradeoff is size. A vector clock grows with the number of nodes in the system, so in a cluster with thousands of nodes, storing and comparing these vectors gets expensive fast, both in memory and in the bandwidth needed to send them around. This is one of the main reasons vector clocks are less common in very large-scale systems today.

<<<SECTION 4>>>
## Hybrid logical clocks

Hybrid logical clocks, usually shortened to HLC, try to get the best of both worlds. They combine a physical timestamp with a logical counter.

Under normal conditions, an HLC behaves like a physical clock, so timestamps still roughly track real-world time, which is useful for humans debugging a system or for time-based queries, like asking "what did the data look like at 3 pm yesterday." But whenever events would otherwise appear out of order because of clock drift, the logical counter kicks in and corrects the ordering, the same way a Lamport timestamp would, nudging the timestamp forward just enough to preserve causality without drifting far from real time.

This gives you timestamps that are close to real time, but still respect causality the way Lamport timestamps do, and without the size overhead of vector clocks. CockroachDB is a well-known real-world user of this idea, relying on HLCs to keep transaction ordering correct across nodes without needing perfectly synchronized physical clocks or specialized hardware like Spanner's TrueTime.

<<<SECTION 5>>>
## Causal consistency

All of this machinery exists to support one goal, preserving cause and effect across a distributed system.

Causal consistency is a guarantee that if event B was caused by event A, every node in the system will observe A before B. Events with no causal relationship can be observed in any order on different nodes, and that is fine. This makes causal consistency weaker than strong consistency, but far easier and cheaper to provide at scale, since nodes do not need to constantly coordinate on every single event, only on the ones that are actually related.

A simple example makes this concrete. Imagine a comment thread. If someone posts a reply to a comment, the reply is causally dependent on the original comment. A system with causal consistency guarantees that no user will ever see the reply before they see the comment it replies to, even if they are reading from different replicas. Two unrelated comments posted around the same time, on the other hand, might show up in a different order for different readers, and that is acceptable under this model, since there was no real dependency between them in the first place.

This matches how humans actually expect systems to behave most of the time. We usually only care about ordering when there is an actual cause-and-effect relationship involved, not perfect global ordering of every single event in the system.

### That's all for part 2, folks..Cheers!!
