# Distributed Systems Part-3 (Replication Strategies)

<<<SECTION 1>>>
## Part 3: Replication Strategies

Part 2 built tools to order events without trusting physical clocks. This part applies them to keeping copies of data on multiple machines without the copies drifting apart. Even a database with one read replica does this.

## Why replicate data at all

- **Survive failure:** a single copy is one disk crash from being lost.
- **Serve traffic** closer to users or spread read load across machines.
- **Planned maintenance:** with one copy you can't patch or restart the machine without taking the system down.

The hard part is keeping copies in sync while writes continue, machines fail, and the network is unreliable. Every strategy answers: how much coordination will you pay for, and how much inconsistency will you tolerate for speed and availability?

<<<SECTION 2>>>
## Single-leader replication

The most common setup, used by typical relational databases with read replicas: Postgres, MySQL, and MongoDB in its default configuration.

One node is the **leader**; all writes go through it. It forwards writes to **followers**, which apply them in the same order. Reads can come from the leader or any follower, depending on freshness needs. Adding followers scales read-heavy workloads without touching the leader.

With one write origin, there's never a question of which write "wins," avoiding a whole category of conflicts. The tradeoff: the leader is a single point of coordination. If it fails, someone must detect that and promote a new leader, a nontrivial problem tied to consensus algorithms. Promoting the wrong node, or too early while the old leader is partially alive, can leave two nodes both believing they lead: **split-brain**.

Replication modes:

- **Synchronous:** leader waits for at least one follower to confirm before acknowledging the client. Protects against loss if the leader crashes right after, but adds a network round trip to every write.
- **Asynchronous:** leader responds immediately and replicates in the background. Faster, but a leader crash can lose the last few writes not yet on a follower.
- **Semi-synchronous:** leader waits for one follower; the rest replicate asynchronously, balancing durability and latency.

<<<SECTION 3>>>
## Multi-leader replication

More than one node accepts writes, usually one leader per data center or region.

Useful with global users: writes happen nearby instead of crossing an ocean. A Tokyo user writing to a Tokyo leader instead of one in Virginia sees a real speed difference. Leaders replicate to each other and eventually converge.

The problem is **conflicts**: two users updating the same record on different leaders nearly simultaneously create two versions of the truth. Vector clocks from Part 2 detect that writes were concurrent rather than one overwriting the other. Resolution options:

- **Last-write-wins** by timestamp: simple but can silently discard a valid update, so often a fallback rather than first choice.
- A **custom merge function** specific to the data type.
- **Surfacing both versions** to the application and letting a human decide.

Multi-leader setups are harder to operate correctly, so teams use them only when the latency benefit justifies it. Debugging is harder too, since the same data can have a slightly different history on each leader.

<<<SECTION 4>>>
## Leaderless replication

No designated leader. Any node accepts writes; the client (or a coordinator) sends each write to several replicas at once.

Popularized by Amazon's Dynamo, ancestor of Cassandra and Riak. Instead of a leader ordering writes, these use **quorum reads and writes**.

With replication factor 3 (each item on three nodes), a write succeeds once acknowledged by a write quorum, e.g. 2 of 3. A read queries a read quorum, e.g. 2 of 3, and compares responses. If write and read quorums overlap by at least one node, a read sees the latest write even when some replicas lag. The rule is **W + R > N** (N = total replicas); this is the mathematical guarantee behind the scheme.

Node failure is handled gracefully: only enough replicas for the quorum must be up. A node down for maintenance, or permanently dead, doesn't stop reads and writes while enough others are healthy. But a node that missed a write returns with stale data. Two mechanisms fix this:

- **Read repair:** when a read across replicas finds an older value on one, the client or coordinator pushes the newer value to it in the background. Popular data heals quickly because it's read often.
- **Hinted handoff:** if a target replica is down during a write, another node stores the write with a hint naming the intended node, and hands it off when that node returns. A temporary outage only delays catch-up rather than leaving the replica permanently behind.

Together these let a leaderless system self-heal without a single coordination point, at the cost of temporary replica disagreement: a tradeoff on the AP side of the CAP theorem.

<<<SECTION 5>>>
## Choosing between the three

No strategy is universally correct.

- **Single-leader:** easiest to reason about; a safe default and where most engineers should start unless they have a concrete reason not to.
- **Multi-leader:** worth its complexity when you need low-latency writes across regions and will invest in conflict handling.
- **Leaderless:** trades strict ordering for high availability and resilience to node failure. Fits systems that prioritize always accepting writes over perfect consistency, like shopping carts or session stores.
