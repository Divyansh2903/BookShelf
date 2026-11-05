# Caching, Task Queues, Error Handling, Logging, Monitoring

<<<SECTION 1>>>
## Caching

Caching stores the result of an expensive operation (database query, external API call, heavy computation) to serve again without redoing it.

Trade-off: **freshness vs. speed**. A cache is a copy of the truth and starts going stale immediately; you decide how much staleness each piece of data tolerates.

**Where caches live**
- **In-process** (app memory): fastest, no network hop. Each instance has its own cache, so scaled-out instances become inconsistent. Good for rarely changing data like feature flags or config.
- **Distributed** (Redis, Memcached): a shared external service, so consistent across instances. A network hop, but orders of magnitude faster than a database query. The standard production choice.
- **CDN**: at the network edge, for static assets and cacheable HTTP responses. Not directly the app's concern.

**Cache invalidation** is the hard part (one of the "two hardest problems in computer science", with naming things):
- **TTL (Time To Live)**: entry expires after a set duration. Simple; stale data is served within the window.
- **Write-through**: on database update, update or delete the cache entry immediately. Fresher; complicates every write path.
- **Event-driven**: a data change publishes an event; a subscriber deletes the key. Cleanest at scale; needs event infrastructure.

**Cache-aside**, the most common pattern: check the cache; on a hit return it; on a miss fetch from the database, store it, return it. The app explicitly controls what is cached and when.

Pitfalls: caching frequently changing data; caching user-specific data under a shared key (leaks across users); not caching errors (a thundering herd of simultaneous misses hammers the database); ignoring the cold start when the cache is empty.

<<<SECTION 2>>>
## Task Queues

Work the user needn't wait for (sending email, resizing images, generating PDFs, syncing to third-party APIs) should leave the request-response cycle and run asynchronously. A **producer** enqueues a job; **workers** pull and run jobs; the HTTP request returns right after enqueuing.

Example, `POST /upload-video`: store the raw file → enqueue `{ type: "transcode", fileId: "abc123" }` → return `202 Accepted` (not 200: work isn't done). Later a worker transcodes the file → updates the database → notifies the user.

Common systems: Redis-backed queues (BullMQ in Node.js, Celery with Redis in Python), RabbitMQ, Amazon SQS, Kafka (if it should also be an event stream).

- **Retries and idempotency**: non-negotiable. Workers fail and networks drop, so jobs must be safe to run twice (a transcode run twice yields one file). Design idempotency before retry logic.
- **Dead letter queues**: hold jobs over the retry limit for inspection, bug fixes, and manual re-processing instead of silent drops. Always have one.
- **Concurrency and backpressure**: if a million jobs hit ten workers, they must pull at a rate downstream systems (database, third-party APIs) can handle. Throttle concurrency deliberately.
- **Job visibility**: often underestimated. If users will ask "is it done yet?", track job status.

<<<SECTION 3>>>
## Error Handling

Two categories:
- **Operational errors**: expected conditions (invalid input, record not found, third-party timeout, declined payment). Not bugs; handle gracefully.
- **Programmer errors**: bugs (null dereference, uncaught promise rejection, out-of-bounds access). Don't handle at runtime: crash loudly, log, fix.

Catching everything and returning a generic 500 hides operational errors that deserved a 404 or 422 and buries real bugs, making both harder to debug.

**Typed/custom error classes** model operational errors:

```javascript
class NotFoundError extends AppError {
  statusCode = 404;
  constructor(resource) {
    super(`${resource} not found`);
  }
}

class ValidationError extends AppError {
  statusCode = 422;
  constructor(violations) {
    super("Validation failed");
    this.violations = violations;
  }
}
```

A global error handler maps them to HTTP responses; anything not a known AppError subclass is an unexpected bug and returns 500.

**Consistent error response shape**:

```javascript
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "violations": [
      { "field": "email", "message": "must be a valid email address" }
    ]
  }
}
```

Use one shape everywhere; mixing `{ "error": "..." }` and `{ "message": "..." }` frustrates client developers.

**Async propagation**: Node.js unhandled promise rejections used to silently swallow errors, so always await properly or chain `.catch()`. With checked exceptions, don't suppress them to please the compiler.

Never expose stack traces or internal details to clients in production: log fully internally, send a clean, safe message externally.

<<<SECTION 4>>>
## Logging

Logging shows what the system actually did.

**Log levels**:
- DEBUG: fine detail for development, noisy in production
- INFO: normal notable operations (user created, job completed, service started)
- WARN: unexpected but recoverable
- ERROR: a failure needing attention
- FATAL: the app can't continue and is shutting down

Run production at INFO or WARN; DEBUG floods storage and hides real problems.

**Structured logging** (JSON, not plain strings) is non-negotiable in production.

### Bad:

\[2024-01-15 10:30:00\] User 123 placed order 456 for $99.00

### Good:

```json
{
  "timestamp": "2024-01-15T10:30:00Z",
  "level": "info",
  "event": "order_placed",
  "userId": 123,
  "orderId": 456,
  "amount": 9900,
  "requestId": "req_7f3a9b"
}
```

JSON is queryable: filter by userId, aggregate by event, join across services by requestId. The string needs regex parsing and breaks when its format changes.

**Correlation/request IDs**: generate a unique ID at the edge (middleware), attach it to the request context, and include it in every log line. A user's request ID then retrieves every log line from that request across all services.

**Log**: lifecycle events (request received/completed), system decisions (payment declined for insufficient funds, not just "payment failed"), external calls and outcomes, errors with full context.

**Don't log**: passwords, tokens, card numbers, unneeded PII. Log the user ID, not the profile; log that authentication failed, not the attempted password.

<<<SECTION 5>>>
## Monitoring

Logging says what happened; monitoring shows current and historical behavior at a glance.

**Three pillars of observability**: logs, metrics (numbers over time), traces (one request across services).

**Four Golden Signals** (Google's SRE book), which every backend should track:
- **Latency**: request duration (p50, p95, p99, not just average)
- **Traffic**: requests per second
- **Error rate**: percentage of failing requests
- **Saturation**: resource fullness (CPU, memory, queue depth, DB connections)

All healthy → service almost certainly fine; one degrading → where to start investigating.

**Alerting**: alert on symptoms, not causes. "Error rate above 5% for 2 minutes" means users are affected now; "CPU above 80%" may or may not matter. Alerting on every cause causes alert fatigue, and alerts get ignored.

**Distributed tracing** (Jaeger, Zipkin, Honeycomb, Datadog APM) shows where a request's time went: in a 2-second request across five services, which one took 1.8 seconds. Without it you're guessing.

**Health checks**: a `/health` route returning 200 if the service is up and reaches the database and critical dependencies. Load balancers and orchestrators (Kubernetes) use it to route traffic.

<<<SECTION 6>>>
## Graceful Shutdown

Dying immediately on SIGTERM (Unix-like systems) drops in-flight requests, leaves half-run jobs with partial data, and cuts database connections without cleanup. Graceful shutdown catches the signal and finishes cleanly:

1. Receive SIGTERM
2. Stop accepting new requests (close the HTTP server to new connections)
3. Wait for in-flight requests to complete
4. Finish or checkpoint in-progress background jobs
5. Close database connections and other resources
6. Exit with code 0

```javascript
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');

  server.close(async () => {
    await jobQueue.close();
    await db.disconnect();
    process.exit(0);
  });
});
```

**Timeout**: set a deadline (typically 10 to 30 seconds by workload), then force-exit, so a stuck request can't block deployment forever.

In Kubernetes, SIGTERM precedes pod termination; after `terminationGracePeriodSeconds` (default 30 seconds) it sends SIGKILL, an immediate hard kill. Finish before then and users never notice the pod replacement; otherwise requests drop.

Queue workers should finish the current job rather than abandon it and needlessly hit the retry counter; explicitly acknowledge or re-queue it during shutdown.

**How the six concerns interact**: **middleware** injects a request ID; the handler checks the **cache**, and on a miss queries the database and stores the result; it enqueues a background **task**; failures go through **error handling**, the **logger** records them with the request ID, and **monitoring** sees the error rate rise; on deploy, **graceful shutdown** lets the response finish.

These aren't features but the baseline of a production backend. Build them in from the start.
