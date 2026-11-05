# Apache Kafka: Crash Course

<<<SECTION 1>>>
## How the World's Biggest Tech Companies Handle Millions of Events Per Second

### The Problem: Your Database Is Not a Message Queue

At Uber on a Friday night, hundreds of thousands of riders open the app at once. Every ride request, driver GPS ping, surge pricing recalculation, and payment event must be recorded and processed in real time. At peak, Uber processes roughly 1 trillion events per day.

Sent straight to PostgreSQL, that traffic slows the database, exhausts the connection pool, and takes it down. Before Uber, LinkedIn, and Netflix built event streaming infrastructure, this failure was common: a database designed for transactional workloads, not firehose ingestion, became the bottleneck for the whole platform.

LinkedIn hit this around 2010. Its infrastructure was a tangle of point-to-point pipelines; every consuming service needed its own custom connection, an unmaintainable web with dozens of services. A slow or down downstream service created backpressure that propagated upstream. Activity feeds, analytics, search indexing, and monitoring all competed to read the same databases and APIs. The system was brittle, slow, and hard to scale.

LinkedIn engineers Jay Kreps, Neha Narkhede, and Jun Rao built Kafka in response.

<<<SECTION 2>>>
## What Is Kafka?

Apache Kafka is a **distributed event streaming platform**: a high-throughput, fault-tolerant, persistent log between services. Producers write events; consumers read at their own pace; the two never talk directly, and the database never sees the raw firehose.

Analogy: a postal sorting facility accepts, sorts, and durably stores a continuous stream of letters (events). Recipients (consumers) collect mail when ready. No sender is blocked by a slow recipient.

This decoupling solves database bombardment: instead of 50,000 concurrent writes hitting the database, they hit Kafka, which is built for it, and one or a few consumers write to the database at a controlled, sustainable pace.

<<<SECTION 3>>>
## Kafka and the Database: A Better Architecture

Kafka plus a database is more powerful than either alone.

**Naive:** placing an order writes to the database, which must then trigger notifications, update inventory, feed analytics, and update search indexes, all synchronously in the same request. Slow, fragile, and tightly coupled.

**With Kafka:** placing an order writes one event ("order placed" + payload), and the HTTP response returns immediately. Independent background consumers then do their work: orders service writes the orders DB, inventory decrements stock, notifications sends a confirmation email, analytics records the event. Each fails, scales, and processes at its own rate independently.

The database now gets metered writes from one well-behaved consumer instead of thousands of concurrent users: a managed flow instead of a firehose.

It also gives **replayability**. The database holds current state; Kafka retains the full event history that produced it. A new service added six months later can replay the log from the beginning, which a database alone can't offer.

<<<SECTION 4>>>
## The Architecture of Kafka

### Events and Topics

An **event** records that something happened: key, value, timestamp, optional metadata headers. Events are organized into **topics**, roughly like a table or folder but an append-only, ordered log. Records are never updated or deleted, only appended.

### Partitions: The Unit of Parallelism

Each topic is split into **partitions**, ordered, immutable event sequences on disk. This is Kafka's core scaling mechanism: if one partition handles 100MB/s, 10 partitions handle 1GB/s.

Events with the same key always go to the same partition, guaranteeing per-key ordering. All events for a user ID or order ID are processed in order while millions of others are written to other partitions concurrently.

### Brokers and the Cluster

A cluster has multiple **brokers** (server nodes), with partitions distributed across them. Each partition has one leader broker handling reads and writes and zero or more followers replicating it. If a leader dies, a follower is promoted automatically. With replication factor 3 you can lose two brokers without data loss.

### Producers

Producers write events to a topic, optionally with a partition key. Kafka batches writes internally instead of one disk write per event, a large part of its throughput. Producers can wait for acknowledgment from one broker, all replicas, or none, trading durability for latency.

### Consumers and Consumer Groups

Instances in the same **consumer group** split partitions automatically: 12 partitions across 4 instances gives 3 each. Add instances to scale; remove them and Kafka rebalances.

Consumers track position with an **offset**, an integer marking how far they've read, which the consumer owns. Kafka doesn't push; consumers pull and advance the offset. A slow consumer therefore never exerts backpressure on Kafka or producers; it falls behind and catches up.

Different groups keep independent offsets, so analytics and notifications can consume the same topic at different speeds without interfering.

### Retention: Kafka Is Not a Queue

Traditional queues delete messages after consumption. Kafka retains events for a configurable period (days, weeks) or up to disk size limits. This enables replay and is a fundamental difference: Kafka is a log, not a queue.

### ZooKeeper and KRaft

Kafka historically used Apache ZooKeeper for cluster metadata, leader election, and configuration. Kafka 2.8 introduced **KRaft** mode, its own Raft-based consensus protocol, removing the ZooKeeper dependency; it became production-ready in 3.3. Modern deployments use KRaft, which simplifies operations considerably.

<<<SECTION 5>>>
## Kafka in Production: What Netflix and Uber Actually Do With It

**Netflix** runs its entire data pipeline on Kafka. Every play, pause, search query, and error log flows through Kafka before any downstream store: hundreds of billions of events per day. One canonical stream feeds real-time dashboards, offline warehouse analytics, recommendation model training, and A/B testing, with no consumer affecting another.

**Uber** rebuilt its data infrastructure around Kafka. Driver location updates, trip events, payment processing, and fraud detection all flow through it. Fraud detection consumes the payment stream in real time and flags suspicious transactions in milliseconds, impossible when it had to query a database per transaction.

<<<SECTION 6>>>
## A Kafka Producer and Consumer in Go

```go
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    "github.com/segmentio/kafka-go"
)

const (
    brokerAddress = "localhost:9092"
    topic         = "order-events"
)

// OrderEvent represents something that happened in our system
type OrderEvent struct {
    OrderID    string
    CustomerID string
    Amount     float64
    Status     string
}

func runProducer() {
    writer := kafka.NewWriter(kafka.WriterConfig{
        Brokers:      []string{brokerAddress},
        Topic:        topic,
        Balancer:     &kafka.Hash{}, // same key always goes to same partition
        BatchTimeout: 10 * time.Millisecond,
    })
    defer writer.Close()

    events := []kafka.Message{
        {
            Key:   []byte("order-1001"),
            Value: []byte(`{"order_id":"1001","customer_id":"cust-42","amount":89.99,"status":"placed"}`),
        },
        {
            Key:   []byte("order-1002"),
            Value: []byte(`{"order_id":"1002","customer_id":"cust-17","amount":240.00,"status":"placed"}`),
        },
        {
            Key:   []byte("order-1001"),
            Value: []byte(`{"order_id":"1001","customer_id":"cust-42","amount":89.99,"status":"payment_confirmed"}`),
        },
    }

    err := writer.WriteMessages(context.Background(), events...)
    if err != nil {
        log.Fatalf("failed to write messages: %v", err)
    }

    fmt.Printf("Produced %d order events to topic '%s'\n", len(events), topic)
}

func runConsumer(groupID string) {
    reader := kafka.NewReader(kafka.ReaderConfig{
        Brokers:  []string{brokerAddress},
        Topic:    topic,
        GroupID:  groupID, // consumer group, Kafka tracks offset per group
        MinBytes: 1,
        MaxBytes: 10e6,
        MaxWait:  1 * time.Second,
    })
    defer reader.Close()

    fmt.Printf("Consumer group '%s' waiting for messages...\n", groupID)

    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    for {
        msg, err := reader.FetchMessage(ctx)
        if err != nil {
            if err == context.DeadlineExceeded {
                fmt.Println("Consumer done (timeout reached)")
                break
            }
            log.Fatalf("fetch error: %v", err)
        }

        fmt.Printf(
            "[%s] partition=%d offset=%d key=%s value=%s\n",
            groupID,
            msg.Partition,
            msg.Offset,
            string(msg.Key),
            string(msg.Value),
        )

        // Commit offset only after successful processing
        // This is important: if processing fails, the offset is not advanced
        // and the message will be redelivered
        if err := reader.CommitMessages(ctx, msg); err != nil {
            log.Printf("failed to commit offset: %v", err)
        }
    }
}

func main() {
    // In a real system these run in separate services
    runProducer()

    // Two different consumer groups both reading the same topic independently
    // e.g., one for writing to DB, one for sending notifications
    go runConsumer("orders-db-writer")
    go runConsumer("orders-notifications")

    time.Sleep(12 * time.Second)
}
```

- The producer's Hash balancer sends events with the same order ID (key) to the same partition, so order 1001's "placed" and "payment confirmed" events are consumed in order.
- Two consumer groups (DB writer, notifications) read the same topic independently, each getting every event with no coordination.
- Offsets are committed only after successful processing, so a consumer crashing mid-processing reprocesses the message on restart instead of silently skipping it.
