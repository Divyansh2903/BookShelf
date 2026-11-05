# Apache Kafka: Crash Course

<<<SECTION 1>>>
## How the World's Biggest Tech Companies Handle Millions of Events Per Second

### The Problem: Your Database Is Not a Message Queue

Imagine you're an engineer at Uber. It's a Friday night, and across the globe, hundreds of thousands of riders are opening the app simultaneously. Every time someone requests a ride, every GPS ping from every driver, every surge pricing recalculation, every payment event. All of it needs to be recorded, processed, and acted upon in real time. At peak load, Uber processes roughly 1 trillion events per day.

Now imagine all of that traffic hitting a PostgreSQL database directly.

The database starts accepting writes. Then it slows down. Then the connection pool exhausts. Then it falls over entirely. You've just taken down Uber on a Friday night.

This isn't hypothetical. Before companies like Uber, LinkedIn, and Netflix built proper event streaming infrastructure, this exact failure mode was common. The database, designed for transactional workloads, not firehose ingestion, became the bottleneck that could bring down an entire platform.

LinkedIn faced this problem acutely around 2010. Their infrastructure was a tangle of point-to-point data pipelines. Every service that wanted to consume data from another service had to set up its own custom connection. With dozens of services, this became an unmaintainable web. More critically, when a downstream service was slow or went down, it would create backpressure that propagated upstream and threatened the entire system. Activity feeds, analytics, search indexing, and monitoring were all competing to read from the same databases and APIs. The system was brittle, slow, and increasingly impossible to scale.

Out of this pain, LinkedIn engineers Jay Kreps, Neha Narkhede, and Jun Rao built something new. They called it Kafka.

<<<SECTION 2>>>
## What Is Kafka?

Apache Kafka is a distributed event streaming platform.

Kafka sits between your services as a high-throughput, fault-tolerant, persistent log. Producers write events into Kafka. Consumers read from Kafka at their own pace. The two sides never talk directly to each other. The database never sees the raw firehose of incoming traffic.

It is like a postal sorting facility (imagine) . Thousands of letters (events) arrive continuously. The facility accepts them all, sorts them, and stores them durably. Recipients (consumers) pick up their mail when they're ready. The facility doesn't care how fast the recipients read, it just keeps accepting and storing. No sender ever gets blocked because a recipient is slow.

This decoupling is the foundational idea behind Kafka, and it solves the core database bombardment problem immediately. Instead of 50,000 concurrent writes hitting your database, you have 50,000 writes hitting Kafka, which is specifically engineered to handle exactly this, and then one or a few consumers reading from Kafka and writing to the database at a controlled, sustainable pace.

<<<SECTION 3>>>
## Kafka and the Database: A Better Architecture

The combination of Kafka and a database is more powerful than either alone.

In a naive architecture, a user action (example- placing an order) writes directly to the database, which then somehow needs to trigger notifications, update inventory, feed analytics, and update search indexes, all synchronously, all in the same request. This is slow, fragile, and couples every system together.

With Kafka in the picture, placing an order means writing one event to Kafka: "order placed, here's the payload." That's it. The HTTP response goes back to the user immediately. Then, in the background, independent consumers each do their own work: the orders service writes to the orders database, the inventory service decrements stock, the notifications service sends a confirmation email, the analytics pipeline records the event. Each of these can fail independently without affecting the others. Each can be scaled independently. Each processes at its own rate.

The database now receives writes at a metered, controlled pace from a single well-behaved consumer, not from thousands of concurrent users hammering it directly. You've turned an uncontrolled firehose into a managed flow.

This pattern also gives you something invaluable: replayability. The database reflects the current state of the world. Kafka retains the entire history of events that produced that state. If you introduce a new service six months later that needs historical data, it can replay the Kafka log from the beginning. You can't do that with a database alone.

<<<SECTION 4>>>
## The Architecture of Kafka

Understanding Kafka's internals explains why it can handle what a database cannot.

### Events and Topics

Everything in Kafka starts with an event, a record that something happened. An event has a key, a value, a timestamp, and optional metadata headers. Events are organized into topics. A topic is roughly analogous to a database table or a folder, except it's an append-only, ordered log. You don't update or delete records in a topic. You only append new events.

### Partitions: The Unit of Parallelism

Each topic is split into partitions. A partition is an ordered, immutable sequence of events stored on disk. This is Kafka's core scaling mechanism. If one partition can handle 100MB/s of throughput, a topic with 10 partitions can handle 1GB/s, you scale throughput by adding partitions.

Events with the same key always go to the same partition, which guarantees ordering for that key. This matters in practice: all events for a given user ID, or a given order ID, land in the same partition and are processed in order, even while millions of other events are being written to other partitions concurrently.

### Brokers and the Cluster

A Kafka cluster consists of multiple brokers (individual server nodes). Partitions are distributed across brokers. Each partition has one leader broker that handles reads and writes, and zero or more follower brokers that replicate the data for fault tolerance. If a leader broker dies, a follower is automatically promoted. This replication is what makes Kafka durable: with a replication factor of 3, you can lose two brokers and still serve all data without loss.

### Producers

Producers are the services that write events to Kafka. They write to a specific topic and can optionally specify a partition key. Kafka batches writes internally for efficiency, instead of doing one disk write per event, it accumulates events. It flushes them in batches, which is a large part of why Kafka achieves the throughput it does. Producers can be configured to wait for acknowledgment from one broker, all replicas, or none, trading durability guarantees for latency.

### Consumers and Consumer Groups

Consumers read events from topics. The powerful concept here is the consumer group. When multiple consumer instances belong to the same group, Kafka automatically distributes partitions among them. If a topic has 12 partitions and a consumer group has 4 instances, each instance gets 3 partitions. Add more consumer instances to scale throughput; remove instances and Kafka rebalances automatically.

Critically, consumers track their position in the log using an offset, a simple integer indicating which event they've read up to. The consumer owns this offset. Kafka doesn't push events to consumers; consumers pull events and advance their offset. This means a slow consumer never exerts backpressure on Kafka or on producers. It just falls behind temporarily and catches up when it can.

Different consumer groups maintain independent offsets. Your analytics pipeline and your notifications service can both consume the same topic, completely independently, at completely different speeds, without interfering with each other.

### Retention: Kafka Is Not a Queue

Traditional message queues delete messages after they're consumed. Kafka doesn't. It retains events for a configurable period, days, weeks, or based on disk size limits. This is what makes replayability possible, and it's a fundamental architectural difference. Kafka is a log, not a queue.

### ZooKeeper and KRaft

Historically, Kafka relied on Apache ZooKeeper to manage cluster metadata, leader election, and configuration. As of Kafka 2.8 and fully production-ready by Kafka 3.3, Kafka introduced KRaft mode, its own internal Raft-based consensus protocol, eliminating the ZooKeeper dependency entirely. Modern Kafka deployments use KRaft, which simplifies operations considerably.

<<<SECTION 5>>>
## Kafka in Production: What Netflix and Uber Actually Do With It

Netflix uses Kafka as the backbone of its entire data pipeline. Every play event, every pause, every search query, every error log flows through Kafka before reaching any downstream store. At their scale, this is hundreds of billions of events per day. Kafka allows Netflix to have one canonical stream of truth that feeds real-time dashboards, offline analytics in data warehouses, recommendation model training, and A/B testing systems, all from the same stream, without any of those consumers affecting the others.

Uber rebuilt its entire data infrastructure around Kafka. Driver location updates, trip events, payment processing, and fraud detection all flow through their Kafka cluster. Their fraud detection system consumes the payment event stream in real time and can flag suspicious transactions in milliseconds, something impossible when that logic had to query a database on every transaction.

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

In this code- The producer uses a Hash balancer, meaning events with the same order ID (the key) always land on the same partition, guaranteeing that the "placed" and "payment confirmed" events for order 1001 are consumed in order. Two separate consumer groups read the same topic independently. The database writer and the notifications service each get every event without any coordination between them. And offset commits occur only after successful processing, so if the consumer crashes mid-processing, it will reprocess that message on restart rather than silently skip it.

That's all, folks...Cheers!!
