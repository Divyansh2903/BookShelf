# Design A Rate Limiter

<<<SECTION 1>>>
A rate limiter protects a system from spammers, misbehaving clients, or sudden traffic spikes. Goal: fast, fair, production-ready.

### Functional requirements

1. Track requests per user within a time window
2. Allow the request if under the limit
3. Reject with **HTTP 429 Too Many Requests** plus a **Retry-After** header (seconds the client must wait) if over the limit

**Placement:** inside or just before the API gateway, never after; requests must be stopped before they reach services. Usually it is middleware in the gateway, which then does both rate limiting and routing.

### The counting problem: why one server isn't enough

A per-server HashMap (userID → counter) fails with multiple servers:

User X -> Server 1 -> counter = 1
User X -> Server 2 -> counter = 1
User X -> Server 3 -> counter = 1

Three requests, but each server sees one. The counter must be centralized.

**Redis** fits: centralized, in-memory, with:
- **INCR** - atomic increment, no race conditions
- **TTL** - counter expires after 60s automatically, no cleanup job
- Microsecond reads - adds under 1ms per request

Flow:
1. Request comes in; check Redis for "userX:counter"
2. Not found → create it, counter = 1, TTL = 60s → allow
3. Found → INCR counter
4. Counter ≤ limit → allow; counter > limit → reject 429

### The database layer - two stores

<<<SECTION 2>>>
### Redis (primary store)

Stores counters and request timestamps. Ephemeral: if Redis restarts, counters reset, which is acceptable. Rules are re-cached from the Config DB on startup.

**Config DB (persistent store)** - rules such as free tier 100 req/hour, premium 10,000, OTP endpoint 3 per 10 minutes, kept in e.g. PostgreSQL. Schema: userID, tier, endpoint, maxRequests, windowSeconds. Rules are read at startup and cached in Redis, so every decision happens in Redis in microseconds, never touching the Config DB at runtime.

**The four windowing algorithms**

1. **Fixed window** - fixed 60s buckets; counter resets at the boundary. Simple, but has a boundary flaw: requests at 55-59s (5) in window 1 and at 1-5s (5) in window 2 give 10 requests in 10 seconds, double the limit, yet both windows pass.

2. **Sliding window** - always counts the last 60 seconds from now; no boundary bug, much fairer. In Redis, store each request timestamp in a sorted set and count those within the last 60s. Most production systems use this.

3. **Token bucket** - tokens added at a fixed rate up to a max (e.g. capacity 100 tokens, refill 10 tokens/second). Each request consumes one token: token available → consume 1, allow; bucket empty → reject 429. Naturally allows short bursts: an idle user has a full bucket and can fire 100 requests instantly. Good where bursts are legitimate (e.g. a developer's batch job). Used by Stripe, AWS API Gateway.

4. **Leaky bucket** - requests enter a queue processed at a fixed rate (e.g. 10 req/s) regardless of arrival rate; queue full → drop request. Output is always smooth, no bursts pass. Good when downstream needs steady flow (e.g. a payment processor that can't handle spikes). Trade-off: bursty but legitimate traffic gets queued or dropped, which can feel unfair.

**Which one to use?**
1. Fixed window - simple; only for non-critical internal tools
2. Sliding window - fairest; best for user-facing APIs
3. Token bucket - when bursts are acceptable (developer APIs)
4. Leaky bucket - when downstream needs steady flow (payments, billing)

### Non-functional requirements

**Scalability** - rate limiter servers scale horizontally. Redis scales via **Redis Cluster**, splitting the keyspace across nodes (User A's counter on node 1, User B's on node 2), with no single bottleneck.

**Latency** - the limiter is in the critical path of every request. Redis keeps the check under 1ms, and rules cached at startup mean zero DB hits at runtime.

**Availability** - if Redis goes down:
- **Fail open** - allow all requests; system stays up, protection temporarily lost.
- **Fail closed** - reject all requests; system protected but unusable.

Most production systems fail open: a few seconds of unprotected traffic beats the whole system going dark.
