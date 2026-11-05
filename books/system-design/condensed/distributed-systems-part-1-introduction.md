# Distributed Systems Part-1 (Introduction)

<<<SECTION 1>>>
## Part 1: Foundations and the Impossibility Results

Any backend running on more than one machine is a distributed system. This series covers the theory explaining why such systems behave as they do and why so many production incidents share a handful of root causes; knowing them makes "weird" bugs predictable.

The series moves from theory here to time and ordering in Part 2, building up to real systems like Dynamo and Spanner. Each part builds on the previous one.

## What makes a system "distributed"

A distributed system is a collection of independent computers that appear to users as one coherent system: a database cluster, microservices talking over the network, a load balancer routing to ten replicas. Even an app calling a single remote API qualifies, though the interesting problems appear when multiple nodes must agree on something.

The key word is **independent**: each machine has its own memory, its own clock, and can fail on its own without the others knowing right away. That is the source of almost every hard problem here. On one machine a crash is loud and immediate; in a distributed system a crash can look exactly like a busy machine or a slow network.

A failed local function call is known immediately. A failed distributed call could mean:

- The remote machine crashed
- The network dropped the message
- The remote machine is just slow
- The response is on its way back but delayed

All four look identical to the caller. This uncertainty is the root of nearly everything in the series.

<<<SECTION 2>>>
## The fallacies of distributed computing

In the 1990s, Sun Microsystems engineers listed assumptions people commonly make when first designing networked systems. They are called fallacies because all are false, yet developers keep assuming them:

1. The network is reliable
1. Latency is zero
1. Bandwidth is infinite
1. The network is secure
1. Topology doesn't change
1. There is one administrator
1. Transport cost is zero
1. The network is homogeneous

Every distributed system eventually hits these. A service that works in local testing can fall apart with real network delay, packet loss, or partial failure. Classic example: a request "times out" on the client though the server processed it; the client retries and the same write happens twice. This traces directly to fallacy one, assuming the network is reliable.

Keep this list in mind when designing anything spanning more than one node.

<<<SECTION 3>>>
## CAP theorem, and why it's usually misunderstood

CAP says a distributed data store can guarantee only two of three properties at once:

- **Consistency**: every read gets the latest write, or an error
- **Availability**: every request gets a response, even if it is not the latest data
- **Partition tolerance**: the system keeps working even when messages between nodes are lost or delayed

What most explanations get wrong: partition tolerance is not optional. Cables get cut, routers misbehave, cloud zones lose connectivity. Any multi-node system must handle partitions.

So the real choice is not "pick two of three" but: during a partition, do you sacrifice consistency or availability?

Hence **CP** systems (many traditional relational replication setups, which reject writes during a partition to stay consistent) and **AP** systems (DynamoDB-style stores, which keep answering even if some replicas are behind). CP returns an error rather than risk stale or conflicting data; AP returns whatever data it has and resolves conflicts later. Neither is wrong; it depends on whether the use case values correctness or uptime more.

<<<SECTION 4>>>
## PACELC, the theorem people forget

CAP covers only partitions, which are rare. During normal operation there is a similar tradeoff between latency and consistency. PACELC extends CAP:

- If there is a **P**artition, choose between **A**vailability and **C**onsistency (same as CAP)
- **E**lse, when running normally, choose between **L**atency and **C**onsistency

So even on the happy path, strong consistency costs latency, usually because the system must coordinate with replicas before responding. A low-latency system often serves slightly stale data instead.

Almost every database or messaging system has made this decision for you, and knowing where it sits predicts behavior under load. A **PA/EL** system feels snappy but can return slightly outdated reads even when nothing is broken. A **PC/EC** system is slower on every request because it pays for coordination up front, but never shows stale data.

<<<SECTION 5>>>
## Why consensus is hard: the FLP result

In 1985, Fischer, Lynch, and Paterson proved that in an asynchronous network (no upper bound on message delay), no consensus algorithm can always terminate correctly if even one node can fail.

Consensus is still achieved in practice (Raft, Paxos), but every working algorithm makes a compromise, usually timeouts, which add assumptions about network behavior in exchange for practical progress.

This is why leader election, distributed locks, and coordination services are genuinely hard and not something to casually build yourself, and why ZooKeeper and etcd exist. They have years of careful testing behind them; most teams should depend on them rather than a homegrown leader election script.

<<<SECTION 6>>>
## Synchronous vs asynchronous system models

Two mental models for reasoning about distributed systems:

- **Synchronous model:** known upper bounds on message delay and processing time. A node that doesn't respond within the bound can safely be assumed failed. Easier to reason about, but rarely realistic.
- **Asynchronous model:** no bounds. A message might take one millisecond or one hour, and "slow" is indistinguishable from "failed." Closer to real networks, especially the internet, but makes failure detection hard, which ties back to FLP.

Most real systems are **partially synchronous**: bounds exist but are not known in advance or can change over time. This is the practical assumption most production consensus algorithms rely on. An RPC timeout or heartbeat interval is exactly this: an engineer's best guess at the bound, with no guarantee it is correct.
