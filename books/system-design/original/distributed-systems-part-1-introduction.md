# Distributed Systems Part-1 (Introduction)

<<<SECTION 1>>>
## Part 1: Foundations and the Impossibility Results

If you have worked on any backend system that runs on more than one machine, you have already touched a distributed system. This series is about understanding the theory that explains why these systems behave the way they do, and why so many production incidents trace back to the same handful of root causes. Once you know these root causes, a lot of "weird" production bugs stop feeling random and start feeling predictable.

We will move from the theory in this part to time and ordering in Part 2, and gradually build up to real systems like Dynamo and Spanner by the end of the series. Each part builds on the one before it, so it helps to read them in order. Cheers!

Let's start from the beginning.

## What makes a system "distributed"

A distributed system is simply a collection of independent computers that appear to their users as one coherent system. Your database cluster, your microservices talking over the network, your load balancer routing to ten replicas, all of it counts. Even something as simple as an app talking to a single remote API technically qualifies, though the interesting problems show up once there are multiple nodes that need to agree on something.

The key word is independent. Each machine has its own memory, its own clock, and can fail on its own, without the others knowing right away. That last part is the source of almost every hard problem in this space. On a single machine, a crash is loud and immediate. In a distributed system, a crash can look exactly like a machine that is just busy or a network that is just slow.

Compare this to a single machine program. If a function call fails, you know it failed immediately. If a distributed call fails, you often cannot tell if:

- The remote machine crashed
- The network dropped the message
- The remote machine is just slow
- The response is on its way back but delayed

All four look identical from where you are sitting. This uncertainty is the root of nearly everything we will study in this series.

<<<SECTION 2>>>
## The fallacies of distributed computing

In the 1990s, engineers at Sun Microsystems wrote down a list of assumptions that people commonly make when they first design a system across a network. They called them fallacies because every one of them is false, yet developers keep assuming they are true.

Some of the classic ones:

1. The network is reliable
1. Latency is zero
1. Bandwidth is infinite
1. The network is secure
1. Topology doesn't change
1. There is one administrator
1. Transport cost is zero
1. The network is homogeneous

Every distributed system you will ever build runs into these sooner or later. A service that works fine in your local test environment can fall apart the moment real network delay, packet loss, or partial failure gets involved. A classic example is a request that "times out" on the client side even though the server actually processed it. The client assumes it failed and retries, and now you have done the same write twice. This kind of bug traces directly back to fallacy number one, assuming the network is reliable.

Keeping this list in your head is a good habit when you design anything that spans more than one node.

<<<SECTION 3>>>
## CAP theorem, and why it's usually misunderstood

CAP theorem says that a distributed data store can only guarantee two out of these three properties at the same time:

- **Consistency**: every read gets the latest write, or an error
- **Availability**: every request gets a response, even if it is not the latest data
- **Partition tolerance**: the system keeps working even when network messages between nodes are lost or delayed

Here is the part most explanations get wrong. Partition tolerance is not optional. Networks fail. Cables get cut, routers misbehave, cloud zones lose connectivity. Any system spread across multiple nodes must handle partitions, because they will happen whether you planned for them or not.

So the real choice is not "pick two of three." It is: when a partition happens, do you sacrifice consistency or availability? That is the actual decision CAP forces on you. Everything else is not really a choice at all.

This is why systems get labelled CP (like a lot of traditional relational replication setups, which reject writes during a partition to stay consistent) or AP (like DynamoDB-style stores, which keep answering requests even if some replicas are behind). A CP system will hand back an error rather than risk serving stale or conflicting data. An AP system will hand back whatever data it has, even if another replica has something newer, and sort out the conflict later. Neither choice is wrong; it depends on whether your use case cares more about correctness or uptime.

<<<SECTION 4>>>
## PACELC, the theorem people forget

CAP only talks about what happens during a partition. But partitions are rare. Most of the time your system is running normally, and you still have to make a similar tradeoff, this time between latency and consistency.

PACELC extends CAP with this idea:

- If there is a **P**artition, choose between **A**vailability and **C**onsistency (same as CAP)
- **E**lse, when running normally, choose between **L**atency and **C**onsistency

This is why even in the happy path, a system that wants strong consistency has to pay a latency cost, usually because it needs to coordinate with other replicas before responding. A system that wants low latency will often serve slightly stale data instead.

Almost every database or messaging system you use has quietly made this decision for you. Knowing where a system sits on this spectrum tells you a lot about how it will behave under load. For example, a system tuned for low latency (call it PA/EL) will feel snappy day to day but can hand you slightly outdated reads even when nothing is broken. A system tuned for consistency (PC/EC) will feel slower on every request, because it is paying for coordination up front, in exchange for never showing you stale data.

<<<SECTION 5>>>
## Why consensus is hard: the FLP result

Here is a fact that surprises a lot of engineers the first time they hear it. In 1985, three researchers named Fischer, Lynch, and Paterson proved that in an asynchronous network, where there is no upper bound on how long a message can take, it is impossible to build a consensus algorithm that always terminates correctly if even one node can fail.

This does not mean consensus is impossible in practice. Real systems like Raft and Paxos achieve it every day. What it means is that any working consensus algorithm has to make some kind of compromise. Usually this comes in the form of timeouts, which introduce assumptions about how the network behaves, in exchange for practical progress.

This single result explains why leader election, distributed locks, and coordination services are genuinely hard engineering problems, not things you should casually roll your own version of. It is also why tools like ZooKeeper and etcd exist in the first place. Someone already fought this battle carefully, with years of testing behind it, so most teams are better off depending on that work instead of writing a homegrown leader election script.

<<<SECTION 6>>>
## Synchronous vs asynchronous system models

Last piece for this part. When we design or reason about a distributed system, we usually pick one of two mental models:

**Synchronous model**: there are known upper bounds on message delay and processing time. If a node does not respond within that bound, you can safely assume it failed. This makes reasoning easier but rarely reflects reality.

**Asynchronous model**: there are no bounds at all. A message might take one millisecond or one hour to arrive, and you cannot tell the difference between "slow" and "failed." This is closer to how real networks behave, especially over the internet, but it makes failure detection genuinely hard, which connects directly back to the FLP result above.

Most real systems land somewhere in between, called partially synchronous, where bounds exist but are not known in advance or can change over time. This is the practical assumption most production consensus algorithms actually rely on. In practice, this is exactly what a timeout setting on an RPC call or a heartbeat interval represents: an engineer's best guess at where that bound sits, made without any real guarantee that the guess is correct.

That's all for part 1, folks..Cheers!!!
