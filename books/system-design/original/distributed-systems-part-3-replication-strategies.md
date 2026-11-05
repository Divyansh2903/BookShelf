# Distributed Systems Part-3 (Replication Strategies)

<<<SECTION 1>>>
## Part 3: Replication Strategies

In Part 2, we built the tools to order events without trusting physical clocks. Now we can put those tools to use on one of the most common problems in distributed systems: keeping copies of the same data on multiple machines, and making sure those copies do not quietly drift apart. This is a problem almost every backend engineer runs into eventually, whether they realize it or not, since even a "simple" database with one read replica is already doing this.

## Why replicate data at all

Before getting into strategies, it helps to remember why replication exists in the first place. You replicate data for two main reasons: to survive failure, since a single copy of your data is one disk crash away from being gone forever, and to serve traffic closer to users or spread read load across multiple machines instead of hammering one server. A third reason, often overlooked, is planned maintenance. If you only have one copy of your data, you cannot patch or restart that machine without taking your whole system down with it.

The hard part is not copying data once. It is keeping multiple copies in sync while writes keep happening, machines keep failing, and the network keeps being unreliable. Every replication strategy in this part is really just a different answer to the same question: how much coordination are you willing to pay for, and how much inconsistency are you willing to tolerate in exchange for speed and availability?

<<<SECTION 2>>>
## Single-leader replication

This is the most common setup you will run into, and probably the one you already use if you run a typical relational database with read replicas. Postgres, MySQL, and MongoDB in its default configuration all lean on this model.

In single-leader replication, one node is designated the leader, and all writes go through it. The leader then forwards those writes to the other nodes, called followers, which apply them in the same order the leader did. Reads can be served from the leader or from any follower, depending on how fresh you need the data to be. Serving reads from followers is a common way to scale read-heavy workloads, since you can add more followers without touching the leader at all.

The write path is simple to reason about, since there is only one place writes can happen, which avoids a whole category of conflicts. There is never a question of which write "wins," because there is only ever one place writes originate from. The tradeoff is that the leader becomes a single point of coordination. If it goes down, someone has to detect that and promote a new leader, which is a nontrivial problem on its own, and one that connects directly back to the consensus algorithms. Promote the wrong node, or promote too early while the old leader is still partially alive, and you can end up with two nodes both thinking they are the leader, a dangerous state usually called split-brain.

Replication to followers can happen synchronously or asynchronously. Synchronous replication means the leader waits for at least one follower to confirm the write before telling the client it succeeded, which protects against data loss if the leader crashes right after, but adds latency, since every write now has to wait on a network round trip to a follower. Asynchronous replication means the leader responds immediately and sends the update to followers in the background, which is faster but means a leader crash can lose the last few writes that never made it to a follower. Some systems offer a middle ground, called semi-synchronous replication, where the leader waits for just one follower to confirm while the rest replicate asynchronously, balancing durability against latency.

<<<SECTION 3>>>
## Multi-leader replication

Multi-leader replication allows more than one node to accept writes at the same time, usually one leader per data center or per region.

This is useful when you have users spread across the world and want writes to happen close to them instead of always crossing an ocean to reach a single leader. A user in Tokyo writing to a leader in Tokyo, instead of one in Virginia, can make a real difference in perceived speed. Each leader replicates its writes to the other leaders, and every leader eventually converges to the same state.

The obvious problem here is conflicts. If two users update the same record on two different leaders at nearly the same time, you now have two versions of the truth that need to be reconciled. This is exactly where the vector clocks from Part 2 become useful, since they let a system detect that two writes were concurrent rather than one simply overwriting the other. Once a conflict is detected, someone still has to resolve it, whether that is last-write-wins based on timestamp, a custom merge function specific to the data type, or surfacing both versions to the application and letting a human decide. Last-write-wins is simple but can silently discard a valid update, so it is often used as a fallback rather than a first choice.

Multi-leader setups are powerful but genuinely harder to operate correctly, which is why most teams only reach for them when the latency benefits are worth the added complexity. Debugging a multi-leader system also tends to be harder, since the same piece of data can have a slightly different history depending on which leader you look at.

<<<SECTION 4>>>
## Leaderless replication

Leaderless replication throws out the idea of a designated leader entirely. Any node can accept a write, and the client, or a coordinator on its behalf, sends the write to several replicas at once.

This is the model Amazon's Dynamo popularized, and it is the ancestor of systems like Cassandra and Riak. Instead of relying on a single leader to decide the order of writes, these systems use a technique called quorum reads and writes.

Here is how it works. Say you have a replication factor of three, meaning every piece of data lives on three nodes. A write is considered successful once it has been acknowledged by a write quorum, say two out of three nodes. A read queries a read quorum, again say two out of three nodes, and compares the responses. As long as the write quorum and read quorum overlap by at least one node, a read is guaranteed to see the most recent write, even if some replicas are temporarily behind. This overlap rule is usually written as W plus R being greater than N, where N is the total number of replicas, and it is the mathematical guarantee that makes the whole scheme work.

This model handles node failure gracefully, since you do not need every replica to be up, only enough of them to satisfy the quorum. A node can be down for maintenance, or even permanently dead, and the system keeps accepting reads and writes without missing a beat, as long as enough other replicas are healthy. But it introduces its own set of problems. If a node was down during a write and comes back later, it holds stale data. Leaderless systems handle this with two mechanisms.

Read repair happens when a client reads from multiple replicas and notices one of them returned an older value. The client, or the coordinator, then pushes the newer value to the stale replica in the background, quietly fixing it during normal read traffic. This means popular pieces of data tend to heal themselves quickly, simply because they get read often.

Hinted handoff happens on the write side. If a replica that should have received a write is down, another node temporarily stores the write on its behalf, along with a hint saying which node it was really meant for. Once the original node comes back online, that stored write gets handed off to it. This way, a temporary outage does not mean a replica falls permanently behind; it just delays when it catches up.

Together, these mechanisms let a leaderless system heal itself over time without needing a single point of coordination, at the cost of temporarily allowing replicas to disagree, which is a tradeoff very much in the spirit of the AP side of the CAP theorem.

<<<SECTION 5>>>
## Choosing between the three

There is no universally correct replication strategy, only tradeoffs suited to different needs. Single-leader is the easiest to reason about and is a safe default for most applications, and it is where most engineers should start unless they have a concrete reason not to. Multi-leader earns its complexity when you genuinely need low-latency writes across multiple regions, and you are willing to invest in handling conflicts properly. Leaderless trades strict ordering for high availability and resilience to node failure, which is why it shows up in systems that prioritize always being able to accept a write over always being perfectly consistent, like shopping carts or session stores where availability usually matters more than perfect ordering.

### That's all for part 3, folks...Cheers!!
