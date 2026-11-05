# Design A Rate Limiter

<<<SECTION 1>>>
A rate limiter protects your system from being overwhelmed by spammers, misbehaving clients, or just a sudden traffic spike. Let's design one that's fast, fair, and production-ready.

### Functional requirements

3 behaviours the system must exhibit:

1. Track the number of requests per user within a time window  
2. Allow the request if under the limit  
3. Reject with HTTP 429 Too Many Requests + a Retry-After header if over the limit

The Retry-After header tells the client exactly how many seconds to wait before trying again.

Where does it sit exactly?

Inside or just before the API gateway, but never after. The whole point is to stop requests before they hit your services. If a request gets past the gateway, the damage is already done.

In most systems, the rate limiter lives inside the API gateway itself as middleware. So the gateway does two jobs: rate limiting and routing.

### The counting problem, basically why a single server isn't enough

The first instinct might be a HashMap on each server, the userID maps to a counter. But at scale you have multiple servers, and each one has its own HashMap:

User X -> Server 1 -> counter = 1  
User X -> Server 2 -> counter = 1  
User X -> Server 3 -> counter = 1

User made 3 requests, but every server thinks they made 1. Bypassed.

The counter needs to live somewhere centralized that every server talks to.

Redis is the right tool here  
Redis is the answer. It's centralized, in-memory, and has everything you need out of the box:

INCR command - atomically increments a counter, no race conditions  
 TTL - set the counter to expire after 60 seconds automatically, no cleanup job needed  
Microsecond reads - adds less than 1ms to every request

Request comes in

↓

Check Redis - does "userX:counter" exist?

↓

No  → create it, counter = 1, TTL = 60s → allow

Yes → INCR counter

↓

Counter ≤ limit → allow

Counter > limit → reject 429

### The database layer - two stores

<<<SECTION 2>>>
### Redis (primary store)

Stores counters and request timestamps. Ephemeral (temporary) by nature ,if Redis restarts, counters reset, which is acceptable. Rules are re-cached from the Config DB on startup.

**Config DB (persistent store)**  
Someone needs to define the rules like free tier gets 100 req/hour, premium gets 10,000, OTP endpoint gets 3 per 10 minutes. These live in a persistent DB like PostgreSQL:

Schema:   
userID   
tier   
endpoint   
maxRequests   
windowSeconds

The rate limiter reads these rules at startup and caches them in Redis , so every decision is made entirely in Redis, in microseconds, without ever touching the Config DB at runtime.

The four windowing algorithms

How you define and enforce the time window matters a lot. There are four classic approaches, each with different tradeoffs.

1. Fixed window

Divide time into fixed 60-second buckets. Counter resets at the boundary. Simple to implement, but has a known flaw (at the boundary of the window):

Window 1: requests at 55s, 56s, 57s, 58s, 59s -> 5

Window 2: requests at  1s,  2s,  3s,  4s,  5s -> 5

10 requests in 10 seconds. Double the limit. Both windows say fine.

2. Sliding window

Always look at the last 60 seconds from right now, a rolling window that moves with time. No boundary bug, much fairer. In Redis, store each request's timestamp in a sorted set and count how many fall within the last 60 seconds. Most production systems use this.

3. Token bucket

Imagine a bucket that holds tokens. Tokens are added at a fixed rate, say 10 tokens per second, up to a max of 100. Every request consumes one token. If the bucket is empty, the request is rejected.

Bucket capacity: 100 tokens

Refill rate:     10 tokens/second

Request comes in -> token available? -> consume 1, allow -> bucket empty? -> reject 429

The key advantage: it naturally allows short bursts. If a user hasn't made requests in a while, their bucket is full, they can fire off 100 requests instantly. Great for APIs where burst behaviour is legitimate, like a developer running a batch job.

Used by: Stripe, AWS API Gateway.

4. Leaky bucket

Requests go into a queue (the bucket). They're processed at a fixed rate, say 10 requests per second, no matter how fast they arrive. If the queue is full, new requests are dropped.

Requests pour in at any rate ->  queue → processed at fixed 10 req/s

-> queue full? -> drop request

The output is always smooth and predictable, no bursts ever make it through. This is great for systems where downstream services need a steady, controlled flow, like a payment processor that can't handle spikes.

The tradeoff: bursty but legitimate traffic gets queued or dropped, which can feel unfair to users.

Which one to use?

1. Fixed window - simple, use only for non-critical internal tools

2. Sliding window - fairest, best for user-facing APIs

3. Token bucket - best when bursts are acceptable (developer APIs)

4. Leaky bucket - best when downstream needs steady flow (payments, billing)

### Non-functional requirements

### Scalability

Rate limiter servers scale horizontally. Redis scales via Redis Cluster, splits the keyspace across multiple nodes. User A's counter lives on node 1, User B's on node 2. Distributes load cleanly without any single bottleneck.

### Latency

The rate limiter sits in the critical path of every single request, so if it's slow, your entire system feels slow. Redis keeps the check under 1ms. Rules are cached in Redis at startup so there's zero DB hit at runtime. The overhead is effectively invisible to the user.

### Availability

What happens if Redis goes down? Two options:

Fail open - allow all requests through. System stays up, protection is temporarily lost.

Fail closed - reject all requests. System is protected but nobody can use it.

Most production systems choose fail open. A few seconds of unprotected traffic is far better than your entire system going dark for all users.

That's mostly it, legends! Cheers!
