# Design Consistent Hashing

<<<SECTION 1>>>
## What is hashing in distributed systems?

Cache clusters, database sharding, and load balancers all need to decide which node owns a key. The simplest answer is modulo hashing. For key k and N servers:

**node = hash(k) mod N**

It is deterministic, fast, and easy to implement; every client computes the correct node without coordination. It works until the number of servers changes.

### The Rehashing Problem

With 4 servers, keys map via hash(k) mod 4. Add a 5th server and the formula becomes hash(k) mod 5: **almost every cached key remaps to a different server.** A cache with millions of entries is suddenly invalid, and all traffic falls through to the database, a thundering herd that can take down the whole system.

{{IMG:1}}

The same happens when a server dies: N drops by one, everything remaps, and every previously cached query hits cold storage simultaneously. Server failures are unavoidable, so a scheme that treats server count as constant is a liability at scale.

<<<SECTION 2>>>
### Consistent Hashing: The Idea

Instead of modulo, map both keys and servers onto the same abstract **ring**: a number line from 0 to 2³²−1 that wraps around.

- **Placement:** Each server is hashed (by IP, hostname, or ID) to a ring position; each key is hashed to its own position.
- **Lookup:** Walk clockwise from the key's position to the first server node; that server owns the key.

key_position  = hash(key)  
server_node   = first server clockwise from key_position

Lookup uses a sorted array or balanced BST; binary search finds the server in O(log N).

{{IMG:2}}

### How Consistent Hashing Solves Rehashing

Adding or removing a server moves only keys in the affected arc; all other servers are untouched.

- **Adding S5:** Only keys between S5's counterclockwise predecessor and S5 now map to S5.
- **Removing S2:** S2's keys migrate to S3 (the next clockwise node). No other server is affected.

With N servers and K keys, only K/N keys remap on any change:

- Modulo hashing -> ~(N−1)/N of all keys
- Consistent hashing -> ~K/N (one arc only) (better)

<<<SECTION 3>>>
### The Problem with Basic Consistent Hashing

Basic consistent hashing introduces **non-uniform distribution**: servers hashed by name or IP are not guaranteed to be evenly spaced. Common results:

- **Uneven arcs.** One server may own 50% of the ring, another 5%. The large-arc server handles 10× the traffic and becomes a hotspot while others idle.
- **Cascading failures.** If a heavily loaded server dies, its keys shift clockwise to the next node, which may double or triple its load and fail in turn.
- **No support for heterogeneous hardware.** A server with 2× the RAM and CPU should handle 2× the keys, but every server gets roughly the same arc regardless of capacity.

These are predictable outcomes of placing few nodes on a ring with a hash function, not edge cases.

<<<SECTION 4>>>
### Virtual Nodes: The Fix

Place each physical server on the ring multiple times using different hash inputs. These placements are **virtual nodes** (vnodes). For S1 with 3 vnodes, hash "S1#1", "S1#2", "S1#3"; S1 serves keys landing near any of those positions.

With enough vnodes (typically 100 to 200 per physical server), positions scatter uniformly, giving approximately equal arc ownership even with few physical servers.

```python
for each server S:
    for i in range(VNODE_COUNT):
        position = hash(f"{S}#{i}")
        ring.add(position, server=S)
```

### What virtual nodes unlock:

- **Near-uniform load distribution.** Each server owns many small scattered arcs that average to roughly equal ownership.
- **Graceful failure.** A failed server's ~150 vnode positions are spread across the ring, so its keys go to many different physical machines rather than one neighbor.
- **Proportional capacity allocation.** A server with 2× capacity gets 2× the vnodes and handles ~2× the keys.
- **Smoother scaling.** A new server with many vnodes takes partial arcs from many existing servers rather than one large arc from a single neighbor.

<<<SECTION 5>>>
### Where You'll See This in the Wild

- **Amazon DynamoDB and Apache Cassandra** use vnodes for data partitioning. Cassandra's token ring directly implements this design.
- **Content Delivery Networks** route requests to edge nodes deterministically without a central lookup table.
- **Load balancers** maintain session affinity (sticky sessions) with minimal disruption as backends scale up or down.

The progression is modulo hashing -> consistent hashing -> virtual nodes: each solution is sufficient until scale exposes its assumptions, and the next is built to address exactly that failure mode.
