# Design Consistent Hashing

<<<SECTION 1>>>
## What is hashing in distributed systems?

In any distributed system, there is a cache cluster, a database sharding setup, a load balancer, and we need a way to decide: which node is responsible for this key? The simplest answer is modulo hashing.

Given a key k and N servers, we compute:

### node = hash(k) mod N

It is deterministic, fast, and easy to implement. Every client can independently compute the correct node without any coordination. This works well, until the number of servers changes. That's where the trouble begins.

### The Rehashing Problem

Suppose you have 4 servers and a busy cache. Each key maps to a server via hash(k) mod 4. Now you add a 5th server to handle load. The formula becomes hash(k) mod 5.

**Almost every cached key remaps to a different server.** A cache with millions of entries is suddenly invalid. All traffic falls through to your database, a thundering herd that can take down your entire system.

Here's what the math looks like:

{{IMG:1}}

The same catastrophe happens when a server dies. N decreases by one, everything remaps, and every query that was previously cached now hits cold storage simultaneously.

Server failures are unavoidable in distributed systems. A hashing scheme that treats server count as a constant is a liability at scale.

<<<SECTION 2>>>
### Consistent Hashing: The Idea

Consistent hashing was introduced to solve exactly this. The insight: instead of mapping keys to servers by modulo, map both keys and servers onto the same abstract ring : A number line from 0 to 2³²−1 that wraps around on itself.

**Placement:** Each server is hashed (by its IP, hostname, or ID) to get a position on the ring. Each key is similarly hashed to get its own position.

**Lookup:** To find the server responsible for a key, you walk clockwise from the key's position until you hit a server node. That server owns the key.

key_position  = hash(key)  
server_node   = first server clockwise from key_position

The lookup is implemented efficiently using a sorted array or a balanced BST, a binary search finds the correct server in O(log N) time.

{{IMG:2}}

### How Consistent Hashing Solves Rehashing

When a server is added or removed, only keys in the affected arc need to move. All other servers are completely untouched.

**Adding server S5:** S5 gets placed at some position on the ring. Only the keys between S5's predecessor (going counterclockwise) and S5 itself now map to S5. Everything else stays exactly where it was.

**Removing S2:** S2's keys migrate to S3 (the next clockwise node). No other server is affected at all.

With N servers and K total keys, only K/N keys need to be remapped on any change. It is an improvement over modulo hashing's near-total remapping.

Modulo hashing -> ~(N−1)/N of all keys

Consistent hashing-> ~K/N (one arc only)  (better)

<<<SECTION 3>>>
### The Problem with Basic Consistent Hashing

Basic consistent hashing solves the rehashing problem, but introduces a new one: **non-uniform distribution**.

When servers are placed on the ring by hashing their name or IP, there is no guarantee they will be evenly spaced. In practice, you commonly end up with:

**Uneven arcs.** One server might own 50% of the ring, another only 5%. The large-arc server handles 10× the traffic and becomes a hotspot. The others sit mostly idle.

**Cascading failures.** If a heavily loaded server goes down, all of its keys shift clockwise to the next node. That node, which was already handling its own share of traffic, now doubles or triples its load, and may fail in turn.

**No support for heterogeneous hardware.** A server with 2× the RAM and CPU of its peers should handle 2× the keys. Basic consistent hashing has no mechanism for this, every server gets roughly the same arc regardless of capacity.

These aren't edge cases. They're predictable outcomes of placing a small number of nodes on a ring with a hash function.

<<<SECTION 4>>>
### Virtual Nodes: The Fix

The solution is elegant: instead of placing each physical server once on the ring, place it multiple times using different hash inputs. These placements are called **virtual nodes** (vnodes).

For server S1 with 3 vnodes, you hash "S1#1", "S1#2", "S1#3" and place all three positions on the ring. The same physical machine, S1, serves a key that lands near any of those positions.

With enough vnodes (typically 100 to 200 per physical server), each server's position is uniformly scattered across the ring. The result is approximately equal arc ownership regardless of how few physical servers you have.

```python
for each server S:
    for i in range(VNODE_COUNT):
        position = hash(f"{S}#{i}")
        ring.add(position, server=S)
```

### What virtual nodes unlock:

- **Near-uniform load distribution.** Each physical server ends up owning many small, scattered arcs that average out to roughly equal total ownership.
- **Graceful failure.** When a server fails, its ~150 vnode positions are distributed across the ring. The adjacent servers that absorb its keys are likely many different physical machines, so the extra load is spread thin rather than dumped onto one neighbor.
- **Proportional capacity allocation.** Give a beefier server more vnodes to give it proportionally more load. A server with 2× the capacity gets 2× the vnodes, and naturally handles ~2× the keys.
- **Smoother scaling.** When a new server joins with many vnodes, it takes partial arcs from many existing servers rather than one large arc from a single neighbor, reducing disruption across the cluster.

<<<SECTION 5>>>
### Where You'll See This in the Wild

Consistent hashing with virtual nodes is the backbone of several widely used systems:

**Amazon DynamoDB and Apache Cassandra** use vnodes for data partitioning across the cluster. Cassandra's token ring is a direct implementation of this design.

**Content Delivery Networks** use consistent hashing to route requests to edge nodes deterministically without a central lookup table.

**Load balancers** use it to maintain session affinity (sticky sessions) with minimal disruption as backend instances scale up or down.

The progression is modulo hashing -> consistent hashing -> virtual nodes. It is a classic example of how distributed systems design works in practice: each solution is clean and sufficient until scale exposes its assumptions, and the next solution is built to address exactly that failure mode.

That's all folks, Cheers!
