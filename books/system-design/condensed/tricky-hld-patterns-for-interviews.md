# Tricky HLD Patterns for interviews

<<<SECTION 1>>>
## 7 Important Backend & Distributed System Design Patterns

Modern backends serve millions of users and huge data volumes, and must stay reliable through failures, traffic spikes, and network instability. Companies like Netflix, Amazon, Uber, Google, and Meta rely on proven patterns for this. Seven covered here:

1. Write-Behind (Write-Back) Cache
2. Thundering Herd Problem
3. Distributed Transactions & Two-Phase Commit (2PC)
4. Materialized View Pattern
5. Bulk Processing Pattern
6. Read Replica Architecture
7. Global Rate Limiting

## 1. Write-Behind (Write-Back) Cache

Writes go to a fast cache (Redis, Memcached) first; a background worker later flushes them to the database in batches. This cuts DB write pressure and latency.

**Flow:** client sends write → data written to cache immediately → user gets a fast success response → background workers periodically persist to the DB.

**Why:** databases are often the bottleneck in high-write systems; synchronous writes raise latency and overload them. Write-behind reduces DB calls, batches writes, improves response times, and absorbs traffic bursts.

**Real-world:** social platforms use it for likes, view counts, post impressions, analytics counters. Instagram doesn't update the DB on every story view; counters accumulate in memory and flush periodically.

- **Advantages:** extremely fast writes, reduced DB load, better throughput, efficient batching.
- **Drawbacks:** data loss if the cache crashes before persistence; eventual rather than immediate consistency; needs retry and recovery mechanisms.
- **Best for:** analytics, counters and metrics, logging, high-frequency event ingestion.

## 2. Thundering Herd Problem

<<<SECTION 2>>>
## Overview

Many clients request the same resource at once after a cache miss or service recovery. Instead of one request rebuilding the cache, thousands hit the backend simultaneously and overwhelm the DB or service.

**Example:** product details cached for 30 minutes. On expiry, thousands of users request the same product, all bypass the cache and hit the DB, DB CPU spikes, latency rises.

**Causes:** cache expiration, service restart, traffic spikes, sudden reconnect storms.

**Solutions:**
1. **Request coalescing:** only one request rebuilds the cache; others wait.
2. **Distributed locks:** Redis or ZooKeeper locks so only one process does expensive recomputation.
3. **Randomized cache expiry:** avoid entries expiring simultaneously.
4. **Stale-while-revalidate:** serve stale data while refreshing asynchronously.
5. **Rate limiting:** protect downstream systems.

**Real-world:** during Amazon or Flipkart flash sales, cache invalidation can cause massive DB traffic bursts if not handled.

**Benefits of solving it:** stability, less DB overload, better UX, higher availability during spikes.

<<<SECTION 3>>>
## 3. Distributed Transactions & Two-Phase Commit (2PC)

One business transaction may span multiple services and databases (e.g. Order + Payment + Inventory). If one succeeds and another fails, the system becomes inconsistent. Distributed transactions ensure all participants either commit together or roll back together. **Two-Phase Commit (2PC)** is the best-known approach.

**Phase 1: Prepare.** The coordinator asks all participants if they're ready. Each validates the transaction, locks required resources, and replies YES or NO.

**Phase 2: Commit.**
- All YES → coordinator sends COMMIT; every participant permanently applies changes.
- Any NO → coordinator sends ROLLBACK; all changes are reverted.

<<<SECTION 4>>>
## Example

Bank transfer: (1) debit Account A, (2) credit Account B. Both must succeed together; if debit succeeds and credit fails, money disappears. 2PC guarantees atomicity across distributed services.

- **Advantages:** strong consistency, atomic transactions across services, reliable state management.
- **Drawbacks:** high latency, blocking, reduced scalability, coordinator becomes a bottleneck, difficult recovery.
- **Modern alternatives** (since 2PC is expensive and slow): Saga pattern, event-driven architecture, compensation transactions, eventual consistency.
- **Real-world:** traditional banking and financial platforms use distributed transactions because consistency is critical.

## 4. Materialized View Pattern

<<<SECTION 5>>>
## Overview

A **materialized view** is a precomputed, stored query result. Instead of re-running complex joins and aggregations, results are computed beforehand, greatly speeding reads. Analytical queries (dashboards, sales reports, user statistics, recommendation summaries) run in real time can overload the DB.

**Flow:** raw data stored normally → background jobs aggregate it → results stored separately → applications query the view directly.

**Real-world:** YouTube analytics dashboards don't compute total views, watch time, and engagement on every page load; metrics are periodically aggregated and stored.

- **Advantages:** extremely fast reads, simpler queries, lower DB CPU, better dashboard performance.
- **Drawbacks:** possibly stale data, needs synchronization logic, extra storage cost, complex refresh mechanisms.
- **Refresh strategies:** *scheduled* (every few minutes/hours), *incremental* (only changed data), *event-driven* (update when events occur).
- **Best for:** analytics dashboards, reporting, recommendation engines, data warehousing.

## 5. Bulk Processing Pattern

<<<SECTION 6>>>
## Overview

Bulk processing groups many small operations into larger batches, because network calls, disk operations, and DB writes are expensive. Instead of inserting 10,000 rows one by one, the system batches and inserts them together, reducing network overhead and greatly improving throughput.

Every DB operation has overhead (connection handling, disk sync, transaction setup, network latency); batching cuts these repeated costs.

**Real-world:** bulk email services send in batches; Kafka consumers process messages in batches for throughput; banks process settlement transactions in groups.

- **Advantages:** better throughput, lower infrastructure cost, fewer network calls, better CPU and disk utilization.
- **Drawbacks:** higher latency per item, partial batch failure complexity, harder retries, batch size needs tuning.
- **Best for:** ETL pipelines, data ingestion, notification services, logging, analytics pipelines.

## 6. Read Replica Architecture

## Overview

As apps grow, read traffic often far exceeds writes. One DB server may struggle with user queries, search, dashboard reads, and analytics. Read replicas are multiple copies of the primary database.

<<<SECTION 7>>>
## Architecture

- **Primary DB:** INSERT, UPDATE, DELETE.
- **Read replicas:** SELECT queries, reporting, search, analytics reads.

Data replicates asynchronously from primary to replicas.

**Benefits:**
1. Scalability: reads spread across servers.
2. Reduced primary load: primary focuses on writes.
3. Availability: if one replica fails, others keep serving.
4. Faster queries: heavy reads don't compete with writes.

**Challenges:**
1. Replication lag: replicas may not reflect the latest writes.
2. Eventual consistency: users may briefly see stale data.
3. Failover complexity: promoting replicas during outages is hard.

**Real-world:** social platforms use replicas for feed generation, profile viewing, search, recommendations; writes still go to the primary.

**Best for:** read-heavy apps, analytics, content platforms, large-scale APIs.

## 7. Global Rate Limiting

<<<SECTION 8>>>
## Overview

Rate limiting caps how many requests a user/client can make in a time window. Without it, systems are exposed to abuse, DDoS, traffic spikes, and resource exhaustion. **Global** rate limiting matters when traffic is served by multiple app servers.

**Why local limiting fails:** if each server counts independently, limits are inconsistent and users bypass them by hitting different servers. Global limiting uses centralized storage such as Redis.

**Algorithms:**
1. **Token bucket:** tokens refill at a fixed rate; requests consume tokens.
2. **Leaky bucket:** requests processed at a constant rate.
3. **Sliding window:** tracks requests in a moving window.
4. **Fixed window counter:** simpler but less accurate.

**Real-world:** API gateways (Stripe, Twitter limit API requests); login systems (prevent brute force); payment systems (protect expensive financial operations); AI platforms (control usage cost, prevent overload).

- **Advantages:** protects infrastructure, improves reliability, prevents abuse, fair resource allocation, controls operational cost.
- **Drawbacks:** extra infrastructure complexity, wrong limits hurt UX, distributed synchronization challenges.
- **Tools:** Redis, NGINX, Envoy Proxy, API Gateways, Cloudflare.

**What each pattern solves:**
- Write-Behind Cache: faster writes
- Thundering Herd: protection, traffic spikes, stability
- Distributed Transactions: strong consistency
- Materialized Views: faster reads
- Bulk Processing: higher throughput
- Read Replicas: read scalability
- Global Rate Limiting: system protection
