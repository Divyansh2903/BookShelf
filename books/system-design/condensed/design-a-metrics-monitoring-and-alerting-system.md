# Design A Metrics Monitoring and Alerting System

<<<SECTION 1>>>
## 1. Requirements

**Functional:**
- Collect metrics from OS, databases, endpoints, containers, custom app metrics
- Transmit metrics from agents to storage
- Time-series storage for high write throughput and time-range queries
- Query engine: aggregations, rollups, tag filtering
- Threshold-based and anomaly-based alerting
- Dashboards and graphs
- Retention with automatic downsampling of older data

**Out of scope:** log management (ELK), distributed tracing (Jaeger, Zipkin), incident management and on-call (PagerDuty), APM deep profiling.

**Non-functional:**
- 1 million data points/s sustained
- Dashboard queries under 1 second
- High availability (you cannot monitor your monitoring system going down)
- Horizontal scalability in all layers
- No metric loss during broker or storage failures
- Configurable retention per metric

<<<SECTION 2>>>
## 2. What Makes Time-Series Data Different

Earlier systems stored business entities (users, posts, orders, files). A metric looks like:

```
cpu.usage{host=web-server-01, region=us-east}  72.3  timestamp=1728123456  
cpu.usage{host=web-server-01, region=us-east}  71.8  timestamp=1728123466  
cpu.usage{host=web-server-01, region=us-east}  74.1  timestamp=1728123476
```

Three properties require a specialized database:

1. **Time-range queries.** Every query is a time-range scan ("CPU for web-server-01 from 2pm to 4pm yesterday" scans 720 consecutive points). Standard DBs index by primary key or arbitrary columns; time-series DBs index primarily by timestamp, making range scans the fast path.
2. **Extreme write throughput.** Business writes are sporadic; metric writes are continuous and uniform (every server emits every metric every 10 seconds, 24/7). At 1M writes/s relational DBs collapse; time-series DBs use LSM tree storage optimized for sequential appends.
3. **Tiered retention with downsampling.** Business data stays at full resolution forever; old metric data is automatically downsampled to cut storage (raw 10-second data becomes 1-minute averages after 7 days). This is fundamental to the workload, not optional.

<<<SECTION 3>>>
## 3. Capacity Estimation

- **Machines:** 1000 pools x 100 = 100,000
- **Metrics per machine:** 100 (CPU, memory, disk, network, process)
- **Unique series:** 10 million
- **Collection:** every 10 seconds → **1 million writes/s**
- **Data point:** 16 bytes (8-byte timestamp + 8-byte float)
- **Raw, 7 days:** 1M x 16 B x 604,800 s = ~9.6 TB; ~29 TB at replication factor 3
- **Downsampled (30 days at 1-minute, 1 year at 1-hour):** ~660 GB more
- **Gorilla compression (11x):** raw tier under 1 TB
- **Total compressed, all tiers:** ~3-4 TB

Storage is manageable; the challenge is sustaining **1 million writes/s**.

<<<SECTION 4>>>
## 4. Push vs Pull Model

### Pull Model (Prometheus Approach)

The metrics server scrapes each agent over HTTP:

- Metrics Server -> GET http://web-server-01:9090/metrics (every 15 seconds)
- Metrics Server -> GET http://web-server-02:9090/metrics (every 15 seconds)

**Pros:** simple agents (just expose an HTTP endpoint), central control of scrape frequency, easy down detection (scrape failure = agent down).
**Cons:** scraping 100,000 agents centrally is a throughput bottleneck; misses short-lived batch jobs that finish before the next scrape; can't reach agents behind firewalls.

### Push Model (Datadog / InfluxDB Approach)

Agents push to the ingestion service:

- web-server-01 Agent -> POST https://ingest.metrics.com/v1/series (every 10 seconds)
- web-server-02 Agent -> POST https://ingest.metrics.com/v1/series (every 10 seconds)

**Pros:** works behind firewalls (outbound only), works for short-lived jobs, scales by adding ingestion servers, agent controls push frequency.
**Cons:** silent agents are hard to detect (silence vs down is ambiguous), agents must know the endpoint, risk of overwhelming ingestion during cascading failures.

**Decision: push.** Scraping 100,000 agents from one Prometheus instance is a single throughput bottleneck; push spreads load across the ingestion layer and crosses network boundaries and firewalls.

<<<SECTION 5>>>
## 5. System Components

### Metrics Agent

Lightweight process on every host, container, or service; pushes to the Ingestion Service every 10 seconds. Sources:
- **OS:** CPU, memory, disk I/O, network throughput, system load
- **Process:** per-process CPU, memory, file descriptors
- **Container:** Docker and Kubernetes resource usage
- **Database:** query latency, connection pool size, cache hit rate
- **Application:** custom metrics via client library (request count, error rate, queue depth)

It collects, buffers locally for one interval, and pushes; no aggregation or transformation.

### Ingestion Service (Metrics Aggregator Gateway)

Sits between 100,000 agents and Kafka:
- **Protocol normalization:** StatsD, Prometheus exposition format, OpenTelemetry, custom JSON → one internal format.
- **Validation:** rejects malformed metrics (missing timestamps, invalid floats, over-long names).
- **Tag enrichment:** adds standard tags (environment, cluster, datacenter, region) agents shouldn't need to know.
- **Pre-aggregation:** where per-agent values aren't needed, aggregates at the edge (average CPU across a pool of 100 identical servers), reducing downstream volume.
- **Rate limiting:** stops misbehaving or compromised agents from flooding the pipeline.

Stateless and horizontally scalable behind load balancers.

### Kafka (Transmission Pipeline)

At 1M writes/s, the time-series DB can't take writes directly from 100,000 agents. Kafka absorbs bursts and decouples ingestion from storage write rate.

- Topic: metrics.raw
- Partitions: 100 (by metric series key, for ordering)
- Retention: 24 hours (just a buffer)

If storage is slow or restarting, metrics queue in Kafka and are written on recovery. No data loss.

### Time-Series Database

Core storage; see section 6.

### Query Service

Handles dashboard queries, alert evaluations, and API queries; auto-selects tier (raw, 1-minute, 1-hour) by time range. Pre-computes and caches common aggregations (average CPU per service over 5 minutes) to cut DB load from the Alerting Service polling thousands of rules.

### Alerting Service

Evaluates rules and triggers notifications; see section 7.

### Visualization Service

Grafana-like dashboards (line graphs, heatmaps, bar charts, single-stat panels) reading from the Query Service. Stateless, horizontally scalable.

<<<SECTION 6>>>
## 6. Time-Series Database: Storage Internals

### Why Not PostgreSQL or MongoDB

In PostgreSQL each data point is a row; one hour of one series at 10-second resolution is 360 rows. With 10M series and billions of rows, per-row random disk seeks are catastrophically slow, and B-tree indexed inserts collapse at 1M/s.

### Columnar Storage

Timestamps and values are stored in separate columns:

- Timestamps column: [1728123456, 1728123466, 1728123476, 1728123486...]
- Values column: [72.3, 71.8, 74.1, 73.2...]

This enables two compressions.

**Delta encoding for timestamps.** Timestamps increase at even intervals, so store only the delta: first timestamp 1728123456 (8 bytes), then deltas 10, 10, 10 (1 byte each). 8x compression for regular intervals.

**XOR (Gorilla) compression for values.** Developed by Facebook. Consecutive values are similar (CPU doesn't jump 72% → 99% in 10 seconds), so XOR of consecutive floats has many leading zeros and compresses to 2-3 bytes instead of 8:

- 72.3 XOR 71.8 = 00000000 00000001... (mostly zeros)
- 71.8 XOR 74.1 = 00000000 00000011... (mostly zeros)

With delta timestamps, Gorilla achieves ~**1.37 bytes per point** vs 16 raw (11x); 9.6 TB raw becomes under 1 TB.

### TSM Files (Time-Structured Merge Tree)

InfluxDB uses TSM files, like Cassandra's LSM trees but tuned for time series. **Write path:**

1. **WAL:** each point is appended sequentially to a write-ahead log on disk (like Kafka's commit log), for durability if the process crashes before flush.
2. **In-memory cache:** points are simultaneously written to a write buffer; recent reads are served from it.
3. **TSM flush:** at a size threshold (default 25 MB) or time limit, the cache flushes to an immutable TSM file, sorted by series key and timestamp, columnar and Gorilla-compressed. Matching WAL entries are deleted after a successful flush.
4. **Compaction:** background merging of small TSM files into larger ones, with more aggressive compression and downsampling of data past raw retention.

### Series Key and Inverted Index

Each metric name + tag combination is a series:

- cpu.usage{host=web-server-01, region=us-east}
- cpu.usage{host=web-server-02, region=us-east}
- memory.used{host=web-server-01, region=us-east}

An **inverted index** maps tag values to series keys:

- host=web-server-01 -> [series_1, series_3, series_7, ...]
- region=us-east -> [series_1, series_2, series_3, ...]
- metric=cpu.usage -> [series_1, series_2, series_4, ...]

"CPU usage for all hosts in us-east" finds matching series IDs instantly, then fetches their TSM data. No full scan.

### High Cardinality Problem

The most dangerous pitfall: high-cardinality tags (user_id, request_id, trace_id) explode the series count. cpu.usage{user_id=user_123} and cpu.usage{user_id=user_456} are each a series, so 100 million users → 100 million series and index entries. The index alone takes hundreds of GB of memory, and writes collapse since every new user_id creates a new series and index entry.

**Rule:** tag only with low-cardinality values (host, region, environment, service_name, cluster). Never user IDs, request IDs, session IDs, or any unbounded value. Aggregate per-user metrics before storage (total_requests_per_minute per service, not per user).

### Storage Tiers

- Tier 1 (raw): retention 7 days, resolution 10 seconds
- Tier 2 (1-minute): retention 30 days, resolution 1 minute
- Tier 3 (1-hour): retention 1 year, resolution 1 hour

The Query Service picks the tier by time range: last 2 hours gets raw data; last 3 months gets 1-hour aggregates.

<<<SECTION 7>>>
## 7. Downsampling

A background **Downsampling Worker** runs on a schedule (typically hourly), reading Tier 1 raw data, computing aggregations, and writing them to Tier 2. It never runs at query time.

**What gets computed**, per series per 1-minute window. Raw 10-second data for cpu.usage{host=web-01} from 14:00 to 14:01: [72.3, 71.8, 74.1, 73.2, 71.9, 72.8] (6 points). Downsampled aggregate:

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

Storing avg, min, max, p95, and count (not just average) keeps questions like "peak CPU last month?" answerable after raw data is gone; with only averages, historical peak and percentile queries would be impossible.

### Deletion of Raw Data

Once aggregates for a window exist and raw data passes the 7-day threshold, TSM compaction deletes it during its regular run.

- **Day 0-7:** raw 10-second data in Tier 1; worker continuously writes 1-minute aggregates to Tier 2
- **Day 7+:** raw data deleted during compaction
- **Day 8-30:** only 1-minute aggregates for this range
- **Day 30:** worker writes 1-hour aggregates to Tier 3; 1-minute data ages out
- **Day 31+:** only 1-hour aggregates

<<<SECTION 8>>>
## 8. Alerting Service

**Rule configuration.** Rules live in a Config DB (PostgreSQL), cached in Redis when the Alert Manager starts. AlertRules:

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

**Evaluation pipeline:**
1. **Rule sharding:** 10,000 rules sharded by rule ID across Alert Manager instances, each evaluating its subset independently.
2. **Pre-computed rollups:** instead of querying raw data for every rule every 60 seconds, rules query the Query Service's pre-aggregated views (average CPU per host over 5 minutes, p99 latency per endpoint over 1 minute), cutting DB read load dramatically.
3. **Threshold evaluation:** on breach, check alert state in Redis.

**Alert state machine** (Redis, per rule per affected entity):

```
Key: alert:{rule_id}:{entity_tags_hash}
Value: {
    state: ENUM('inactive', 'pending', 'firing', 'resolved'),
    breached_at: timestamp,
    fired_at: timestamp,
    last_notified_at: timestamp
}
```

Transitions:
- inactive -> pending (threshold first breached)
- pending -> firing (breached continuously for for_duration, e.g. 5 minutes)
- firing -> resolved (metric back below threshold)
- resolved -> inactive (cleanup after grace period)

for_duration prevents flapping, where a one-point spike would immediately notify. While firing, no further notifications until resolved; last_notified_at enforces re-notification (e.g. after 4 hours still firing).

4. **Kafka fanout:** on firing, the Alert Manager publishes to topic alerts.fired, partitioned by severity (critical, warning, info). Notification consumers deliver to PagerDuty, Slack, email, webhook.

### Alert Grouping

In a major outage 500 servers may breach CPU at once, producing 500 useless notifications. The Alert Manager groups by shared tags:

```
Group by: [alertname, region, service]
group_wait: 30s      (wait 30 seconds before sending first notification)
group_interval: 5m   (wait 5 minutes before sending group updates)
repeat_interval: 4h  (re-notify if still firing after 4 hours)
```

Alerts cascade within seconds, so the deliberate 30-second group_wait collects them into one notification: 500 separate alerts become 1: "cpu.high on payments service in us-east, 500 instances affected".

### Alert Inhibition

Suppress lower-level alerts when a higher-level one fires:

```
Rule: if datacenter.down fires for region=us-east
      suppress all alerts where region=us-east
```

If us-east is down, the 500 host-unreachable alerts there are suppressed so engineers focus on the root cause.

### Alert Routing

By severity and owning team:
- severity=critical AND service=payments -> PagerDuty (immediate page)
- severity=warning AND service=payments -> Slack #payments-alerts
- severity=info -> email digest (daily summary)

Each Kafka consumer handles one channel and processes only alerts matching its routing rules.

<<<SECTION 9>>>
## 9. Query Service

### Query Language

PromQL-style:

```
# Average CPU across all hosts in us-east over last 5 minutes
avg(cpu.usage{region="us-east"}[5m])

# 99th percentile request latency per service
p99(request.latency{environment="production"}[1m]) by (service)

# Rate of HTTP 5xx errors per endpoint
rate(http.errors{status_code=~"5.."}[5m]) by (endpoint)
```

### Tier Selection

- Last 6 hours -> Tier 1 (raw 10-second)
- Last 2 weeks -> Tier 2 (1-minute aggregates)
- Last 6 months -> Tier 3 (1-hour aggregates)

Queries spanning tiers (last 10 days covers Tier 1 and Tier 2) are stitched transparently.

### Query Caching

Frequent queries (dashboard panels refreshing every 30 seconds, alert pre-computations) are cached in Redis:

- Key: query:{query_hash}:{time_bucket}
- Value: query result
- TTL: 60 seconds for recent data, longer for historical

time_bucket rounds to the nearest minute, so different viewers in the same minute share a cache entry.

<<<SECTION 10>>>
## 10. Full Data Flow Summary

**Collection:** agent collects OS, process, container, app metrics every 10s → POST https://ingest.metrics.com/v1/series → Ingestion Service: protocol normalization (StatsD, OpenTelemetry, custom JSON → internal) → validation → tag enrichment (region, environment, cluster) → per-agent rate limiting → Kafka (metrics.raw, partitioned by series key).

**Storage write:** Kafka consumer → TSDB writer → WAL (durability) → in-memory cache (fast reads) → flush to TSM when full (columnar, Gorilla) → background compaction merges small TSM files, deletes old WAL entries.

**Downsampling (hourly):** read elapsed Tier 1 windows → compute avg, min, max, p95, count per 1-minute window per series → write Tier 2 → after 30 days, 1-hour aggregates to Tier 3 → raw deleted in compaction after 7 days.

**Dashboard query:** Visualization Service → Query Service parses PromQL → selects tier by range → Redis check (query_hash + time_bucket) → hit: return; miss: query TSDB (inverted index → series IDs → TSM fetch) → apply aggregations and functions → cache in Redis (TTL 60s) → render.

**Alert evaluation** (instances sharded by rule_id, every 60s): fetch pre-computed rollup from Query Service (Redis-cached) → compare to threshold → check Redis state.
- Breached: inactive -> pending; if pending > for_duration, pending -> firing and publish alert.fired to Kafka.
- No longer breached: firing -> resolved; publish alert.resolved to Kafka.

**Notification:** Kafka alert consumers → group (group_wait 30s) → inhibition → route: critical → PagerDuty consumer → PagerDuty API; warning → Slack consumer → Slack webhook; info → Email consumer → SES → update last_notified_at in Redis → re-notify after repeat_interval (4 hours) if still firing.

<<<SECTION 11>>>
## 11. Resilience and Fault Tolerance

- **Kafka write buffer:** the TSDB can restart, upgrade, or be briefly down without loss; Kafka keeps 24 hours and writers catch up from offsets.
- **WAL:** an agent crash or flush failure loses nothing; the WAL replays on restart before new writes.
- **Immutable TSM files:** compaction writes new files and atomically replaces old ones; a crash leaves old files intact, no corruption.
- **Alert state in Redis, PostgreSQL as source of truth:** on Redis cold start, the Alert Manager reloads rules from PostgreSQL and rebuilds state from recent metrics. Brief state loss causes at most one duplicate notification, never missed alerts.
- **Alert Manager sharding:** one instance failing affects only its rules.
- **Stateless ingestion:** any instance handles any push; LB health checks remove failed instances within seconds; agents retry with exponential backoff.
- **Multi-tier downsampling:** runs slightly ahead of raw retention, so aggregates exist before raw data is deleted; history is never lost.
- **Cardinality enforcement at ingestion:** rejecting cardinality-violating tags protects the TSDB from the most common failure mode of production metrics systems.

<<<SECTION 12>>>
## 12. Technology Choices Summary

- **Metrics Agent:** Telegraf / Datadog Agent / Prometheus Node Exporter (lightweight, push-based, 10-second interval)
- **Ingestion Service:** custom stateless Go or Java (normalization, validation, tag enrichment, rate limiting)
- **Transmission:** Kafka (1M writes/s buffer, 24-hour retention, partitioned by series key)
- **Time-Series DB:** InfluxDB / Prometheus / VictoriaMetrics (TSM columnar storage, Gorilla compression, inverted series index, tiered retention)
- **WAL:** local append-only log per TSDB instance (durability for unflushed writes)
- **Downsampling Worker:** scheduled hourly job (Tier 2 and Tier 3 aggregates from Tier 1)
- **Query Service:** custom PromQL engine (tier-aware routing, Redis result caching, pre-computed alert rollups)
- **Query Cache:** Redis, 60-second TTL (dashboard dedup, alert pre-computation)
- **Alert Config DB:** PostgreSQL (rules, notification channels, routing config)
- **Alert State Store:** Redis (in-memory state machine per rule per entity)
- **Alert Manager:** sharded by rule_id (evaluation, grouping, inhibition, Kafka fanout)
- **Notification Consumers:** per-channel Kafka consumers (PagerDuty, Slack, email, webhook; independently scalable)
- **Visualization:** Grafana-style stateless renderer reading from the Query Service, horizontally scalable
