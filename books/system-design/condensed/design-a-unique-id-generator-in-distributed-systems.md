# Design A Unique ID Generator in Distributed Systems

<<<SECTION 1>>>
Every entity in a large system (order, message, user event) needs a unique ID. On one server, a database auto-increment integer suffices. Across servers, data centres, or regions, that breaks.

Requirements for a distributed unique ID:

- **Globally unique** across all nodes, always
- **Sortable by time**, for reasoning about ordering
- **Numeric**, so databases and indexes handle them efficiently
- **High throughput**: thousands of IDs per second
- **Low latency**: not a bottleneck in the critical path

**Why single auto-increment fails:**

- **Single point of failure.** If the database goes down, no IDs, so no new records, orders, or events.
- **Scalability bottleneck.** Every write in the system funnels through one machine for an ID, capping throughput regardless of other scaling.
- **Doesn't survive horizontal scaling.** Add a second node and both may hand out ID 101: a collision.

The centralized, sequential state that makes it work is exactly what makes it unfit for distributed systems.

### The Four Major Approaches

### 1. Multi-Master Replication

**How it works:** k database servers each auto-increment by k instead of 1, each starting at a different offset. With 3 servers:

- Server 1: 1, 4, 7, 10 ...
- Server 2: 2, 5, 8, 11 ...
- Server 3: 3, 6, 9, 12 ...

Sequences are interleaved, so no duplicates.

### Limitations:

- Hard to scale: adding a server mid-flight requires reconfiguring the increment step on all servers, a painful and risky operation.
- Not globally time-ordered: Server 1 may issue 100,000 before Server 2 issues 5, since servers don't coordinate clocks or ordering.
- Poor across data centers: designed for a fixed, known number of nodes; fragile in multi-region setups.

### 2. UUID (Universally Unique Identifier)

**How it works:** 128-bit numbers generated independently on any machine. The common variant, UUID v4, is random, e.g. 550e8400-e29b-41d4-a716-446655440000. No central authority, network call, or shared state.

<<<SECTION 2>>>
### Limitations:

- **128 bits is large.** Many systems prefer 64-bit IDs for storage and indexing; UUIDs double that cost.
- **Not sortable by time.** v4 is random, so order can't be inferred. Breaks time-range queries and complicates logs.
- **Hurts index performance.** B-tree indexes prefer monotonically increasing keys; random IDs cause page splits and fragmentation, degrading write throughput over time.
- **Non-numeric by default.** Usually hex strings, complicating systems expecting integers.

### 3. Ticket Server

**How it works:** a dedicated centralized server is the sole ID authority, using a single auto-incrementing integer in a database. Services make a network request to it for each ID. Flickr famously used this.

It gives clean, numeric, sequential IDs with zero collision risk and a very simple implementation.

<<<SECTION 3>>>
### Limitations:

- **Single point of failure.** If it goes down, no IDs anywhere. Running multiple ticket servers mitigates this but requires coordinating them to avoid duplicates.
- **Network latency on every request.** Each ID needs a round trip; at high throughput this becomes a bottleneck.
- **Scalability ceiling.** Vertical scaling has a hard limit; one machine handles only so many requests per second, throttling the whole write path.

### 4. Twitter's Snowflake

Snowflake generates 64-bit integers by composing fields:

| 1 bit (sign) | 41 bits (timestamp ms) | 10 bits (machine ID) | 12 bits (sequence) |

- **Sign bit:** always 0, keeps IDs positive.
- **Timestamp (41 bits):** milliseconds since a custom epoch; ~69 years before overflow.
- **Machine ID (10 bits):** generating node, up to 1,024 nodes.
- **Sequence (12 bits):** in-memory counter reset every millisecond; up to 4,096 IDs per ms per node.

Generated in-memory per node: no network calls, no coordination. With the timestamp most significant, IDs sort by time.

<<<SECTION 4>>>
### Limitations:

- **Clock synchronization dependency.** If a clock drifts backward (e.g. NTP corrections), it can produce duplicate IDs or IDs "in the past." Needs clock drift detection and a wait strategy.
- **Machine ID management.** Unique machine IDs must be assigned across the fleet, typically via ZooKeeper or similar, adding operational complexity.
- **Not truly monotonic globally.** IDs from different machines in the same millisecond interleave by machine ID, not true event order. Usually fine, but not strict global ordering.
- **Fixed 69-year lifespan.** The timestamp overflows ~69 years after the epoch; a consideration for long-lived systems.

**Comparison at a Glance**

| Approach | Unique | Time-Sorted | No Single POF | High Throughput | Easy to Scale |
|---|---|---|---|---|---|
| Auto-Increment | No | Yes | No | Heck No | Heck No |
| Multi-Master Replication | Yes | No | Yes | Yes | No |
| UUID | Yes | No | Yes | Yes | Yes |
| Ticket Server | Yes | Yes | No | No | Heck No |
| Snowflake | Yes | Yes | Yes | Yes | Yes |

For most large-scale systems, **Snowflake** or a variant is the gold standard: no coordination, time-sortable 64-bit integers at high throughput, easy horizontal scaling. Its tradeoffs (clock dependency, machine ID management) are well understood and solvable.

The choice depends on constraints. If uniqueness matters more than ordering, UUIDs win on simplicity. For a small, fixed cluster needing strict sequences, a ticket server is reasonable. Understanding each approach's failure modes separates a design that works at 100 RPS from one that holds at 100,000.
