# Design A Unique ID Generator in Distributed Systems

<<<SECTION 1>>>
Every meaningful entity in a large-scale system like an order, a message, a user event, needs a unique identifier. In a single-server world, this is trivial: an auto-incrementing integer in a database handles it cleanly. But once your system spans multiple servers, data centres, or geographic regions, that simplicity collapses fast.

The requirements for a good distributed unique ID are stricter than they first appear:

- **Globally unique** across all nodes, always
- **Sortable by time:** so you can reason about ordering
- **Numeric:** so downstream systems (databases, indexes) can handle them efficiently
- **High throughput:** capable of generating thousands of IDs per second
- **Low latency:** without becoming a bottleneck in the critical path

Why Single Auto-Increment Fails : The most natural starting point i.e. a single database with an auto-incrementing primary key, breaks down almost immediately at scale.

**It's a single point of failure.** If that database goes down, your entire system loses the ability to generate IDs. No IDs means no new records, no new orders, no new events. Everything halts.

**It's a scalability bottleneck.** Every write in your entire distributed system must funnel through one machine to get an ID. As traffic grows, this node becomes the ceiling on your throughput, so no matter how well you've scaled everything else.

**It doesn't survive horizontal scaling.** The moment you add a second database node to share the load, you get conflicts. Node A gives out ID 101, Node B simultaneously gives out ID 101. You now have a collision.

This is the core tension: the property that makes single auto-increment work (centralized, sequential state) is exactly what makes it unfit for distributed systems.

### The Four Major Approaches

### 1. Multi-Master Replication

**How it works:** Instead of one database issuing IDs, you run k database servers, each auto-incrementing, but with a twist. Every server increments by k instead of 1, and each starts at a different offset.

With 3 servers:

- Server 1 generates: 1, 4, 7, 10 ...
- Server 2 generates: 2, 5, 8, 11 ...
- Server 3 generates: 3, 6, 9, 12 ...

No two servers will ever produce the same ID, because their sequences are interleaved by design.

### Limitations:

- Hard to scale beyond the initial setup. Adding a new server mid-flight requires reconfiguring the increment step on all existing servers. So it is a painful & risky operation.
- IDs are not globally time-ordered. Server 1 might issue ID 100,000 before Server 2 issues ID 5, because the servers don't coordinate clocks or ordering.
- Doesn't work well across data centers. This scheme is designed for a fixed, known number of nodes. Distributed multi-region environments make this fragile.

### 2. UUID (Universally Unique Identifier)

**How it works:** UUIDs are 128-bit numbers generated independently on any machine, with no coordination required. The most common variant (UUID v4) is randomly generated. An example looks like: 550e8400-e29b-41d4-a716-446655440000.

Each node generates its own IDs entirely autonomously. No central authority, no network call, no shared state.

<<<SECTION 2>>>
### Limitations:

- **128 bits is large.** Many systems prefer 64-bit IDs for storage efficiency and indexing performance. UUIDs double that cost.
- **Not sortable by time.** UUID v4 is random, you can't determine which ID came first just by looking at them. This breaks time-range queries and makes logs harder to reason about.
- **Random UUIDs hurt database index performance.** B-tree indexes work best with monotonically increasing keys. Random IDs cause page splits and fragmentation, degrading write throughput over time.
- **Non-numeric by default.** UUIDs are typically represented as hex strings, which complicates systems that expect integer IDs.

### 3. Ticket Server

**How it works:** A dedicated, centralized server (the "ticket server") is the sole authority for ID generation. It uses a single auto-incrementing integer in a database, and all other services make a network request to it when they need an ID. Flickr famously used this approach.

It gives you clean, numeric, sequential IDs with zero collision risk. and the implementation is very simple.

<<<SECTION 3>>>
### Limitations:

- **Single point of failure.** If the ticket server goes down, no IDs can be issued anywhere in the system. To mitigate this, you can run multiple ticket servers, but then you're back to coordinating between them to avoid duplicates.
- **Network latency on every ID request.** Every ID generation now requires a round trip to a central service. At high throughput, this adds up and can become a performance bottleneck.
- **Scalability ceiling.** The ticket server can be scaled vertically, but there's a hard limit. A single machine can only handle so many requests per second, and ID generation starts to throttle your entire write path.

### 4. Twitter's Snowflake

Snowflake is the most elegant solution in the distributed ID design space. It generates 64-bit integers by composing several fields into a single number:

| 1 bit (sign) | 41 bits (timestamp ms) | 10 bits (machine ID) | 12 bits (sequence) |

- **Sign bit:** Always 0, reserved to keep IDs positive.
- **Timestamp (41 bits):** Milliseconds since a custom epoch. This gives ~69 years of range before overflow.
- **Machine ID (10 bits):** Identifies the generating node (up to 1,024 unique nodes).
- **Sequence number (12 bits):** An in-memory counter that resets every millisecond, allowing up to 4,096 IDs per millisecond per node.

IDs are generated entirely in-memory on each node, no network calls, no coordination. And because the timestamp is the most significant component, IDs are naturally sorted by time.

<<<SECTION 4>>>
### Limitations:

- **Clock synchronization dependency.** Snowflake assumes the system clock is reliable. If a machine's clock drifts backward (which can happen with NTP corrections), you can generate duplicate IDs or produce IDs that appear "in the past." This requires clock drift detection and a wait strategy.
- **Machine ID management.** You need a way to assign unique machine IDs across your fleet. Typically this is done via ZooKeeper or a similar coordination service, which introduces its own operational complexity.
- **Not truly monotonic globally.** IDs generated on different machines at the same millisecond will interleave based on machine ID, not true event order. For most use cases this is fine, but it's not a strict global ordering.
- **Fixed 69-year lifespan.** The timestamp field overflows ~69 years after the chosen epoch. Not an immediate concern, but a design consideration for long-lived systems.

Comparison at a Glance

**Auto-Increment** Unique - No · Time-Sorted - Yes · No Single POF - No · High Throughput - Heck No · Easy to Scale - Heck No

**Multi-Master Replication** Unique - Yes · Time-Sorted - No · No Single POF - Yes · High Throughput - Yes · Easy to Scale - No

**UUID** Unique - Yes · Time-Sorted - No · No Single POF - Yes · High Throughput - Yes · Easy to Scale - Yes

**Ticket Server** Unique - Yes · Time-Sorted - Yes · No Single POF - No · High Throughput - No · Easy to Scale - Heck No

**Snowflake** Unique - Yes · Time-Sorted - Yes · No Single POF - Yes · High Throughput - Yes · Easy to Scale - Yes

So, for most large-scale distributed systems, **Twitter's Snowflake,** or a variant of it, is the gold standard. It eliminates the need for coordination, produces time-sortable 64-bit integers at high throughput, and scales horizontally with ease. The tradeoffs (clock dependency, machine ID management) are well-understood and solvable.

The right choice, however, always depends on your constraints. If global uniqueness matters more than ordering, UUIDs win on simplicity. If you have a small, fixed cluster and need strict sequences, a ticket server is perfectly reasonable. Understanding the failure modes of each approach is what separates a design that works at 100 RPS from one that holds at 100,000.

That's all folks, Cheers!
