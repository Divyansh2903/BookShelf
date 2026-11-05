# Design A Distributed Message Queue

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

- Producers publish messages to named topics
- Consumers read messages from topics via pull-based polling
- Message retention with configurable TTL (default 7 days)
- Multiple consumers can read the same message independently via consumer groups
- Message ordering guaranteed within a partition
- Topic and partition management (create, configure, delete topics)
- Offset management (consumers track their position independently)
- Configurable retention and log truncation

### Out of Scope

- Kafka Streams (stream processing layer)
- Kafka Connect (external system connectors)
- Schema Registry
- Exactly-once semantics
- Multi-datacenter replication

### Non-Functional Requirements

- High throughput, 1 million messages per second ingestion
- Horizontal scalability via partition distribution across brokers
- High availability via partition replication across brokers
- Durability, committed messages must survive broker failures
- Low latency reads and writes, under 10ms end-to-end at p99
- At-least-once delivery guarantee

<<<SECTION 2>>>
## 2. Core Concepts

Before going into architecture, the three foundational concepts that everything else builds on:

**Topic:** A named feed of messages. Producers write to topics. Consumers read from topics. A topic is the logical grouping of related messages (payments, user-events, order-updates).

**Partition:** A topic is split into N partitions. Each partition is an independent, ordered, append-only log. Partitions are the unit of both parallelism and ordering. Messages within a single partition are always consumed in the order they were produced. There is no ordering guarantee across partitions.

**Offset:** The position of a message within a partition. Offsets start at 0 and increment by 1 for every message. Consumers track their own offset independently, meaning multiple consumer groups can read the same partition at completely different positions simultaneously. This is what makes Kafka a streaming platform rather than a simple queue.

Topic: payments (3 partitions)  
  
Partition 0: \[offset 0\]\[offset 1\]\[offset 2\]\[offset 3\]...  
Partition 1: \[offset 0\]\[offset 1\]\[offset 2\]...  
Partition 2: \[offset 0\]\[offset 1\]\[offset 2\]\[offset 3\]\[offset 4\]...  
  
Consumer Group A: reading Partition 0 at offset 3, Partition 1 at offset 2  
Consumer Group B: reading Partition 0 at offset 1 (behind Group A, independent)

<<<SECTION 3>>>
## 3. Capacity Estimation

- **Message size:** 1 KB average
- **Ingestion rate:** 1 million messages per second
- **Raw throughput:** 1M x 1 KB = 1 GB/second incoming
- **Retention period:** 7 days default
- **Raw storage:** 1 GB/sec x 86,400 x 7 = ~600 TB
- **Replication factor 3:** 600 TB x 3 = ~1.8 PB total storage across cluster
- **Number of brokers:** assuming 10 TB usable disk per broker = ~180 broker nodes for storage alone

The storage challenge at 1.8 PB drives the core architectural decision: messages cannot be stored in a traditional database. Sequential append-only log files on local disk are the only storage model that achieves both the write throughput and the cost efficiency required at this scale.

## 4. System Components

### Broker

The core server in a Kafka cluster. A broker stores partitions on local disk and serves all reads and writes for the partitions it owns. A cluster of brokers collectively stores all partitions across all topics. Each broker owns a subset of partitions as leader and a subset as follower for other partitions.

### Partition Leader and Followers

Each partition has exactly one leader broker and N-1 follower brokers (where N is the replication factor). All reads and writes for a partition go to the leader. Followers continuously replicate from the leader to stay caught up. If the leader fails, a follower is promoted.

### Controller (KRaft)

The controller is responsible for cluster-wide coordination: tracking which brokers are alive, managing partition leadership assignments, handling broker failures, and propagating cluster metadata to all brokers. Modern Kafka uses the KRaft (Kafka Raft) protocol for controller consensus, replacing the older ZooKeeper dependency. One broker in the cluster acts as the active controller at any time.

### Producer Client

A library running inside the producer application that handles partitioning decisions, message batching, compression, acknowledgement tracking, and retry logic. The producer client is responsible for high-throughput optimizations before messages even reach a broker.

### Consumer Client

A library running inside the consumer application that handles offset tracking, partition assignment within a consumer group, heartbeat sending to the Group Coordinator, and message polling.

### Group Coordinator

A designated broker role (not a separate process) that manages consumer group membership. It detects consumer failures via missed heartbeats, triggers partition rebalancing when group membership changes, and tracks committed offsets per consumer group per partition.

<<<SECTION 4>>>
## 5. Message Structure

Every message written to Kafka has the following structure:

**Message**  
key         BYTES (optional, used for partitioning and ordering)  
value       BYTES (the actual message payload)  
topic       STRING  
partition   INTEGER  
offset      LONG (assigned by broker on write)  
timestamp   LONG (producer timestamp or broker ingestion timestamp)  
size        INTEGER (message size in bytes)  
headers     MAP<STRING, BYTES> (optional metadata key-value pairs)

The key is the most important field for ordering guarantees. All messages with the same key are routed to the same partition via hash(key) % num_partitions. This guarantees that all events for a specific entity (user_123, order_456) are always written to the same partition and therefore always consumed in order.

Messages with no key are distributed round-robin across partitions for maximum write parallelism.

<<<SECTION 5>>>
## 6. On-Disk Storage: The Commit Log

Log-Structured Storage

Each partition is stored on the broker's local disk as an **append-only commit log**. This is the most fundamental architectural decision in Kafka's design. Every write is a sequential append to the end of the log. There are no random writes. Sequential writes on modern SSDs and spinning disks are orders of magnitude faster than random writes, which is the primary reason Kafka achieves 1 GB/second throughput per broker.

### Segments

A partition log is divided into **segments**. Each segment is a pair of files:

partition-0/  
    00000000000000000000.log      (message data, base offset 0)  
    00000000000000000000.index    (sparse offset to byte position index)  
    00000000001523800.log         (next segment, base offset 1,523,800)  
    00000000001523800.index  
    00000000003047600.log         (active segment, currently being written)  
    00000000003047600.index

The filename is the **base offset** of the first message in that segment. There is always exactly one **active segment** per partition, the one currently being written to. When the active segment reaches its configured size limit (default 1 GB) or time limit (default 7 days), it is closed and a new active segment is created.

**The .log file** contains the raw message data appended sequentially. Each message record includes its offset, timestamp, key size, value size, key, and value.

**The .index file** is a sparse index mapping offsets to byte positions within the .log file:

offset 0        -> byte 0  
offset 100      -> byte 9,847  
offset 200      -> byte 19,203  
offset 300      -> byte 28,891

The index is sparse (not every offset, roughly every 4 KB of log data) to keep it small enough to hold in memory while still enabling fast lookups.

Efficient Offset Lookup

Fetching message at offset 1,523,847:

**Step 1 - Find the correct segment**  
Binary search across segment filenames (which are base offsets, sorted). Segment 00000000001523800.log has base offset 1,523,800 which is the largest base offset less than or equal to 1,523,847. This is our segment.

**Step 2 - Find nearest index entry**  
Binary search the .index file for the largest offset less than or equal to 1,523,847. Result: offset 1,523,840 -> byte position 4,521,334.

**Step 3 - Sequential scan**  
Seek directly to byte 4,521,334 in the .log file. Scan forward sequentially (only a few messages) until offset 1,523,847 is found.

Total cost: two binary searches plus a tiny sequential scan. Sub-millisecond even across billions of messages. No database involved.

### Zero-Copy Transfer

When serving messages to consumers, Kafka uses the Linux sendfile() system call for zero-copy transfer:

### Without zero-copy:

Disk -> Kernel buffer -> User space (broker) -> Kernel socket buffer -> Network

Four copies of the data.

### With zero-copy (sendfile):

Disk -> Kernel buffer -> Network (directly)

Two copies, skipping user space entirely. Message bytes never enter the broker application's memory. This is a major contributor to Kafka's throughput since the broker never allocates heap memory for message payloads.

Log Retention and Truncation

Kafka retains messages based on configurable policies:

- **Time-based retention:** delete segments older than [retention.ms](https://x.com//retention.ms) (default 7 days)
- **Size-based retention:** delete oldest segments when total partition size exceeds retention.bytes
- **Compaction:** instead of deleting by time, keep only the latest message per key (used for event sourcing and changelog topics)

A background log cleaner thread periodically checks non-active segments against retention policies and deletes or compacts eligible segments. Only non-active segments are deleted. The active segment is never touched by the cleaner.

<<<SECTION 6>>>
## 7. Replication and Fault Tolerance

### ISR - In-Sync Replica List

Every partition has a replication factor (typically 3). The **ISR (In-Sync Replicas)** is the list of replicas that are caught up with the leader within a configurable lag threshold (default: within the last 10 seconds of messages).

Partition 0, Replication Factor 3:  
    Broker 1 (Leader)    -> offset 1,523,847  
    Broker 2 (Follower)  -> offset 1,523,847 (in ISR)  
    Broker 3 (Follower)  -> offset 1,523,840 (slightly behind, still in ISR if within threshold)

If a follower falls too far behind (network issue, slow disk, GC pause), it is removed from the ISR. Once it catches up, it is added back.

**Message commit:** A message is considered committed only when all replicas in the current ISR have written it to their local log. The producer receives an acknowledgement only after the commit. This guarantees that any ISR member can become the new leader with no data loss.

Producer Acknowledgement Modes

Producers configure their durability requirement via the acks setting:

- acks=0: Fire and forget. Producer does not wait for any acknowledgement. Highest throughput, no durability guarantee.
- acks=1: Leader acknowledges after writing to its local log. Followers may not have the message yet. Message can be lost if leader crashes before replication.
- acks=all: All ISR replicas must acknowledge. Strongest durability guarantee. No data loss as long as at least one ISR member survives.

For financial or critical data pipelines, acks=all is mandatory.

Leader Election on Broker Failure

**Step 1 - Failure Detection**  
The Controller monitors all brokers via heartbeats. If a broker misses heartbeats for [broker.session.timeout.ms](https://x.com//broker.session.timeout.ms) (default 30 seconds), the Controller marks it as dead.

**Step 2 - New Leader Selection**  
For each partition whose leader was on the failed broker, the Controller selects a new leader from the ISR list only. Non-ISR replicas are ineligible because they are behind and promoting them risks data loss.

**Step 3 - Metadata Propagation**  
The Controller updates cluster metadata with new partition leadership assignments and propagates to all brokers. Producer and consumer clients fetch updated metadata and redirect to the new leader.

Failover typically completes in under 30 seconds.

Unclean Leader Election

If the ISR contains only the failed leader (all followers were too far behind), there are two options:

- **Wait for the failed leader to recover:** availability suffers, no data loss
- **Elect a non-ISR follower:** availability restored, potential data loss (messages committed to leader but not replicated are lost)

Configured via unclean.leader.election.enable. Set to false for financial systems. Set to true for log aggregation where availability matters more than perfect durability.

Log Truncation on Recovery

When a previously failed leader broker recovers:

1. It is no longer the leader for any partition
1. It contacts the current leader to find the latest committed offset
1. If it has messages beyond the committed offset (written before crash, not yet replicated), it truncates its log back to the committed offset
1. It resumes as a follower and replicates from the current leader

<<<SECTION 7>>>
## 8. Producer: High Throughput Optimizations

Optimization 1 - Batching

Instead of one network request per message, the producer accumulates messages in an in-memory buffer per partition and sends them as a batch:

Producer config:  
    batch.size   = 16384 (16 KB, send when batch reaches this size)  
    [linger.ms](https://x.com//linger.ms)    = 5     (or send after 5ms even if batch is not full)

Impact: Instead of 1 million network round trips per second, the producer sends roughly 1000 batches per second each containing 1000 messages. Network overhead drops by 1000x. Broker write efficiency improves dramatically since a single disk write commits thousands of messages.

Optimization 2 - Compression

Batches are compressed before transmission:

compression.type = snappy (alternatives: lz4, gzip, zstd)

Messages within a batch are highly compressible because they typically share structure (JSON with the same keys, log lines with the same format). Compression ratios of 4x to 10x are common. The broker stores the compressed batch as-is and consumers decompress on their end. The broker never decompresses, preserving the zero-copy property throughout the data path.

Impact: A 16 KB batch compressed to 2-4 KB reduces network bandwidth by 4-8x and increases effective throughput proportionally.

Optimization 3 - Partitioning

The producer client decides which partition each message goes to via a configurable **partitioner**:

### Key-based partitioning (default when key is present):

partition = hash(message_key) % num_partitions

All messages with the same key always go to the same partition. Ordering per key is guaranteed. Use the entity ID as the key (user_id, order_id, device_id) when per-entity ordering matters.

**Round-robin partitioning (default when no key):**  
Messages distributed evenly across all partitions for maximum write parallelism. Use when ordering does not matter and throughput is the priority.

**Custom partitioner:**  
Application-defined logic for domain-specific routing (send premium user events to dedicated partitions for priority processing).

Retry and Idempotency

Producers retry failed sends automatically with configurable backoff. To prevent duplicate messages from retries, enable idempotent producer mode:

enable.idempotence = true

The broker assigns each producer a **Producer ID (PID)** and tracks the sequence number of the last message it received from that producer per partition. Duplicate sends (same PID, same sequence number) are detected and deduplicated at the broker. This provides exactly-once semantics within a single producer session.

<<<SECTION 8>>>
## 9. Consumer: Polling and Offset Management

Pull-Based Consumption

Kafka uses a **pull model**. Consumers poll the broker for new messages rather than the broker pushing messages to consumers. This gives consumers full control over consumption rate, allows consumers to batch reads for efficiency, and simplifies backpressure handling (a slow consumer simply polls less frequently without affecting the broker or other consumers).

```python
while True:
    records = consumer.poll(timeout_ms=1000)
    for record in records:
        process(record)
    consumer.commit_offsets()
```

Offset Tracking

Each consumer group tracks its current position (committed offset) per partition independently. Two consumer groups reading the same partition maintain completely separate offsets.

**Auto commit:** Consumer commits offset automatically every [auto.commit.interval.ms](https://x.com//auto.commit.interval.ms) (default 5 seconds). Simple but risks reprocessing messages if a consumer crashes between commits.

**Manual commit:** Consumer commits offset explicitly after processing. Stronger guarantee that offsets are only committed after successful processing. Used for at-least-once delivery with processing guarantees.

Committed offsets are stored in a special internal Kafka topic called __consumer_offsets. This topic is itself replicated for durability.

### Consumer Groups and Partition Assignment

Within a consumer group, each partition is assigned to exactly one consumer. This is the fundamental rule that enables parallel consumption without duplicate processing within a group.

Topic: payments (6 partitions), Consumer Group: payment-processors  
  
Consumer 1 -> Partition 0, Partition 1  
Consumer 2 -> Partition 2, Partition 3  
Consumer 3 -> Partition 4, Partition 5

Scaling rules:

- **Consumers < Partitions:** some consumers handle multiple partitions
- **Consumers = Partitions:** perfect distribution, one partition per consumer
- **Consumers > Partitions:** excess consumers are idle (you cannot have more active consumers than partitions in a group)

This is why choosing the right number of partitions at topic creation matters. Partitions can be increased but never decreased. Set partition count based on the maximum expected consumer parallelism.

10. Consumer Group Rebalancing

Trigger Conditions

A rebalance is triggered when:

- A consumer joins the group (new consumer started)
- A consumer leaves the group (graceful shutdown)
- A consumer crashes (missed heartbeats for [session.timeout.ms](https://x.com//session.timeout.ms), default 45 seconds)
- A new partition is added to the topic

Classic Rebalancing - Stop The World Problem

In classic rebalancing (Kafka before 2.4):

1. Group Coordinator detects Consumer 2 crashed (missed heartbeats)
1. Group Coordinator sends rebalance notification to all consumers
1. **All consumers stop consuming and revoke all partition assignments**
1. All consumers send JoinGroup request to Group Coordinator
1. Group Coordinator elects one consumer as Group Leader
1. Group Leader runs partition assignment algorithm (round-robin or range)
1. Group Leader sends assignments to Group Coordinator
1. Group Coordinator distributes new assignments to all consumers
1. All consumers resume consuming

**The problem:** During steps 3 to 9 (which can take 30 to 60 seconds in large groups), **zero messages are consumed across the entire consumer group**. All partitions are paused. Message lag builds up. A 100-consumer group rebalancing because one consumer crashed pauses all 100 consumers even though 99 are perfectly healthy.

Incremental Cooperative Rebalancing (Modern Kafka 2.4+)

Incremental Cooperative Rebalancing solves the stop-the-world problem:

1. Group Coordinator detects Consumer 2 crashed
1. Only Consumer 2's partitions (Partition 2 and Partition 3) need to be reassigned
1. Consumer 1 and Consumer 3 continue consuming their current partitions without interruption
1. Only Partition 2 and Partition 3 pause briefly during reassignment
1. Consumer 1 picks up Partition 2, Consumer 3 picks up Partition 3
1. Full consumption resumes

Impact: instead of 100% of consumption pausing for 45 seconds, only the affected partitions (33% in this example) pause briefly. Healthy consumers are completely unaffected.

Offset Recovery After Consumer Crash

When Consumer 2 crashes before committing its last processed offset, the Group Coordinator uses the **last committed offset** for Partitions 2 and 3. The new consumer resumes from that committed offset.

Messages processed by Consumer 2 after its last commit but before crashing are reprocessed by the new consumer. This is the at-least-once delivery guarantee. Consumers must implement idempotent processing (track which messages have already been processed) to handle duplicates correctly.

<<<SECTION 9>>>
## 11. Controller and Cluster Coordination (KRaft)

Modern Kafka uses the **KRaft (Kafka Raft Metadata)** protocol for cluster coordination, replacing the older ZooKeeper dependency. A subset of brokers (typically 3) act as **KRaft controllers** and maintain cluster metadata using the Raft consensus algorithm.

The active controller is responsible for:

- Tracking broker liveness via heartbeats
- Managing partition leadership assignments
- Handling broker failures and triggering leader elections
- Processing topic creation and deletion requests
- Propagating cluster metadata changes to all brokers

All brokers cache cluster metadata locally and serve metadata requests to producer and consumer clients. Clients cache metadata and only refresh when they encounter an error (connection refused, not a leader error) indicating the metadata is stale.

The Raft protocol ensures the controller state is consistent across the controller quorum. If the active controller fails, one of the other controller nodes is elected as the new active controller via Raft leader election.

<<<SECTION 10>>>
## 12. Full Data Flow Summary

Producer Write Flow:  
Producer application -> Producer Client library  
    -> Partitioner: hash(key) % num_partitions = Partition 2  
    -> Accumulate in in-memory batch buffer for Partition 2  
    -> batch.size reached OR [linger.ms](https://x.com//linger.ms) elapsed  
    -> Compress batch (snappy/lz4)  
    -> Send batch to Broker 3 (leader for Partition 2)  
    -> Broker 3 writes batch to active segment .log file (sequential append)  
    -> Broker 3 sends fetch request to Followers (Broker 1, Broker 2)  
    -> Followers append to their local .log files  
    -> Both followers acknowledge to Broker 3  
    -> ISR has acknowledged (acks=all): Broker 3 sends success to Producer  
    -> Producer advances sequence number, batch complete  
  
Consumer Read Flow:  
Consumer Client polls Group Coordinator for partition assignment  
    -> Assigned: Partition 2 (owned by this consumer in the group)  
Consumer Client sends fetch request to Broker 3 (leader for Partition 2):  
    -> fetch offset=1,523,847, max_bytes=1MB  
Broker 3 locates message:  
    -> Binary search segment filenames -> segment 00000000001523800.log  
    -> Binary search .index file -> byte position 4,521,334  
    -> sendfile() zero-copy: disk -> kernel buffer -> network  
Consumer Client receives batch, decompresses, processes messages  
Consumer Client commits offset 1,523,848 to __consumer_offsets topic  
  
Broker Failure Flow:  
Broker 3 (leader for Partition 2) stops sending heartbeats  
Controller waits [session.timeout.ms](https://x.com//session.timeout.ms) (30 seconds)  
Controller marks Broker 3 dead  
Controller selects new leader from ISR: Broker 1  
Controller updates cluster metadata: Partition 2 leader = Broker 1  
Metadata propagated to all brokers  
Producer client fetches updated metadata, redirects writes to Broker 1  
Consumer client fetches updated metadata, redirects reads to Broker 1  
Broker 3 recovers:  
    -> Contacts Broker 1 for latest committed offset  
    -> Truncates log if it has uncommitted messages beyond committed offset  
    -> Resumes as follower for Partition 2  
  
Consumer Group Rebalance Flow (Incremental Cooperative):  
Consumer 2 crashes (misses heartbeats for 45 seconds)  
Group Coordinator detects failure  
Consumer 1 and Consumer 3 continue consuming uninterrupted  
Only Partition 2 and Partition 3 revoked (Consumer 2's partitions)  
Group Leader reassigns:  
    -> Consumer 1 adds Partition 2  
    -> Consumer 3 adds Partition 3  
Consumer 1 and Consumer 3 resume Partitions 2 and 3 from last committed offset  
Duplicate messages from Consumer 2's uncommitted work reprocessed (at-least-once)  
  
Log Retention Flow:  
Background log cleaner runs periodically  
Checks non-active segments against [retention.ms](https://x.com//retention.ms) (7 days) and retention.bytes  
Segments older than retention threshold deleted from disk  
Active segment never touched by cleaner  
For compacted topics: keeps only latest message per key, deletes older versions

<<<SECTION 11>>>
## 13. Resilience and Fault Tolerance

**Replication factor 3** ensures a partition survives the loss of any two brokers simultaneously. As long as one ISR member is alive, no committed data is lost and the partition remains available.

**ISR-based commit** guarantees that acknowledged messages are durable. A producer that receives acks=all success knows the message exists on all ISR replicas. No acknowledged message is ever lost regardless of which broker fails next.

**Append-only log** eliminates random write corruption. Log files are never modified in place. The only mutations are sequential appends (writes) and segment deletions (retention cleanup). Even a broker crash mid-write leaves the log in a recoverable state since the incomplete message at the end of the log is detected and truncated on recovery.

**Zero-copy transfer** is not just a throughput optimization but also a reliability feature. Since message bytes never enter broker heap memory, there is no risk of JVM garbage collection pauses corrupting in-flight messages or causing long broker pauses that trigger false failure detection.

**KRaft controller quorum** means cluster coordination survives controller failures. With 3 controller nodes, the cluster tolerates 1 controller failure with no impact. With 5 controller nodes, it tolerates 2 simultaneous failures.

**Incremental Cooperative Rebalancing** dramatically reduces the blast radius of consumer failures. A single consumer crash no longer pauses the entire consumer group, only the partitions that belonged to the crashed consumer.

**Idempotent producer** prevents duplicate messages from producer retries. Combined with at-least-once consumer semantics and idempotent consumer processing, the system achieves effectively-once end-to-end processing without the complexity of distributed transactions.

**__consumer_offsets replication** ensures committed consumer offsets survive broker failures. Offset data is stored in a replicated Kafka topic, not in memory, so a Group Coordinator broker failure does not cause consumers to lose their position.

<<<SECTION 12>>>
## 14. Technology Choices Summary

**Broker Storage** -> Append-only commit log on local disk (Sequential writes, orders of magnitude faster than random writes, no database overhead)

**Segment Index** -> Sparse offset-to-byte-position index per segment (.index files, binary search for O(log N) offset lookup)

**Zero-Copy Transfer** -> Linux sendfile() system call (Disk to network without entering user space, eliminates broker heap allocation for message payloads)

**Replication** -> ISR-based synchronous replication (Configurable via acks setting, no committed data loss as long as one ISR member survives)

**Cluster Coordination** -> KRaft (Kafka Raft Metadata protocol) (Replaces ZooKeeper, Raft consensus across controller quorum, sub-30-second leader election)

**Producer Throughput** -> Batching + Compression + Partitioning (16 KB batches, snappy/lz4 compression, key-based or round-robin partitioning)

**Consumer Model** -> Pull-based polling with manual or auto offset commit (Consumer controls consumption rate, backpressure handled naturally)

**Offset Storage** -> Internal __consumer_offsets topic (Replicated Kafka topic, survives broker failures, independent per consumer group)

**Consumer Group Coordination** -> Group Coordinator broker role + Incremental Cooperative Rebalancing (Minimal consumption pause on group membership changes)

**Partition Assignment** -> Round-robin or range assignment by Group Leader (Equal partition distribution across consumers, idle consumers when consumers exceed partitions)

**Idempotent Producer** -> Producer ID + per-partition sequence numbers (Duplicate detection at broker, exactly-once within a producer session)

**Log Retention** -> Time-based and size-based segment deletion + log compaction for changelog topics (Configurable per topic, background cleaner thread)

### That's all, folks..Cheers!
