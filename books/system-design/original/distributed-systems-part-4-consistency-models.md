# Distributed Systems Part-4 (Consistency Models)

<<<SECTION 1>>>
In Part 3, we saw how replication strategies keep multiple copies of the same data in sync, and how each one makes a different tradeoff between coordination and availability. Consistency models are really the other side of that same coin. They describe the actual guarantee your application gets about what a read will return, no matter which replication strategy is running underneath it.

This part is less about mechanics and more about vocabulary, but it is vocabulary that matters a lot in practice. When someone says a system is "consistent," that word can mean very different things depending on context, and picking the wrong model for your use case is a common source of subtle, hard to reproduce bugs.

## Why consistency needs a spectrum, not a switch

It is tempting to think of consistency as a single yes-or-no property; a system is either consistent or it is not. In reality, consistency is a spectrum, and different points on that spectrum trade off correctness against latency and availability in different ways. Stronger guarantees mean more coordination between nodes, which usually means slower responses. Weaker guarantees mean faster responses, but the application has to be written carefully to handle the possibility of seeing outdated or out-of-order data.

Understanding where a system sits on this spectrum tells you what kind of bugs to expect, and what kind of code you can safely write against it.

<<<SECTION 2>>>
## Linearizability

Linearizability is the strongest common consistency guarantee, and also the most intuitive one to describe, even though it is expensive to actually provide.

A linearizable system behaves as if there is only a single copy of the data, and every operation, read or write, appears to happen instantly at some single point in time between when it was called and when it returned. Once a write completes, every subsequent read on any node, from any client, must see that write or something newer. There is no window where one client sees the update and another client, checking a moment later, still sees the old value.

This is exactly the guarantee people usually assume a database gives them by default, even though many systems do not actually provide it unless you explicitly configure them to. Linearizability requires real coordination between nodes on every operation, which is why it tends to come with a latency cost, and why systems that offer it, like ZooKeeper or etcd for coordination tasks, are usually used sparingly rather than for every single read and write in an application.

<<<SECTION 3>>>
## Sequential consistency

Sequential consistency relaxes linearizability in one specific way. It still guarantees that all nodes see operations in the same order as each other, but it drops the requirement that this order has to match real time.

In other words, everyone agrees on a single global sequence of operations, but that sequence does not have to line up exactly with when those operations actually happened in the real world. This sounds like a small difference, but it removes a lot of the expensive coordination that linearizability demands, since nodes no longer need to agree on precise timing, only on relative order.

This model is less common as a standalone guarantee in real databases, but it is a useful stepping stone for understanding weaker models, since it shows that "everyone agrees" and "matches real time" are actually two separate guarantees that can be pulled apart.

## Causal consistency

We touched on causal consistency briefly in Part 2, and it is worth revisiting here alongside the other models, since it sits in an interesting middle ground.

Causal consistency guarantees that causally related operations, meaning one could have influenced the other, are seen in the same order by everyone. Operations that are not causally related can be seen in different orders by different nodes, and that is considered acceptable.

This is weaker than sequential consistency, but it is also cheaper to provide, because a system only needs to track and enforce ordering for events that are actually connected, rather than imposing one single order on everything that happens. This makes causal consistency a popular middle ground for systems that want to feel intuitively correct to users, like a comment showing up after the post it replies to, without paying the full cost of stronger guarantees on every single operation.

<<<SECTION 4>>>
## Eventual consistency

Eventual consistency is the weakest common model, and also the one most people have already heard of, often without a clear definition attached to it.

The only real promise eventual consistency makes is this. If no new writes happen to a piece of data, all replicas will eventually converge to the same value. Notice how vague that promise actually is. It says nothing about how long "eventually" takes, and it says nothing about what order writes get applied in along the way. Two nodes might briefly disagree, one node might briefly show old data, and none of that violates the guarantee, as long as things settle down to agreement once writes stop.

This sounds risky, and it can be, but it is also extremely cheap to provide, which is exactly why it shows up in systems that prioritize availability and low latency above all else, like the leaderless systems we discussed in Part 3. The read repair and hinted handoff mechanisms from that part exist specifically to make the "eventually" part of eventual consistency happen sooner rather than later.

<<<SECTION 5>>>
## Session guarantees

In practice, plain eventual consistency is often too weak to build a reasonable application on top of, so many systems layer session guarantees on top of it. These guarantees do not promise anything about global ordering, but they do promise a consistent experience from the point of view of a single client or session.

Read-your-writes is probably the most important one. It guarantees that once a client writes something, that same client will always see that write in its own subsequent reads, even if other clients reading from a different replica might briefly see the old value. Without this guarantee, a user could update their own profile and then immediately reload the page to see their old data still sitting there, which feels broken even if the system is technically behaving within its consistency model.

Monotonic reads is another common one. It guarantees that once a client has seen a particular value, it will never see an older value later, even if it happens to read from a different replica on a subsequent request. Without this, a user could refresh a page and watch data seemingly move backward in time, which is a genuinely confusing experience even though nothing is actually wrong on the backend.

These session guarantees are popular precisely because they patch over the most user visible problems with eventual consistency, without requiring the full cost of a stronger global consistency model.

<<<SECTION 6>>>
## Picking the right model

There is no single correct consistency model, only the right model for a given piece of data. A bank balance probably needs something close to linearizability, since showing the wrong number, even briefly, can cause real problems. A like count on a social media post can happily live with eventual consistency, since nobody notices or cares if it is off by one for a few seconds. Many real systems actually mix models within the same application, using strong consistency for the data that truly needs it and weaker, cheaper models everywhere else.

The real skill here is not knowing all these definitions, it is knowing which one your specific feature actually needs, instead of defaulting to "as strong as possible" out of habit and paying for coordination you did not really need.

### That's all for part 4, folks...Cheers!
