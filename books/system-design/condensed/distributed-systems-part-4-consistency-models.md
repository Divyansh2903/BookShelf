# Distributed Systems Part-4 (Consistency Models)

<<<SECTION 1>>>
Part 3 covered how replication strategies keep copies in sync, each trading coordination against availability. Consistency models are the other side of that coin: they describe the guarantee your application gets about what a read returns, whatever replication strategy runs underneath.

This part is about vocabulary. "Consistent" means very different things in different contexts, and picking the wrong model is a common source of subtle, hard-to-reproduce bugs.

## Why consistency needs a spectrum, not a switch

Consistency is not yes-or-no; it is a spectrum trading correctness against latency and availability. Stronger guarantees need more coordination between nodes, so responses are usually slower. Weaker guarantees are faster, but the application must handle outdated or out-of-order data.

Knowing where a system sits on the spectrum tells you what bugs to expect and what code you can safely write against it.

<<<SECTION 2>>>
## Linearizability

The strongest common guarantee and the most intuitive, but expensive to provide.

A linearizable system behaves as if there is a single copy of the data, and every read or write appears to happen instantly at one point between its call and return. Once a write completes, every later read on any node, from any client, sees that write or something newer. There is no window where one client sees the update and another, a moment later, sees the old value.

People usually assume a database gives this by default, but many systems don't unless explicitly configured. It requires real coordination on every operation, hence a latency cost, which is why systems offering it (ZooKeeper, etcd for coordination tasks) are used sparingly rather than for every read and write.

<<<SECTION 3>>>
## Sequential consistency

Relaxes linearizability in one way: all nodes still see operations in the same order, but that order need not match real time.

Everyone agrees on a single global sequence, which may not line up with when operations actually happened. This removes much of linearizability's expensive coordination, since nodes only agree on relative order, not precise timing.

It is less common as a standalone guarantee in real databases, but it shows that "everyone agrees" and "matches real time" are two separable guarantees, which helps in understanding weaker models.

## Causal consistency

(Introduced briefly in Part 2.) Causally related operations, where one could have influenced the other, are seen in the same order by everyone. Unrelated operations may be seen in different orders by different nodes.

Weaker than sequential consistency but cheaper, since the system only tracks and enforces ordering for connected events rather than one order for everything. It is a popular middle ground for systems that want to feel intuitively correct (a comment appears after the post it replies to) without paying for stronger guarantees on every operation.

<<<SECTION 4>>>
## Eventual consistency

The weakest common model, and the most widely heard of, often without a clear definition.

Its only promise: if no new writes happen to a piece of data, all replicas eventually converge to the same value. It says nothing about how long "eventually" takes or in what order writes are applied. Nodes may briefly disagree or show old data without violating the guarantee, as long as they converge once writes stop.

It is risky but extremely cheap, so it appears in systems prioritizing availability and low latency, like the leaderless systems in Part 3. Read repair and hinted handoff exist to make "eventually" happen sooner.

<<<SECTION 5>>>
## Session guarantees

Plain eventual consistency is often too weak to build an application on, so many systems layer session guarantees on top. These promise nothing about global ordering, only a consistent experience for a single client or session.

- **Read-your-writes** (probably the most important): once a client writes something, that client always sees it in its own later reads, even if other clients on another replica briefly see the old value. Without it, a user could update their profile, reload, and see old data, which feels broken even if the system is within its consistency model.
- **Monotonic reads:** once a client has seen a value, it never later sees an older one, even when reading from a different replica. Without it, a refresh could make data appear to move backward in time, even though nothing is wrong on the backend.

They are popular because they patch the most user-visible problems of eventual consistency without the cost of a stronger global model.

<<<SECTION 6>>>
## Picking the right model

There is no single correct model, only the right one for a given piece of data. A bank balance probably needs something close to linearizability, since a wrong number, even briefly, causes real problems. A like count can live with eventual consistency; nobody cares if it is off by one for a few seconds. Many systems mix models in one application: strong consistency where truly needed, cheaper models elsewhere.

The skill is knowing which model a specific feature needs, instead of defaulting to "as strong as possible" and paying for coordination you don't need.
