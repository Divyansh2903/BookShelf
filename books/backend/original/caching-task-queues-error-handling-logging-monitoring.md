# Caching, Task Queues, Error Handling, Logging, Monitoring

<<<SECTION 1>>>
## Caching

Caching is the practice of storing the result of an expensive operation so you can serve it again without repeating the work. The "expensive operation" is usually a database query, an external API call, or a heavy computation.

The fundamental tradeoff is freshness versus speed. A cache is always a copy of the truth, not the truth itself. The moment you cache something, it starts going stale. Your job is deciding how much staleness is acceptable for a given piece of data.

### Where caches live:

In-process caching stores data in your application's memory. It is the fastest possible option because there is no network hop. The downside is that each instance of your application has its own cache, so in a horizontally scaled system you get inconsistency across instances. Good for rarely changing data like feature flags or config values.

Distributed caching (Redis, Memcached) lives outside your application as a shared service. All instances talk to the same cache, so you get consistency. There is a network hop, but it is still orders of magnitude faster than a database query. This is the standard choice for most production systems.

CDN caching sits at the network edge and handles static assets and cacheable HTTP responses. Not your application's concern directly, but worth understanding as part of the full picture.

**Cache invalidation** is the hard part. There is a famous saying that cache invalidation and naming things are the two hardest problems in computer science. The strategies are:

**TTL (Time To Live):** the cache entry expires after a set duration. Simple to implement, but you accept that stale data will be served during the TTL window.

**Write-through:** when you update the database, you also update or delete the cache entry immediately. Keeps the cache fresher but adds complexity to every write path.

**Event-driven invalidation:** something publishes an event when data changes, and a subscriber deletes the relevant cache key. Cleanest approach at scale but requires event infrastructure.

**Cache-aside** is the most common pattern. Your application checks the cache first. On a hit, return the cached value. On a miss, fetch from the database, store the result in the cache, then return it. Simple, explicit, and your application controls what gets cached and when.

A few things that bite people: caching data that changes frequently, caching data that is user-specific at a shared key (data leaking across users), not caching errors (a thundering herd of requests all missing the cache simultaneously and hammering your database), and forgetting to handle the cold start case where the cache is empty.

<<<SECTION 2>>>
## Task Queues

Some work should not happen inside the request-response cycle. Sending an email, resizing an uploaded image, generating a PDF, syncing data to a third-party API, these are all things the user does not need to wait for. Task queues let you push that work out of the HTTP handler and process it asynchronously.

The model is simple: a **producer** puts a job onto a queue, and one or more **workers** pull jobs off the queue and execute them. The HTTP request returns immediately after enqueuing. The user sees a response. The heavy work happens in the background.

POST /upload-video  
  -> store the raw file  
  -> enqueue job { type: "transcode", fileId: "abc123" }  
  -> return 202 Accepted   (not 200 — the work is not done yet)  
  
Worker picks up the job later:  
  -> transcodes the file  
  -> updates the database  
  -> sends the user a notification

Common queue systems: Redis-backed queues (BullMQ in Node.js, Celery with Redis in Python), RabbitMQ, Amazon SQS, and Kafka if you need something that also doubles as an event stream.

**Retries and idempotency** are non-negotiable. Workers fail. Networks drop. Your job must be safe to run more than once. If a transcoding job runs twice, you should end up with one transcoded file, not two. Design your jobs to be idempotent before you ever think about retry logic.

**Dead letter queues** hold jobs that have failed more times than your retry limit allows. Instead of silently dropping a failed job, you park it somewhere you can inspect it, fix the bug, and re-process it manually. Never design a queue system without a dead letter queue.

**Concurrency and backpressure** matter at scale. If you have ten workers and a million jobs land simultaneously, your workers need to pull at a rate your downstream systems (database, third-party APIs) can handle. Throttle worker concurrency intentionally.

Job visibility is something teams underestimate. "Is this job done yet?" is a question your users will ask. Build a way to track job status if it matters to the user experience.

<<<SECTION 3>>>
## Error Handling

Errors in a backend system fall into two broad categories: **operational errors** and **programmer errors**.

Operational errors are expected. They are part of normal system operation: a user provides invalid input, a database record is not found, a third-party API times out, a payment is declined. These are not bugs. They are conditions you anticipate and handle gracefully.

Programmer errors are bugs: a null dereference, an uncaught promise rejection, an out-of-bounds access. These are not conditions to handle at runtime. They should crash loudly, get logged immediately, and get fixed.

A common mistake is treating all errors the same way. If you catch every exception and return a generic 500, you are hiding operational errors that deserved a 404 or a 422, and you are also hiding real bugs under the same generic response. Both problems get harder to debug.

**Typed/custom error classes** are the cleanest way to model operational errors:

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

Your global error handler catches these typed errors and maps them to the right HTTP response. Anything that is not a known AppError subclass gets treated as an unexpected bug and returns a 500.

**Consistent error response shape** matters for API consumers:

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

Pick a shape and stick to it everywhere. If half your endpoints return { "error": "..." } and half return { "message": "..." }, client developers will despise your API.

**Error propagation** in async code requires discipline. In Node.js, unhandled promise rejections used to silently swallow errors. Always await properly or chain .catch(). In languages with checked exceptions, do not suppress exceptions just to make the compiler happy.

One more thing: do not expose stack traces or internal error details to clients in production. Log the full error internally. Send a clean, safe message externally.

<<<SECTION 4>>>
## Logging

Logging is your primary tool for understanding what your system did. Not what you think it did, what it actually did.

**Log levels** exist for a reason. Use them:

- DEBUG: fine-grained detail, useful during development, noisy in production
- INFO: normal operations worth recording (user created, job completed, service started)
- WARN: something unexpected but recoverable happened
- ERROR: something failed and needs attention
- FATAL: the application cannot continue and is shutting down

In production, running at DEBUG level floods your log storage and makes finding real problems harder. Run at INFO or WARN.

**Structured logging** is non-negotiable in a production system. Log JSON, not plain text strings.

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

The second format is queryable. You can filter by userId, aggregate by event, join logs from different services by requestId. The first format is a string you have to parse with regex and hope the format never changes.

**Correlation IDs / request IDs** connect all logs from a single request into one traceable thread. Generate a unique ID at the edge (in middleware), attach it to the request context, and include it in every log line emitted during that request. When a user reports a bug, you take their request ID and pull every log line from that request across every service.

What to log: lifecycle events (request received, request completed), decisions made by your system (payment declined because of insufficient funds, not just "payment failed"), external calls and their outcomes, and errors with full context.

What not to log: passwords, tokens, credit card numbers, PII you do not need. Log the user ID, not the user's full profile. Log that authentication failed, not the password that was attempted.

<<<SECTION 5>>>
## Monitoring

Logging tells you what happened. Monitoring tells you how your system is behaving right now, over time, at a glance.

The **three pillars of observability** are logs, metrics, and traces. Logs you know. Metrics are numerical measurements over time. Traces follow a single request as it travels through multiple services.

**Metrics** are what dashboards are built from. The four signals every backend service should track:

- **Latency**: how long requests take to complete (p50, p95, p99, not just average)
- **Traffic**: requests per second
- **Error rate**: percentage of requests resulting in errors
- **Saturation**: how full your resources are (CPU, memory, queue depth, DB connections)

These are called the **Four Golden Signals** and they come from Google's SRE book. If all four are healthy, your service is almost certainly fine. If any one of them degrades, you have a starting point for investigation.

**Alerting** is the part most teams get wrong initially. Alert on symptoms, not causes. "Error rate above 5% for 2 minutes" is a symptom, something is broken for users right now. "CPU above 80%" is a cause, maybe meaningful, maybe not. Alerting on every possible cause leads to alert fatigue where every alert gets ignored because there are too many of them.

**Distributed tracing** (Jaeger, Zipkin, Honeycomb, Datadog APM) lets you follow a single request through multiple services and see exactly where time was spent. When a request takes 2 seconds and you have five services involved, a trace tells you which service took 1.8 of those seconds. Without tracing, you are guessing.

**Health check endpoints** are simple but important. A /health route that returns 200 if the service is up, can reach the database, and can reach its critical dependencies. Your load balancer and orchestrator (Kubernetes) use this to decide whether to send traffic to an instance.

<<<SECTION 6>>>
## Graceful Shutdown

When your application process receives a termination signal (SIGTERM in Unix-like systems), the worst thing it can do is die immediately. Requests that are mid-flight get dropped. Jobs that are halfway through executing get abandoned and leave your data in a partial state. Database connections get cut without cleanup.

Graceful shutdown is the practice of catching that signal and finishing cleanly before exiting.

The sequence looks like this:

1. Receive SIGTERM  
2. Stop accepting new requests (close the HTTP server to new connections)  
3. Wait for in-flight requests to complete  
4. Finish or checkpoint any in-progress background jobs  
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

**The timeout** is the safety valve. You do not wait forever for requests to finish. Set a deadline, typically 10 to 30 seconds depending on your workload, and force-exit after that. A stuck request should not block your deployment indefinitely.

This matters enormously in containerized environments. Kubernetes sends SIGTERM before it kills a pod. If your application does not handle it, Kubernetes waits for its terminationGracePeriodSeconds (default 30 seconds) and then sends SIGKILL, which is an immediate hard kill. If your graceful shutdown completes before that deadline, your users never notice the pod was replaced. If it does not, you are dropping requests.

For task queue workers, graceful shutdown means finishing the current job before stopping, not abandoning it halfway and letting it hit the retry counter unnecessarily. Acknowledge or re-queue the current job explicitly as part of your shutdown sequence.

These six concerns are not independent. They interact constantly:

A request comes in. **Middleware** injects a request ID. The handler checks the **cache**. On a miss, it queries the database and stores the result. It enqueues a background **task** for a side effect. If anything goes wrong, **error handling** catches it, the **logger** records it with the request ID, and **monitoring** captures the error rate ticking up. When a deploy comes, **graceful shutdown** ensures the response finishes before the process dies.

None of these are features. They are the baseline of a production-grade backend. Build them in from the start, not as an afterthought.

That's all, folks...Cheers!!
