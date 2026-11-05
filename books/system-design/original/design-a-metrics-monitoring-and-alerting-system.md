# Design A Metrics Monitoring and Alerting System

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

- Metrics collection from diverse sources (OS, database, endpoints, containers, custom application metrics)
- Metrics transmission from collection agents to the storage layer
- Time-series storage optimized for high write throughput and time-range queries
- Query engine for aggregations, rollups, and tag-based filtering
- Alerting with threshold-based and anomaly-based rules
- Visualization via dashboards and graphs
- Data retention with automatic downsampling of older data

## Out of Scope

- Log management (ELK stack territory)
- Distributed tracing (Jaeger, Zipkin)
- Incident management and on-call scheduling (PagerDuty)
- Application Performance Monitoring deep profiling

### Non-Functional Requirements

- High write throughput, 1 million data points per second sustained
- Low query latency, dashboard queries under 1 second
- High availability, monitoring systems must never go down (you cannot monitor your monitoring system going down)
- Horizontal scalability across all layers
- Data durability, no metric data loss even during broker or storage failures
- Configurable retention policies per metric

<<<SECTION 2>>>
## 2. What Makes Time-Series Data Different

Every previous system in this series stored business entities: users, posts, orders, files. A metrics system stores a fundamentally different data model.

A single metric looks like this:

cpu.usage{host=web-server-01, region=us-east}  72.3  timestamp=1728123456  
cpu.usage{host=web-server-01, region=us-east}  71.8  timestamp=1728123466  
cpu.usage{host=web-server-01, region=us-east}  74.1  timestamp=1728123476

Three properties make this fundamentally different from business data and require a specialized database:

**Property 1 - Time-range query pattern:** Every query is a time-range scan. “Give me CPU usage for web-server-01 between 2pm and 4pm yesterday” scans 720 consecutive data points. Standard databases index by primary key or arbitrary columns. Time-series databases index primarily by timestamp, making time-range scans the fast path rather than an afterthought.

**Property 2 - Extreme write throughput:** Business data writes are sporadic (a user places an order, a post is created). Metric data writes are continuous and uniform: every server emits every metric every 10 seconds, 24 hours a day, 7 days a week. At 1 million writes per second sustained, standard relational databases collapse. Time-series databases use LSM tree storage optimized for sequential append writes.

**Property 3 - Tiered retention with downsampling:** Business data is kept at full resolution forever. Metric data follows a tiered retention model where old data is automatically downsampled to lower resolution to control storage costs. Raw 10-second data becomes 1-minute averages after 7 days. This is a fundamental property of the workload, not an optional feature.

<<<SECTION 3>>>
## 3. Capacity Estimation

- **Infrastructure monitored:** 1000 server pools x 100 machines per pool = 100,000 machines
- **Metrics per machine:** 100 metrics (CPU, memory, disk, network, process metrics)
- **Total unique metric series:** 100,000 x 100 = 10 million series
- **Collection frequency:** every 10 seconds per series
- **Ingestion rate:** 10M series / 10 seconds = **1 million writes per second**
- **Raw data point size:** 16 bytes (8-byte timestamp + 8-byte float value)
- **Raw storage for 7 days:** 1M writes/sec x 16 bytes x 604,800 seconds = ~9.6 TB
- **With replication factor 3:** ~29 TB for raw tier
- **After downsampling (30 days at 1-minute, 1 year at 1-hour):** additional ~660 GB
- **With Gorilla compression (11x):** raw tier shrinks to under 1 TB effectively
- **Total compressed storage across all tiers:** ~3-4 TB

The storage footprint is manageable. The design challenge is **write throughput** at 1 million writes per second sustained, not storage volume.

<<<SECTION 4>>>
## 4. Push vs Pull Model

Before diving into architecture, the fundamental design choice: how do metrics get from agents to the ingestion layer?

### Pull Model (Prometheus Approach)

The metrics server scrapes each agent at regular intervals via HTTP:

Metrics Server -> GET http://web-server-01:9090/metrics (every 15 seconds)  
Metrics Server -> GET http://web-server-02:9090/metrics (every 15 seconds)

Advantages: simple agent implementation (just expose an HTTP endpoint), central control over scrape frequency, easy down detection (scrape failure = agent down).

Disadvantages: scraping 100,000 agents from a central server is a throughput bottleneck, does not work for short-lived batch jobs that finish before the next scrape, agents behind firewalls cannot be reached from outside.

### Push Model (Datadog / InfluxDB Approach)

Agents actively push metrics to the ingestion service:

web-server-01 Agent -> POST [https://ingest.metrics.com/v1/series](https://ingest.metrics.com/v1/series) (every 10 seconds)  
web-server-02 Agent -> POST [https://ingest.metrics.com/v1/series](https://ingest.metrics.com/v1/series) (every 10 seconds)

Advantages: works behind firewalls (outbound connections only), works for short-lived batch jobs, scales horizontally by adding ingestion servers, agent controls its own push frequency.

Disadvantages: harder to detect silent agents (silence vs down is ambiguous), agents must know the ingestion endpoint, risk of overwhelming ingestion during cascading failures.

Decision

For this design, the **push model** is the better choice. Scraping 100,000 agents from a central Prometheus instance creates a single throughput bottleneck. Push distributes load across the ingestion layer naturally and works across network boundaries and firewalls.

<<<SECTION 5>>>
## 5. System Components

### Metrics Agent

A lightweight process running on every monitored host, container, or service. Collects metrics from the local environment and pushes them to the Ingestion Service every 10 seconds.

Collection sources per agent:

- **OS metrics:** CPU usage, memory usage, disk I/O, network throughput, system load
- **Process metrics:** per-process CPU, memory, file descriptors
- **Container metrics:** Docker and Kubernetes container resource usage
- **Database metrics:** query latency, connection pool size, cache hit rate
- **Application metrics:** custom metrics emitted by the application via a client library (request count, error rate, queue depth)

The agent is intentionally lightweight. It collects, buffers locally for one collection interval, and pushes. It does not aggregate or transform data.

### Ingestion Service (Metrics Aggregator Gateway)

Sits between agents and the Kafka pipeline. Receives pushes from 100,000 agents simultaneously.

Responsibilities:

- **Protocol normalization:** agents speak different protocols (StatsD, Prometheus exposition format, OpenTelemetry, custom JSON). The Ingestion Service normalizes everything into a standard internal format.
- **Validation:** rejects malformed metrics (missing timestamps, invalid float values, metric names exceeding length limits) before they pollute the time-series DB.
- **Tag enrichment:** automatically appends standard tags (environment, cluster, datacenter, region) that individual agents should not need to know about.
- **Pre-aggregation:** for metrics where exact per-agent values are not needed, computes aggregates at the edge (average CPU across a pool of 100 identical servers) before forwarding, reducing downstream volume.
- **Rate limiting:** prevents misbehaving or compromised agents from flooding the pipeline.

The Ingestion Service is stateless and horizontally scalable. Load balancers distribute agent pushes across Ingestion Service instances.

### Kafka (Transmission Pipeline)

At 1 million writes per second, the time-series DB cannot receive writes directly from 100,000 agents. Kafka absorbs the write burst and decouples ingestion rate from storage write rate.

Topic: metrics.raw  
Partitions: 100 (partitioned by metric series key for ordering)  
Retention: 24 hours (short, just a buffer)

Kafka provides durability during time-series DB slowdowns or restarts. If the storage layer is briefly unavailable, metrics queue in Kafka and are written once storage recovers. No data loss.

### Time-Series Database

The core storage layer. Covered in depth in section 6.

### Query Service

Handles all read requests: dashboard queries, alert rule evaluations, and API queries. Reads from the time-series DB and automatically selects the appropriate storage tier (raw, 1-minute, or 1-hour) based on the requested time range.

Pre-computes and caches commonly queried aggregations (average CPU per service over last 5 minutes) to reduce time-series DB read load from the Alerting Service polling thousands of rules.

### Alerting Service

Evaluates alert rules against metrics data and triggers notifications. Covered in depth in section 7.

### Visualization Service

Dashboard and graph rendering. Reads from the Query Service. Supports time-series line graphs, heatmaps, bar charts, and single-stat panels. Think Grafana. Stateless and horizontally scalable.

<<<SECTION 6>>>
## 6. Time-Series Database: Storage Internals

### Why Not PostgreSQL or MongoDB

In PostgreSQL, each metric data point is a row. Reading one hour of data for one metric series at 10-second resolution requires scanning 360 rows. With 10 million metric series and billions of total rows, random disk seeks for each row are catastrophically slow. Write performance also collapses at 1 million inserts per second on a B-tree indexed table.

### Columnar Storage

Time-series databases store timestamps and values in separate columns rather than as complete rows per data point:

Timestamps column: \[1728123456, 1728123466, 1728123476, 1728123486...\]  
Values column:     \[72.3, 71.8, 74.1, 73.2...\]

This enables two critical compressions:

**Delta encoding for timestamps:**  
Timestamps are monotonically increasing and evenly spaced. Instead of storing the full 8-byte timestamp for each point, only the delta from the previous timestamp is stored:

First timestamp: 1728123456 (8 bytes, full value)  
Delta 2: 10               (1 byte, interval is constant)  
Delta 3: 10               (1 byte)  
Delta 4: 10               (1 byte)

8x compression on timestamps for regular collection intervals.

**XOR compression for values (Gorilla compression):**  
Developed by Facebook for their internal metrics system. Consecutive metric values tend to be similar (CPU does not jump from 72% to 99% in 10 seconds). XOR-ing consecutive float values produces a result with many leading zeros, which compresses to 2-3 bytes instead of 8 bytes:

72.3 XOR 71.8 = 00000000 00000001... (mostly zeros)  
71.8 XOR 74.1 = 00000000 00000011... (mostly zeros)

Combined with delta-encoded timestamps, Gorilla compression achieves roughly **1.37 bytes per data point** compared to 16 bytes raw. 11x compression. Our 9.6 TB of raw data becomes under 1 TB after compression.

TSM Files (Time-Structured Merge Tree)

InfluxDB uses TSM (Time-Structured Merge Tree) files, similar to LSM trees in Cassandra but optimized for time-series data.

### Write path:

**Step 1 - WAL (Write-Ahead Log)**  
Every incoming data point is first written sequentially to a WAL on disk. Fast sequential append, same as Kafka’s commit log. Provides durability if the process crashes before the in-memory cache is flushed.

**Step 2 - In-Memory Cache (Write Buffer)**  
Data points are simultaneously written to an in-memory write buffer. Recent reads are served from here without touching disk.

**Step 3 - TSM File Flush**  
When the in-memory cache reaches a size threshold (default 25 MB) or a time limit, it is flushed to disk as an immutable TSM file. TSM files are sorted by series key and timestamp, with columnar storage and Gorilla compression applied. The corresponding WAL entries are deleted after a successful flush.

**Step 4 - Compaction**  
Background compaction merges multiple smaller TSM files into larger ones, applies more aggressive compression, and performs downsampling of data that has aged past its raw retention threshold.

Series Key and Inverted Index

Each unique combination of metric name and tags defines a series:

cpu.usage{host=web-server-01, region=us-east}  
cpu.usage{host=web-server-02, region=us-east}  
memory.used{host=web-server-01, region=us-east}

The time-series DB maintains an **inverted index** mapping tag values to series keys:

host=web-server-01  -> \[series_1, series_3, series_7, ...\]  
region=us-east      -> \[series_1, series_2, series_3, ...\]  
metric=cpu.usage    -> \[series_1, series_2, series_4, ...\]

A query like “give me CPU usage for all hosts in us-east” uses the inverted index to find all matching series IDs instantly, then fetches their TSM data. No full table scan.

### High Cardinality Problem

The inverted index reveals the most dangerous pitfall in metrics system design. Using high-cardinality values as tags (user_id, request_id, trace_id) causes the number of unique series to explode:

cpu.usage{user_id=user_123}  -> 1 series  
cpu.usage{user_id=user_456}  -> 1 series  
...  
100 million users -> 100 million series

100 million series means 100 million inverted index entries. The index alone consumes hundreds of GB of memory and write performance collapses because every new user_id creates a new series and a new index entry.

Rule: only use low-cardinality values as tags (host, region, environment, service_name, cluster). Never use user IDs, request IDs, session IDs, or any unbounded value as a tag. If you need per-user metrics, aggregate them before storage (total_requests_per_minute per service, not per user).

### Storage Tiers

The time-series DB maintains three storage tiers:

Tier 1 (raw):       retention 7 days,   resolution 10 seconds  
Tier 2 (1-minute):  retention 30 days,  resolution 1 minute  
Tier 3 (1-hour):    retention 1 year,   resolution 1 hour

The Query Service automatically selects the appropriate tier based on the requested time range. A dashboard showing the last 2 hours gets raw data. A dashboard showing the last 3 months gets 1-hour aggregates.

<<<SECTION 7>>>
## 7. Downsampling

Background Downsampling Worker

A background Downsampling Worker runs on a schedule (typically hourly). It reads raw data from Tier 1, computes aggregations, and writes results to Tier 2. It does not run on-demand at query time.

### What Gets Computed:

For each metric series and each 1-minute window:

Raw 10-second data for cpu.usage{host=web-01} between 14:00 and 14:01:  
\[72.3, 71.8, 74.1, 73.2, 71.9, 72.8\]  (6 data points)  
  
Downsampled 1-minute aggregate:

```
{
    timestamp: 14:00:00,
    avg:   72.68,
    min:   71.8,
    max:   74.1,
    p95:   74.1,
    count: 6
}
```

Multiple aggregations are stored (avg, min, max, p95, count), not just average. This preserves the ability to answer “what was the peak CPU in the last month?” using the stored max value even after raw data is deleted. If only average were kept, peak and percentile queries on historical data would be impossible.

### Deletion of Raw Data

After the Downsampling Worker writes 1-minute aggregates for a time window, the raw data for that window ages out. Once it exceeds the 7-day raw retention threshold, the TSM compaction process deletes it during its regular compaction run.

Day 0-7:   Raw 10-second data in Tier 1  
           Downsampling Worker continuously writes 1-minute aggregates to Tier 2  
Day 7+:    Raw data ages past retention, deleted during compaction  
Day 8-30:  Only 1-minute aggregates available for this time range  
Day 30:    Downsampling Worker writes 1-hour aggregates to Tier 3  
           1-minute data ages out  
Day 31+:   Only 1-hour aggregates available

<<<SECTION 8>>>
## 8. Alerting Service

Alert Rule Configuration

Alert rules are stored in a Config DB (PostgreSQL) and cached in Redis on Alert Manager startup:

AlertRules

```pgsql
rule_id         UUID, primary key
name            VARCHAR
metric_query    TEXT (PromQL-style query expression)
condition       ENUM('greater_than', 'less_than', 'equals')
threshold       FLOAT
for_duration    INTEGER (seconds, threshold must be breached continuously)
severity        ENUM('info', 'warning', 'critical')
notification_channels JSONB (slack, pagerduty, email)
group_by        JSONB (tags to group related alerts)
created_at      TIMESTAMP
```

Alert Evaluation Pipeline

**Step 1 - Rule Sharding**  
10,000 alert rules are sharded across multiple Alert Manager instances by rule ID. Each instance owns a subset and evaluates them independently. No single instance evaluates all rules.

**Step 2 - Pre-computed Rollups**  
Instead of the Alert Manager querying raw time-series data for every rule every 60 seconds, the Query Service maintains pre-aggregated views of commonly alerted metrics (average CPU per host over last 5 minutes, p99 latency per endpoint over last 1 minute). Alert rules query these pre-computed aggregations, reducing time-series DB read load dramatically.

**Step 3 - Threshold Evaluation**  
Alert Manager evaluates each rule against the pre-computed metric value. If the threshold is breached, it checks the alert state from Redis.

Alert State Machine

The alert KV store (Redis) tracks state per rule per affected entity:

```
Key: alert:{rule_id}:{entity_tags_hash}
Value: {
    state: ENUM('inactive', 'pending', 'firing', 'resolved'),
    breached_at: timestamp,
    fired_at: timestamp,
    last_notified_at: timestamp
}
```

State transitions:

inactive -> pending   (threshold first breached)  
pending  -> firing    (threshold breached continuously for for_duration, e.g. 5 minutes)  
firing   -> resolved  (metric returns below threshold)  
resolved -> inactive  (cleanup after grace period)

The for_duration concept prevents flapping alerts where a metric briefly spikes above threshold for one data point and immediately triggers a notification. The alert only fires after continuous breach for the configured duration.

Once in firing state, no additional notifications are sent until resolved. last_notified_at enforces re-notification policies (re-notify if still firing after 4 hours).

**Step 4 - Kafka Fanout**  
When an alert transitions to firing, the Alert Manager publishes an alert event to Kafka:

Topic: alerts.fired  
Partitions: by severity (critical, warning, info)

Notification consumers subscribe to this topic and handle delivery to specific channels (PagerDuty, Slack, email, webhook).

### Alert Grouping

During a major outage, 500 servers might all breach CPU threshold simultaneously, generating 500 individual notifications. This is useless noise.

The Alert Manager groups related alerts by shared tags before notifying:

```
Group by: [alertname, region, service]
group_wait: 30s      (wait 30 seconds before sending first notification)
group_interval: 5m   (wait 5 minutes before sending group updates)
repeat_interval: 4h  (re-notify if still firing after 4 hours)
```

group_wait introduces a deliberate 30-second delay. During an outage, alerts cascade within seconds. The 30-second window collects all related alerts before sending one grouped notification:

Before grouping: 500 separate alerts  
After grouping:  1 alert "cpu.high on payments service in us-east, 500 instances affected"

### Alert Inhibition

Inhibition suppresses lower-level alerts when a higher-level alert is already firing:

```
Rule: if datacenter.down fires for region=us-east
      suppress all alerts where region=us-east
```

If the entire us-east datacenter is down, individual host-unreachable alerts for all 500 servers in that region are suppressed. Engineers focus on the root cause (datacenter down) rather than 500 symptom alerts.

### Alert Routing

Different alerts route to different notification channels based on severity and owning team:

severity=critical AND service=payments -> PagerDuty (immediate page)  
severity=warning  AND service=payments -> Slack [#payments](https://x.com/search?q=%23payments&src=hashtag_click)-alerts  
severity=info                          -> email digest (daily summary)

Kafka consumers implement this routing. Each consumer handles a specific notification channel and only processes alerts matching its routing rules.

<<<SECTION 9>>>
## 9. Query Service

### Query Language

The Query Service exposes a PromQL-style query language supporting:

```
# Average CPU across all hosts in us-east over last 5 minutes
avg(cpu.usage{region="us-east"}[5m])

# 99th percentile request latency per service
p99(request.latency{environment="production"}[1m]) by (service)

# Rate of HTTP 5xx errors per endpoint
rate(http.errors{status_code=~"5.."}[5m]) by (endpoint)
```

### Tier Selection

The Query Service automatically selects the storage tier based on the requested time range:

Last 6 hours   -> Tier 1 (raw 10-second data)  
Last 2 weeks   -> Tier 2 (1-minute aggregates)  
Last 6 months  -> Tier 3 (1-hour aggregates)

For queries spanning tier boundaries (last 10 days includes both Tier 1 and Tier 2 data), the Query Service stitches results from both tiers transparently.

### Query Caching

Frequently executed queries (dashboard panels that refresh every 30 seconds, alert rule pre-computations) are cached in Redis:

Key: query:{query_hash}:{time_bucket}  
Value: query result  
TTL: 60 seconds for recent data, longer for historical data

time_bucket rounds the current time to the nearest minute so queries from different dashboard viewers within the same minute hit the same cache entry.

<<<SECTION 10>>>
## 10. Full Data Flow Summary

Metrics Collection Flow:  
Agent on host -> collects OS, process, container, app metrics every 10 seconds  
Agent -> POST [https://ingest.metrics.com/v1/series](https://ingest.metrics.com/v1/series)  
Ingestion Service:  
    -> Protocol normalization (StatsD, OpenTelemetry, custom JSON -> internal format)  
    -> Validation (reject malformed metrics)  
    -> Tag enrichment (append region, environment, cluster)  
    -> Rate limiting per agent  
    -> Publish to Kafka (metrics.raw topic, partitioned by series key)  
  
Storage Write Flow:  
Kafka consumer -> Time-Series DB writer  
    -> Write to WAL (durability)  
    -> Write to in-memory cache (fast reads)  
    -> When cache full: flush to TSM file (columnar, Gorilla compressed)  
    -> Background compaction: merge small TSM files, delete old WAL entries  
  
Downsampling Flow:  
Downsampling Worker runs hourly:  
    -> Read raw Tier 1 data for elapsed windows  
    -> Compute avg, min, max, p95, count per 1-minute window per series  
    -> Write aggregates to Tier 2  
    -> After 30 days: compute 1-hour aggregates, write to Tier 3  
    -> Raw data deleted during TSM compaction after 7-day retention  
  
Dashboard Query Flow:  
User opens dashboard -> Visualization Service  
    -> Query Service: parse PromQL expression  
    -> Select storage tier based on time range  
    -> Redis cache check (query_hash + time_bucket)  
    -> Cache hit: return cached result  
    -> Cache miss: query Time-Series DB (inverted index -> series IDs -> TSM fetch)  
    -> Apply aggregations and mathematical functions  
    -> Cache result in Redis (TTL 60 seconds)  
    -> Return to Visualization Service for rendering  
  
Alert Evaluation Flow:  
Alert Manager instances (sharded by rule_id) evaluate rules every 60 seconds:  
    -> Fetch pre-computed metric rollup from Query Service (Redis-cached)  
    -> Compare against threshold  
    -> Check alert state from Redis (inactive/pending/firing/resolved)  
    -> If threshold breached:  
        -> State: inactive -> pending  
        -> If pending for > for_duration: pending -> firing  
        -> Publish alert.fired to Kafka  
    -> If threshold no longer breached:  
        -> State: firing -> resolved  
        -> Publish alert.resolved to Kafka  
  
Alert Notification Flow:  
Kafka alert consumers:  
    -> Group related alerts (group_wait 30 seconds)  
    -> Apply inhibition rules (suppress lower-level alerts)  
    -> Route by severity and service:  
        critical -> PagerDuty consumer -> PagerDuty API  
        warning  -> Slack consumer    -> Slack webhook  
        info     -> Email consumer    -> SES  
    -> Update last_notified_at in Redis  
    -> Re-notify if still firing after repeat_interval (4 hours)

<<<SECTION 11>>>
## 11. Resilience and Fault Tolerance

**Kafka as write buffer** means the time-series DB can be restarted, upgraded, or temporarily unavailable without losing metric data. Kafka retains 24 hours of metrics. Storage writers catch up from their Kafka offset on recovery.

**WAL durability** in the time-series DB means an agent crash or flush failure does not lose data. The WAL is replayed on restart before accepting new writes.

**TSM immutability** means completed TSM files are never modified. Compaction creates new files and atomically replaces old ones. A compaction crash leaves old files intact, no corruption.

**Alert state in Redis with PostgreSQL source of truth** means alert states survive Redis restarts. On Redis cold start, Alert Manager reloads rule configurations from PostgreSQL and rebuilds state by querying recent metric data. Brief state loss during Redis restart causes at-most-one duplicate notification, not missed alerts.

**Alert Manager sharding** means a single Alert Manager instance failure affects only its subset of rules. Other instances continue evaluating their rules unaffected.

**Ingestion Service statelessness** means any Ingestion Service instance can handle any agent push. Load balancer health checks remove failed instances within seconds. Agents retry failed pushes with exponential backoff.

**Multi-tier downsampling** means historical data is never lost due to raw retention expiry. Downsampling runs continuously and slightly ahead of raw retention windows. By the time raw data is deleted, its aggregates are already safely written to the next tier.

**High cardinality enforcement** at the Ingestion Service (rejecting metrics with cardinality-violating tags) protects the time-series DB from the most common failure mode that takes down production metrics systems.

<<<SECTION 12>>>
## 12. Technology Choices Summary

**Metrics Agent** -> Telegraf / Datadog Agent / Prometheus Node Exporter (Lightweight host process, push-based, 10-second collection interval)

**Ingestion Service** -> Custom stateless Go or Java service (Protocol normalization, validation, tag enrichment, rate limiting)

**Transmission Pipeline** -> Apache Kafka (1M writes/second buffer, 24-hour retention, partitioned by series key)

**Time-Series DB** -> InfluxDB / Prometheus / VictoriaMetrics (TSM columnar storage, Gorilla compression, inverted series index, tiered retention)

**WAL** -> Local disk append-only log per Time-Series DB instance (Durability for in-memory writes not yet flushed to TSM files)

**Downsampling Worker** -> Background scheduled job (Hourly runs, produces Tier 2 and Tier 3 aggregates from Tier 1 raw data)

**Query Service** -> Custom query engine with PromQL support (Tier-aware query routing, Redis result caching, pre-computed rollups for alerting)

**Query Cache** -> Redis with 60-second TTL (Dashboard query deduplication, alert rule pre-computation cache)

**Alert Config DB** -> PostgreSQL (Source of truth for alert rules, notification channels, routing configuration)

**Alert State Store** -> Redis (In-memory alert state machine per rule per entity, fast state transitions)

**Alert Manager** -> Sharded horizontally by rule_id (Threshold evaluation, grouping, inhibition, Kafka fanout)

**Notification Consumers** -> Per-channel Kafka consumers (PagerDuty, Slack, email, webhook, each independently scalable)

**Visualization Service** -> Grafana-style stateless dashboard renderer (Reads from Query Service, stateless, horizontally scalable)

That's all, folks...Cheers!!
