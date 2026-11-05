# Security, Scaling & Performance, Concurrency & Parallelism

<<<SECTION 1>>>
## Security

```javascript
// This blocks the event loop for every other request while it runs
app.get('/compute', (req, res) => {
  const result = heavyCpuComputation(); // bad on the main thread
  res.json({ result });
});
```

Security is not a feature you add at the end. It is a property you build into every layer of your system from the start. The goal is not to make your system impenetrable (nothing is) but to make it expensive enough to attack that attackers move on.

### Authentication vs Authorization

These two are confused constantly. Authentication answers "who are you?" Authorization answers "what are you allowed to do?" They are separate concerns and should live in separate layers.

Authentication typically happens at the middleware level. A JWT is verified, a session is validated, an API key is looked up. If authentication fails, you return 401 (Unauthorized, which confusingly means "not authenticated").

Authorization happens closer to the resource. Once you know who the user is, you check whether they have permission to perform the requested action. If they are authenticated but not permitted, you return 403 (Forbidden).

A common mistake is conflating the two, putting permission checks inside authentication middleware and having a single gate that tries to handle both. Keep them separate. Authentication tells you who is making the request. Authorization tells you what they can do with it.

### JWT and Sessions

JWTs are stateless tokens. The server issues a signed token containing claims (user ID, roles, expiry). On subsequent requests, the client sends the token back. The server verifies the signature and trusts the claims without hitting the database. Fast, stateless, and horizontally scalable.

The tradeoff: you cannot revoke a JWT before it expires. If a user logs out or gets banned, their token is still valid until expiry. Solutions include short expiry times (15 minutes) combined with refresh tokens, or maintaining a small revocation list in Redis.

Sessions are stateful. The server stores session data (in memory, Redis, or a database) and gives the client an opaque session ID in a cookie. On each request, the server looks up the session. This allows instant revocation but requires shared session storage in a scaled environment.

Neither is universally better. JWTs suit stateless APIs and mobile clients. Sessions suit traditional web apps where you control the client.

### Password Storage

Never store passwords in plaintext. Never store them as MD5 or SHA-256 hashes either. Those are fast hashing algorithms, which is exactly the wrong property for passwords. An attacker with your database can run billions of guesses per second against a SHA-256 hash.

Use bcrypt, scrypt, or Argon2. These are deliberately slow and memory-intensive. They also include a salt automatically, which means two identical passwords produce different hashes. Argon2 is the current recommendation from most security authorities.

```javascript
const hash = await bcrypt.hash(password, 12); // cost factor of 12
const valid = await bcrypt.compare(inputPassword, hash);
```

The cost factor controls how slow the hashing is. Higher is safer but slower. 10 to 12 is a reasonable default.

### Common Vulnerabilities

**SQL Injection**: an attacker injects SQL into user input, manipulating your query. The fix is parameterized queries or prepared statements, always. Never concatenate user input into a SQL string.

```javascript
// Vulnerable
db.query(`SELECT * FROM users WHERE email = '${email}'`);

// Safe
db.query(`SELECT * FROM users WHERE email = $1`, [email]);
```

**XSS (Cross-Site Scripting)**: an attacker injects JavaScript into your responses, which executes in other users' browsers. Sanitize output, use Content-Security-Policy headers, and avoid setting innerHTML with untrusted data.

**CSRF (Cross-Site Request Forgery)**: an attacker tricks a user's browser into making an authenticated request to your API from a malicious site. Mitigate with CSRF tokens for session-based apps, or rely on CORS and SameSite cookies.

**IDOR (Insecure Direct Object Reference)**: a user requests /orders/1234 and gets back an order that belongs to a different user because you only checked authentication, not authorization. Always verify that the authenticated user has the right to access the specific resource they are requesting, not just that they are logged in.

**Rate limiting and brute force protection**: login endpoints, password reset endpoints, and OTP verification endpoints need to be rate limited. An unprotected login endpoint can be brute-forced indefinitely. Apply exponential backoff and account lockout after repeated failures.

### Secrets Management

Never put secrets in your code. Not API keys, not database passwords, not JWT signing keys. Not even in a .env file that gets committed to the repository.

Use environment variables injected at runtime, or a proper secrets manager (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager). Rotate secrets regularly. Audit who has access. Treat a leaked secret as a compromised credential, rotate it immediately.

### Transport Security

Use HTTPS everywhere. TLS encrypts data in transit so that network observers cannot read or tamper with it. Enforce it: redirect HTTP to HTTPS, set Strict-Transport-Security headers, and never send sensitive data over plain HTTP.

Validate TLS certificates when making outbound requests to external services. Skipping certificate validation to "fix" a connection error is trading a network bug for a security hole.

<<<SECTION 2>>>
## Scaling and Performance

Scaling is about making your system handle more load. Performance is about making your system do more with what it already has. They are related but distinct. The best scaling strategy is to need less of it by first squeezing performance out of what you have.

### Vertical vs Horizontal Scaling

Vertical scaling means giving your server more resources: more CPU, more RAM, a faster disk. It is simple and requires no changes to your application. It also has a hard ceiling. You can only make a single machine so powerful, and past a certain point it becomes prohibitively expensive.

Horizontal scaling means adding more instances of your application and distributing load across them. It has no practical ceiling and is the model that modern cloud infrastructure is built for. The tradeoff is that your application must be designed for it: no local state, externalized sessions, distributed caching, and so on.

Most systems start vertical and move horizontal as they grow. Design for horizontal scaling from the start even if you do not need it yet. The habits are cheap; the refactoring later is not.

### Load Balancing

A load balancer sits in front of your application instances and distributes incoming requests. Common strategies are round-robin (each instance gets requests in turn), least connections (the instance with the fewest active connections gets the next request), and IP hashing (the same client IP always routes to the same instance, useful when you need session affinity).

Your application instances should be stateless so that any instance can handle any request. If instance A has local state that instance B does not, routing decisions become complicated and failures become painful.

### Database Performance

The database is almost always the bottleneck first. Application servers are stateless and scale horizontally easily. Databases carry state and are harder to scale.

**Indexing** is where most database performance wins come from. A query that scans a million rows can be made to scan a handful with the right index. Understand your query patterns and index the columns you filter and sort on. But do not over-index: every index slows down writes and consumes storage.

**N+1 queries** are a silent killer. You fetch a list of 100 users, then loop through them and fetch each user's orders with a separate query. That is 101 queries where 2 would do. Use eager loading (JOINs or ORM includes) to fetch related data in one round trip.

**Connection pooling** prevents your application from opening a new database connection on every request. Connections are expensive to establish. A pool maintains a set of open connections and lends them out to requests. PgBouncer for PostgreSQL, or connection pool settings built into your ORM.

**Read replicas** let you distribute read traffic. Most applications read far more than they write. A primary handles writes, one or more replicas handle reads. Replication lag is a real concern: a write on the primary may not be visible on a replica immediately. Know which reads need to be strongly consistent (hit the primary) and which can tolerate slight lag (hit the replica).

**Pagination** is not optional at scale. Returning all records from a table to a client is a performance disaster. Use cursor-based pagination (more efficient) or offset-based pagination (simpler), and enforce reasonable page size limits.

### Caching for Performance

This connects back to the caching section: aggressively cache what you can. A cache hit means no database query, no computation, just a memory read. The difference between serving a response from cache versus from the database under load is often the difference between a system that holds up and one that falls over.

### Profiling and Identifying Bottlenecks

Do not guess where your performance problems are. Profile first. In Node.js, use the built-in profiler or clinic.js. In Python, use cProfile or py-spy. In Java, use async-profiler or JFR.

Look for: slow database queries (use your database's slow query log), excessive memory allocation, CPU-bound work blocking your event loop, and unnecessary serialization or deserialization.

A common trap is optimizing the wrong thing. Spending a week shaving 10ms off a function that runs once per hour while a 200ms database query runs on every request is a bad trade. Profile, find the real hotspot, fix that.

### API Design for Performance

Keep response payloads lean. Do not return 50 fields when the client needs 5. Consider field selection (letting clients specify which fields they need) or GraphQL if over-fetching is a persistent problem.

Compress responses with gzip or Brotli. A 500KB JSON payload compressed to 50KB means less bandwidth and faster transfer times, especially on mobile.

Design for client-side caching too. Use ETags and Cache-Control headers so clients can skip the request entirely if their cached version is still fresh.

<<<SECTION 3>>>
## Concurrency and Parallelism

These two terms get used interchangeably but they mean different things. Concurrency is about dealing with multiple things at once. Parallelism is about doing multiple things at once. You can have concurrency without parallelism.

A single-core CPU running an event loop is concurrent: it switches between tasks rapidly, making progress on multiple things. It is not parallel: only one thing is executing at any given instant. Two CPU cores processing two tasks simultaneously is parallel.

### The Event Loop Model (Node.js)

Node.js runs on a single thread with an event loop. It handles concurrency through non-blocking I/O. When your code makes a database query, it does not sit and wait. It registers a callback and hands control back to the event loop, which picks up the next waiting task. When the database responds, the callback runs.

This model is extremely efficient for I/O-bound work (web servers, API gateways, anything waiting on databases or network). It is a poor fit for CPU-bound work. A single heavy computation blocks the entire event loop, stalling every other request.

```javascript
// This blocks the event loop for every other request while it runs
app.get('/compute', (req, res) => {
  const result = heavyCpuComputation(); // bad on the main thread
  res.json({ result });
});
```

For CPU-bound work in Node.js, offload to Worker Threads or a separate process. Do not block the event loop.

### Threading Models (Java, Go, Python)

Java uses OS threads. Each request gets a thread from a pool. Threads can run in true parallel on multi-core CPUs. The cost is memory (each thread has a stack, typically 1MB+) and context-switching overhead. Thread pools must be sized carefully: too small and requests queue up, too large and you exhaust memory.

Go uses goroutines, which are lightweight green threads managed by the Go runtime. You can run millions of goroutines without the memory overhead of OS threads. The Go scheduler maps goroutines onto OS threads and handles the multiplexing for you. Concurrency in Go is idiomatic and cheap.

Python has the GIL (Global Interpreter Lock), which prevents true parallel execution of Python bytecode across threads. Python threads give you concurrency for I/O-bound work but not parallelism for CPU-bound work. For CPU-bound parallelism in Python, use the multiprocessing module, which spawns separate processes each with their own GIL.

### Race Conditions

A race condition happens when two concurrent operations both read and write shared state, and the outcome depends on the order of execution. The classic example:

Thread A reads balance: 100  
Thread B reads balance: 100  
Thread A writes balance: 100 - 50 = 50  
Thread B writes balance: 100 - 50 = 50   // wrong, should be 0

Both threads read before either writes. The final balance is 50 when it should be 0. Fifty dollars appeared from nowhere.

Fixes include: database-level locking (SELECT FOR UPDATE), optimistic locking (include a version number in your update and fail if it does not match), or atomic operations (database transactions that make the read-modify-write a single indivisible operation).

In code, mutexes (mutual exclusion locks) protect shared state by ensuring only one thread can access it at a time. Use them sparingly. Locks held too long create contention and effectively serialize concurrent work, defeating the purpose of concurrency.

### Deadlocks

A deadlock happens when two operations are each waiting for a resource the other holds, and neither can proceed.

Transaction A locks row 1, waits for row 2  
Transaction B locks row 2, waits for row 1  
Both wait forever

Prevention strategies: always acquire locks in a consistent order across all operations, keep transactions short and release locks quickly, use timeouts on lock acquisition rather than waiting indefinitely.

Most databases detect deadlocks and automatically roll back one of the transactions. That transaction will hit your error handling code. Retry it.

### Async/Await and Structured Concurrency

Async/await is syntactic sugar over promises or futures. It makes asynchronous code look synchronous and is far easier to reason about than nested callbacks or raw promise chains.

A common performance mistake is sequentializing work that could run in parallel:

```javascript
// Sequential: takes 300ms total (100 + 100 + 100)
const user = await fetchUser(id);
const orders = await fetchOrders(id);
const preferences = await fetchPreferences(id);

// Parallel: takes ~100ms total
const [user, orders, preferences] = await Promise.all([
  fetchUser(id),
  fetchOrders(id),
  fetchPreferences(id),
]);
```

If those three operations are independent, run them concurrently. Promise.all fires all three simultaneously and waits for all three to complete. The total time is roughly the slowest individual operation rather than the sum of all three.

Use Promise.all for independent concurrent operations. Use sequential await when each operation depends on the result of the previous one.

### Backpressure

Backpressure is what happens when a producer generates work faster than a consumer can process it. Left unhandled, queues grow unboundedly and memory exhausts.

The correct response is to signal the producer to slow down. In streaming systems, this means pausing the readable stream when the writable stream's buffer is full. In queue systems, this means capping queue depth and rejecting new jobs (or blocking the producer) when the cap is reached.

Ignoring backpressure is how systems OOM (out of memory) crash under load. Build it in explicitly.

### Putting It Together

Security, scaling, and concurrency are not isolated concerns. A system that scales horizontally needs stateless request handling, which connects directly to how you manage sessions and authentication. A system under heavy concurrent load exposes race conditions that only appear at scale. A cache that reduces database load also needs to be invalidated securely to avoid serving stale data across tenants.

The pattern that runs through all three areas is the same: understand the tradeoffs, be deliberate about your choices, and build these properties in from the start rather than bolting them on when something breaks.

That's all, folks...That's it for the backend-engineering series!!
