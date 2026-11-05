# Design A Distributed Message Queue

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

- Producers publish messages to named topics
- Consumers read via pull-based polling
- Retention with configurable TTL (default 7 days)
- Multiple consumers read the same message independently via consumer groups
- Ordering guaranteed within a partition
- Topic and partition management (create, configure, delete)
- Offset management (consumers track position independently)
- Configurable retention and log truncation

### Out of Scope

Kafka Streams (stream processing), Kafka Connect (external connectors), Schema Registry, exactly-once semantics, multi-datacenter replication.

### Non-Functional Requirements

- High throughput: 1 million messages/second ingestion
- Horizontal scalability via partition distribution across brokers
- High availability via partition replication across brokers
- Durability: committed messages survive broker failures
- Low latency: under 10ms end-to-end at p99
- At-least-once delivery

<<<SECTION 2>>>
## 2. Core Concepts

- **Topic:** a named feed of messages that producers write to and consumers read from; a logical grouping (payments, user-events, order-updates).
- **Partition:** a topic is split into N partitions, each an independent, ordered, append-only log. Partitions are the unit of parallelism and ordering: messages within one partition are consumed in production order; there is no ordering across partitions.
- **Offset:** a message's position in a partition, starting at 0 and incrementing by 1. Consumers track offsets independently, so multiple consumer groups can read one partition at different positions. This makes Kafka a streaming platform rather than a simple queue.

Example, topic payments with 3 partitions:
- Partition 0: offsets 0, 1, 2, 3...
- Partition 1: offsets 0, 1, 2...
- Partition 2: offsets 0, 1, 2, 3, 4...
- Consumer Group A reads Partition 0 at offset 3, Partition 1 at offset 2; Group B reads Partition 0 at offset 1 (behind A, independent).

<<<SECTION 3>>>
## 3. Capacity Estimation

- **Message size:** 1 KB average
- **Ingestion:** 1 million messages/second
- **Raw throughput:** 1M x 1 KB = 1 GB/second
- **Retention:** 7 days default
- **Raw storage:** 1 GB/sec x 86,400 x 7 = ~600 TB
- **Replication factor 3:** ~1.8 PB total
- **Brokers:** at 10 TB usable disk each, ~180 nodes for storage alone

At 1.8 PB, messages can't live in a traditional database. Sequential append-only log files on local disk are the only model meeting both the write throughput and cost efficiency needed.

## 4. System Components

### Broker

The core server. Stores partitions on local disk and serves all reads and writes for partitions it owns. Brokers collectively store all partitions; each is leader for some and follower for others.

### Partition Leader and Followers

Each partition has one leader and N-1 followers (N = replication factor). All reads and writes go to the leader; followers continuously replicate from it. If the leader fails, a follower is promoted.

### Controller (KRaft)

Handles cluster-wide coordination: tracking live brokers, managing partition leadership, handling broker failures, propagating metadata. Modern Kafka uses KRaft (Kafka Raft) for controller consensus instead of ZooKeeper. One broker is the active controller at any time.

### Producer Client

Library in the producer app handling partitioning, batching, compression, acknowledgement tracking, and retries: the throughput optimizations before messages reach a broker.

### Consumer Client

Library in the consumer app handling offset tracking, partition assignment within a group, heartbeats to the Group Coordinator, and polling.

### Group Coordinator

A broker role (not a separate process) managing group membership. Detects consumer failures via missed heartbeats, triggers rebalancing on membership changes, and tracks committed offsets per group per partition.

<<<SECTION 4>>>
## 5. Message Structure

**Message** fields:
- key: BYTES (optional, for partitioning and ordering)
- value: BYTES (payload)
- topic: STRING
- partition: INTEGER
- offset: LONG (assigned by broker on write)
- timestamp: LONG (producer or broker ingestion timestamp)
- size: INTEGER (bytes)
- headers: MAP<STRING, BYTES> (optional metadata)

The **key** matters most for ordering. Same-key messages route to the same partition via hash(key) % num_partitions, so all events for an entity (user_123, order_456) are consumed in order. Keyless messages go round-robin across partitions for maximum write parallelism.

<<<SECTION 5>>>
## 6. On-Disk Storage: The Commit Log

**Log-structured storage.** Each partition is an **append-only commit log** on local disk, Kafka's most fundamental design decision. Every write is a sequential append; no random writes. Sequential writes on SSDs and spinning disks are orders of magnitude faster than random ones, the main reason Kafka reaches 1 GB/second per broker.

### Segments

A partition log is split into **segments**, each a pair of files:

- partition-0/00000000000000000000.log (message data, base offset 0) + .index (sparse offset-to-byte-position index)
- 00000000001523800.log + .index (next segment, base offset 1,523,800)
- 00000000003047600.log + .index (active segment, currently written)

The filename is the **base offset** of the segment's first message. Each partition has exactly one **active segment**; when it hits its size limit (default 1 GB) or time limit (default 7 days), it closes and a new one starts.

- **.log file:** raw messages appended sequentially; each record has offset, timestamp, key size, value size, key, value.
- **.index file:** sparse map of offsets to byte positions in the .log, e.g. offset 0 -> byte 0, 100 -> 9,847, 200 -> 19,203, 300 -> 28,891. It has an entry roughly every 4 KB of log data, small enough to keep in memory while enabling fast lookups.

**Efficient offset lookup** (fetching offset 1,523,847):

1. **Find the segment:** binary search sorted segment filenames. 00000000001523800.log has the largest base offset ≤ 1,523,847.
2. **Find nearest index entry:** binary search the .index for the largest offset ≤ 1,523,847: offset 1,523,840 -> byte 4,521,334.
3. **Sequential scan:** seek to byte 4,521,334 in the .log and scan forward a few messages to 1,523,847.

Two binary searches plus a tiny scan: sub-millisecond across billions of messages, no database.

### Zero-Copy Transfer

Kafka serves consumers with the Linux sendfile() system call.

### Without zero-copy:

Disk -> Kernel buffer -> User space (broker) -> Kernel socket buffer -> Network: four copies.

### With zero-copy (sendfile):

Disk -> Kernel buffer -> Network directly: two copies, skipping user space. Message bytes never enter broker memory and the broker never allocates heap for payloads, a major throughput contributor.

**Log retention and truncation** policies:

- **Time-based:** delete segments older than retention.ms (default 7 days)
- **Size-based:** delete oldest segments when partition size exceeds retention.bytes
- **Compaction:** keep only the latest message per key (event sourcing, changelog topics)

A background log cleaner thread periodically deletes or compacts eligible non-active segments. The active segment is never touched.

<<<SECTION 6>>>
## 7. Replication and Fault Tolerance

### ISR - In-Sync Replica List

Each partition has a replication factor (typically 3). The **ISR** lists replicas caught up with the leader within a configurable lag threshold (default: last 10 seconds of messages). Example, Partition 0: Broker 1 (leader) at offset 1,523,847; Broker 2 at 1,523,847 (in ISR); Broker 3 at 1,523,840 (slightly behind, still in ISR if within threshold).

A follower too far behind (network issue, slow disk, GC pause) is removed from the ISR and re-added once caught up.

**Message commit:** a message is committed only when all current ISR replicas have written it locally; only then is the producer acknowledged. Any ISR member can thus become leader with no data loss.

**Producer acks:**

- acks=0: fire and forget; highest throughput, no durability.
- acks=1: leader acks after its local write; lost if the leader crashes before replication.
- acks=all: all ISR replicas ack; strongest durability, no loss while one ISR member survives. Mandatory for financial or critical pipelines.

**Leader election on broker failure:**

1. **Detection:** the Controller watches broker heartbeats; missing them for broker.session.timeout.ms (default 30 seconds) marks a broker dead.
2. **Selection:** for each partition led by the dead broker, a new leader is chosen from the ISR only; non-ISR replicas are behind and risk data loss.
3. **Propagation:** the Controller updates and propagates metadata; clients fetch it and redirect to the new leader.

Failover typically takes under 30 seconds.

**Unclean leader election.** If the ISR holds only the failed leader (all followers too far behind):

- **Wait for the leader to recover:** availability suffers, no data loss
- **Elect a non-ISR follower:** availability restored, but messages committed to the leader and not replicated are lost

Set via unclean.leader.election.enable: false for financial systems, true for log aggregation where availability beats perfect durability.

**Log truncation on recovery.** A recovered former leader:

1. Is no longer leader for any partition
1. Asks the current leader for the latest committed offset
1. Truncates any messages beyond it (written before the crash, not replicated)
1. Resumes as a follower replicating from the current leader

<<<SECTION 7>>>
## 8. Producer: High Throughput Optimizations

**1. Batching.** The producer buffers messages in memory per partition and sends batches:

- batch.size = 16384 (16 KB; send when the batch reaches this)
- linger.ms = 5 (or send after 5ms even if not full)

Instead of 1 million round trips/second, roughly 1000 batches of 1000 messages: 1000x less network overhead, and one disk write commits thousands of messages.

**2. Compression.** Batches are compressed before sending: compression.type = snappy (alternatives: lz4, gzip, zstd). Batched messages share structure (JSON with same keys, same-format log lines), so 4x to 10x ratios are common. The broker stores the compressed batch as-is and consumers decompress; the broker never decompresses, preserving zero-copy. A 16 KB batch compressed to 2-4 KB cuts bandwidth 4-8x and raises effective throughput proportionally.

**3. Partitioning.** A configurable **partitioner** picks each message's partition:

- **Key-based** (default with a key): partition = hash(message_key) % num_partitions. Same key, same partition, ordering per key. Use the entity ID (user_id, order_id, device_id) when per-entity ordering matters.
- **Round-robin** (default without key): even distribution for maximum parallelism, when ordering doesn't matter.
- **Custom:** application logic for domain routing (e.g. premium user events to dedicated partitions for priority processing).

**Retry and idempotency.** Producers retry failed sends with configurable backoff. To avoid duplicates, set enable.idempotence = true. The broker assigns each producer a **Producer ID (PID)** and tracks the last sequence number per partition; duplicates (same PID and sequence number) are deduplicated at the broker. This gives exactly-once semantics within one producer session.

<<<SECTION 8>>>
## 9. Consumer: Polling and Offset Management

**Pull-based consumption.** Consumers poll brokers rather than being pushed to. This gives full control over consumption rate, allows batched reads, and simplifies backpressure: a slow consumer polls less often without affecting the broker or other consumers.

```python
while True:
    records = consumer.poll(timeout_ms=1000)
    for record in records:
        process(record)
    consumer.commit_offsets()
```

**Offset tracking.** Each group tracks its committed offset per partition independently.

- **Auto commit:** every auto.commit.interval.ms (default 5 seconds). Simple, but a crash between commits causes reprocessing.
- **Manual commit:** explicitly after processing, so offsets are committed only after success. Used for at-least-once delivery with processing guarantees.

Committed offsets live in the internal, replicated topic __consumer_offsets.

### Consumer Groups and Partition Assignment

Within a group, each partition goes to exactly one consumer, enabling parallel consumption without duplicate processing. Example, topic payments (6 partitions), group payment-processors: Consumer 1 -> Partitions 0, 1; Consumer 2 -> 2, 3; Consumer 3 -> 4, 5.

- **Consumers < Partitions:** some consumers handle several partitions
- **Consumers = Partitions:** one each, perfect distribution
- **Consumers > Partitions:** extras sit idle

Partitions can be increased but never decreased, so set the count at creation based on maximum expected consumer parallelism.

**10. Consumer Group Rebalancing**

**Triggers:** a consumer joins; a consumer leaves (graceful shutdown); a consumer crashes (missed heartbeats for session.timeout.ms, default 45 seconds); a partition is added to the topic.

**Classic rebalancing (before Kafka 2.4), stop the world:**

1. Group Coordinator detects Consumer 2 crashed (missed heartbeats)
1. Coordinator notifies all consumers to rebalance
1. **All consumers stop and revoke all partition assignments**
1. All send JoinGroup to the Coordinator
1. Coordinator elects one consumer as Group Leader
1. Group Leader runs assignment (round-robin or range)
1. Group Leader sends assignments to the Coordinator
1. Coordinator distributes them
1. All consumers resume

During steps 3 to 9 (30 to 60 seconds in large groups), **the whole group consumes zero messages** and lag builds. One crash in a 100-consumer group pauses all 100, though 99 are healthy.

**Incremental Cooperative Rebalancing (Kafka 2.4+):**

1. Coordinator detects Consumer 2 crashed
1. Only its partitions (2 and 3) need reassignment
1. Consumers 1 and 3 keep consuming uninterrupted
1. Only Partitions 2 and 3 pause briefly
1. Consumer 1 takes Partition 2, Consumer 3 takes Partition 3
1. Full consumption resumes

Instead of 100% of consumption pausing for 45 seconds, only the affected partitions (33% here) pause briefly.

**Offset recovery after a crash.** If Consumer 2 crashes before committing, the Coordinator uses the **last committed offset** for Partitions 2 and 3, and the new consumer resumes there. Messages processed after that commit are reprocessed: the at-least-once guarantee. Consumers must process idempotently (track already-processed messages).

<<<SECTION 9>>>
## 11. Controller and Cluster Coordination (KRaft)

Modern Kafka uses **KRaft (Kafka Raft Metadata)** instead of ZooKeeper. A subset of brokers (typically 3) act as **KRaft controllers**, maintaining metadata via Raft consensus.

The active controller:

- Tracks broker liveness via heartbeats
- Manages partition leadership
- Handles broker failures and triggers leader elections
- Processes topic creation and deletion
- Propagates metadata changes to all brokers

Brokers cache metadata locally and serve it to clients. Clients cache it and refresh only on an error signalling stale metadata (connection refused, not-a-leader).

Raft keeps controller state consistent across the quorum. If the active controller fails, another controller node is elected via Raft leader election.

<<<SECTION 10>>>
## 12. Full Data Flow Summary

**Producer write:**
1. Producer app -> Producer Client library
2. Partitioner: hash(key) % num_partitions = Partition 2
3. Accumulate in in-memory batch buffer for Partition 2
4. batch.size reached OR linger.ms elapsed
5. Compress batch (snappy/lz4)
6. Send to Broker 3 (leader for Partition 2)
7. Broker 3 appends batch to active segment .log (sequential)
8. Followers (Brokers 1, 2) fetch from Broker 3 and append to their .log files
9. Both followers acknowledge to Broker 3
10. ISR acknowledged (acks=all): Broker 3 sends success to producer
11. Producer advances sequence number; batch complete

**Consumer read:**
1. Consumer Client polls Group Coordinator for assignment -> Partition 2
2. Sends fetch to Broker 3 (leader): offset=1,523,847, max_bytes=1MB
3. Broker 3 binary-searches segment filenames -> 00000000001523800.log
4. Binary-searches .index -> byte position 4,521,334
5. sendfile() zero-copy: disk -> kernel buffer -> network
6. Client receives batch, decompresses, processes
7. Client commits offset 1,523,848 to __consumer_offsets

**Broker failure:**
1. Broker 3 (leader for Partition 2) stops heartbeating
2. Controller waits session.timeout.ms (30 seconds), marks Broker 3 dead
3. Controller selects new leader from ISR: Broker 1
4. Metadata updated (Partition 2 leader = Broker 1) and propagated to all brokers
5. Producer and consumer clients fetch metadata and redirect writes and reads to Broker 1
6. Broker 3 recovers: contacts Broker 1 for latest committed offset, truncates uncommitted messages beyond it, resumes as follower for Partition 2

**Consumer group rebalance (incremental cooperative):**
1. Consumer 2 crashes (misses heartbeats for 45 seconds); Group Coordinator detects it
2. Consumers 1 and 3 continue uninterrupted
3. Only Partitions 2 and 3 (Consumer 2's) are revoked
4. Group Leader reassigns: Consumer 1 adds Partition 2, Consumer 3 adds Partition 3
5. They resume from the last committed offset
6. Consumer 2's uncommitted work is reprocessed (at-least-once)

**Log retention:**
1. Background log cleaner runs periodically
2. Checks non-active segments against retention.ms (7 days) and retention.bytes
3. Deletes segments past the threshold; never touches the active segment
4. For compacted topics, keeps only the latest message per key

<<<SECTION 11>>>
## 13. Resilience and Fault Tolerance

- **Replication factor 3:** a partition survives losing any two brokers at once. While one ISR member lives, no committed data is lost and the partition stays available.
- **ISR-based commit:** an acks=all success means the message is on all ISR replicas; no acknowledged message is lost whichever broker fails next.
- **Append-only log:** files are never modified in place, only appended and deleted (retention), so no random-write corruption. A crash mid-write leaves an incomplete trailing message that is detected and truncated on recovery.
- **Zero-copy transfer** also aids reliability: payloads never enter broker heap, so JVM garbage collection pauses can't corrupt in-flight messages or cause long pauses that trigger false failure detection.
- **KRaft controller quorum:** 3 controllers tolerate 1 failure with no impact; 5 tolerate 2 simultaneous failures.
- **Incremental Cooperative Rebalancing:** a consumer crash pauses only its partitions, not the whole group.
- **Idempotent producer:** prevents duplicates from retries. With at-least-once consumers and idempotent processing, this gives effectively-once end-to-end processing without distributed transactions.
- **__consumer_offsets replication:** offsets live in a replicated topic, not memory, so a Group Coordinator failure doesn't lose consumer positions.

<<<SECTION 12>>>
## 14. Technology Choices Summary

- **Broker Storage:** append-only commit log on local disk (sequential writes, orders of magnitude faster than random, no database overhead)
- **Segment Index:** sparse offset-to-byte-position .index per segment (binary search, O(log N) lookup)
- **Zero-Copy Transfer:** Linux sendfile() (disk to network bypassing user space, no broker heap for payloads)
- **Replication:** ISR-based synchronous replication (configurable via acks; no committed data loss while one ISR member survives)
- **Cluster Coordination:** KRaft (replaces ZooKeeper; Raft across controller quorum; sub-30-second leader election)
- **Producer Throughput:** batching + compression + partitioning (16 KB batches, snappy/lz4, key-based or round-robin)
- **Consumer Model:** pull-based polling, manual or auto commit (consumer controls rate, natural backpressure)
- **Offset Storage:** internal __consumer_offsets topic (replicated, survives broker failures, per consumer group)
- **Consumer Group Coordination:** Group Coordinator role + Incremental Cooperative Rebalancing (minimal pause on membership changes)
- **Partition Assignment:** round-robin or range by Group Leader (equal distribution; idle consumers when they exceed partitions)
- **Idempotent Producer:** Producer ID + per-partition sequence numbers (broker-side dedup, exactly-once within a producer session)
- **Log Retention:** time- and size-based segment deletion + compaction for changelog topics (per topic, background cleaner thread)
