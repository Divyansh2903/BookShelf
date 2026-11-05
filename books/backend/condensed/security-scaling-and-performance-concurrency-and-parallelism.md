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

Build security into every layer from the start. The goal isn't impenetrability (nothing is) but making attacks expensive enough that attackers move on.

### Authentication vs Authorization

- **Authentication**: "who are you?" Usually in middleware: verify a JWT, validate a session, look up an API key. On failure return **401** (Unauthorized, which confusingly means "not authenticated").
- **Authorization**: "what are you allowed to do?" Happens closer to the resource. Authenticated but not permitted returns **403** (Forbidden).

Don't conflate them (e.g. permission checks inside auth middleware as one gate); keep separate layers.

### JWT and Sessions

**JWTs** are stateless. The server issues a signed token with claims (user ID, roles, expiry); the client sends it back; the server verifies the signature and trusts the claims without a database hit. Fast, stateless, horizontally scalable.

Tradeoff: a JWT can't be revoked before expiry, so a logged-out or banned user's token stays valid. Fixes: short expiry (15 minutes) plus refresh tokens, or a small revocation list in Redis.

**Sessions** are stateful. The server stores session data (memory, Redis, or a database) and gives the client an opaque session ID in a cookie, looked up on each request. Allows instant revocation but needs shared session storage when scaled.

JWTs suit stateless APIs and mobile clients; sessions suit traditional web apps where you control the client.

### Password Storage

Never store plaintext, MD5, or SHA-256 passwords. Fast hashes are wrong for passwords: an attacker with your database can try billions of guesses per second against SHA-256.

Use bcrypt, scrypt, or Argon2: deliberately slow and memory-intensive, with automatic salting so identical passwords produce different hashes. Argon2 is the current recommendation of most security authorities.

```javascript
const hash = await bcrypt.hash(password, 12); // cost factor of 12
const valid = await bcrypt.compare(inputPassword, hash);
```

The cost factor controls slowness: higher is safer but slower. 10 to 12 is a reasonable default.

### Common Vulnerabilities

**SQL Injection**: attacker injects SQL via user input. Always use parameterized queries or prepared statements; never concatenate user input into SQL.

```javascript
// Vulnerable
db.query(`SELECT * FROM users WHERE email = '${email}'`);

// Safe
db.query(`SELECT * FROM users WHERE email = $1`, [email]);
```

**XSS (Cross-Site Scripting)**: attacker injects JavaScript into responses that runs in other users' browsers. Sanitize output, use Content-Security-Policy headers, avoid setting innerHTML with untrusted data.

**CSRF (Cross-Site Request Forgery)**: a malicious site tricks a user's browser into making an authenticated request to your API. Mitigate with CSRF tokens for session-based apps, or rely on CORS and SameSite cookies.

**IDOR (Insecure Direct Object Reference)**: a user requests /orders/1234 and gets another user's order because only authentication was checked. Always verify the user may access the specific resource, not just that they're logged in.

**Rate limiting and brute force protection**: rate limit login, password reset, and OTP verification endpoints; an unprotected login can be brute-forced indefinitely. Apply exponential backoff and account lockout after repeated failures.

### Secrets Management

Never put secrets (API keys, database passwords, JWT signing keys) in code, not even in a committed .env file.

Use runtime-injected environment variables or a secrets manager (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager). Rotate secrets regularly, audit access, and treat a leaked secret as compromised: rotate it immediately.

### Transport Security

Use HTTPS everywhere; TLS stops network observers reading or tampering with data in transit. Enforce it: redirect HTTP to HTTPS, set Strict-Transport-Security headers, never send sensitive data over plain HTTP.

Validate TLS certificates on outbound requests. Skipping validation to "fix" a connection error trades a network bug for a security hole.

<<<SECTION 2>>>
## Scaling and Performance

Scaling is handling more load; performance is doing more with what you have. Improve performance first so you need less scaling.

### Vertical vs Horizontal Scaling

- **Vertical**: more CPU, RAM, faster disk. Simple, no app changes, but a hard ceiling and prohibitively expensive past a point.
- **Horizontal**: more instances with load distributed across them. No practical ceiling; what modern cloud is built for. Requires app design for it: no local state, externalized sessions, distributed caching.

Most systems start vertical, then go horizontal. Design for horizontal early: the habits are cheap, refactoring later is not.

### Load Balancing

A load balancer distributes requests across instances. Strategies:

- **Round-robin**: each instance gets requests in turn.
- **Least connections**: instance with fewest active connections gets the next request.
- **IP hashing**: same client IP always goes to the same instance (for session affinity).

Keep instances stateless so any can serve any request; local state complicates routing and failures.

### Database Performance

The database is almost always the first bottleneck: app servers are stateless and scale easily, databases carry state.

- **Indexing**: most wins come from here. The right index turns a million-row scan into a handful. Index columns you filter and sort on, but don't over-index: every index slows writes and uses storage.
- **N+1 queries**: fetching 100 users then each user's orders separately is 101 queries where 2 would do. Use eager loading (JOINs or ORM includes) for one round trip.
- **Connection pooling**: connections are expensive to establish; a pool keeps open connections and lends them to requests. PgBouncer for PostgreSQL, or your ORM's pool settings.
- **Read replicas**: most apps read far more than they write. Primary handles writes, replicas handle reads. Replication lag means a primary write may not be visible on a replica immediately: send reads needing strong consistency to the primary, lag-tolerant reads to replicas.
- **Pagination**: mandatory at scale; returning all records is a disaster. Use cursor-based (more efficient) or offset-based (simpler), with enforced page size limits.

### Caching for Performance

Cache aggressively (see the caching section): a hit is just a memory read, no query or computation, often the difference between holding up and falling over under load.

### Profiling and Identifying Bottlenecks

Profile, don't guess. Node.js: built-in profiler or clinic.js. Python: cProfile or py-spy. Java: async-profiler or JFR.

Look for slow queries (database slow query log), excessive memory allocation, CPU-bound work blocking the event loop, and unnecessary serialization/deserialization.

Fix the real hotspot: shaving 10ms off an hourly function while a 200ms query runs on every request is a bad trade.

### API Design for Performance

- Keep payloads lean: don't return 50 fields when 5 are needed. Consider field selection or GraphQL if over-fetching persists.
- Compress with gzip or Brotli: a 500KB JSON payload compressed to 50KB means less bandwidth and faster transfer, especially on mobile.
- Enable client-side caching with ETags and Cache-Control headers so clients can skip requests when their cache is fresh.

<<<SECTION 3>>>
## Concurrency and Parallelism

**Concurrency** is dealing with multiple things at once; **parallelism** is doing multiple things at once. You can have concurrency without parallelism: a single-core CPU running an event loop switches rapidly between tasks (concurrent) but executes only one at any instant. Two cores processing two tasks simultaneously is parallel.

### The Event Loop Model (Node.js)

Node.js runs a single thread with an event loop and achieves concurrency via non-blocking I/O. A database query registers a callback and returns control to the event loop, which runs the next task; the callback runs when the database responds.

Very efficient for I/O-bound work (web servers, API gateways, anything waiting on databases or network). Poor for CPU-bound work: one heavy computation blocks the event loop and stalls every request.

```javascript
// This blocks the event loop for every other request while it runs
app.get('/compute', (req, res) => {
  const result = heavyCpuComputation(); // bad on the main thread
  res.json({ result });
});
```

Offload CPU-bound work to Worker Threads or a separate process.

### Threading Models (Java, Go, Python)

- **Java**: OS threads; each request gets a thread from a pool, with true parallelism on multi-core CPUs. Costs memory (each thread's stack, typically 1MB+) and context switching. Size pools carefully: too small and requests queue, too large and memory runs out.
- **Go**: goroutines, lightweight green threads managed by the Go runtime. Millions are possible without OS-thread memory overhead; the scheduler multiplexes them onto OS threads. Concurrency is idiomatic and cheap.
- **Python**: the GIL (Global Interpreter Lock) prevents parallel execution of Python bytecode across threads. Threads give concurrency for I/O-bound work, not CPU parallelism. For CPU-bound parallelism use the multiprocessing module (separate processes, each with its own GIL).

### Race Conditions

Two concurrent operations read and write shared state, and the result depends on execution order:

Thread A reads balance: 100  
Thread B reads balance: 100  
Thread A writes balance: 100 - 50 = 50  
Thread B writes balance: 100 - 50 = 50   // wrong, should be 0

Both read before either writes, so the balance ends at 50 instead of 0.

Fixes: database locking (SELECT FOR UPDATE), optimistic locking (include a version number in the update; fail on mismatch), or atomic operations (transactions making read-modify-write indivisible).

In code, mutexes ensure only one thread accesses shared state at a time. Use sparingly: locks held too long cause contention and serialize work, defeating concurrency.

### Deadlocks

Two operations each wait for a resource the other holds:

Transaction A locks row 1, waits for row 2  
Transaction B locks row 2, waits for row 1  
Both wait forever

Prevention: acquire locks in a consistent order everywhere, keep transactions short and release locks quickly, use lock acquisition timeouts instead of waiting indefinitely.

Most databases detect deadlocks and roll back one transaction; retry it in your error handling.

### Async/Await and Structured Concurrency

Async/await is syntactic sugar over promises/futures; async code reads like sync code, easier than nested callbacks or raw promise chains.

A common mistake is running independent work sequentially:

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

Promise.all starts all three at once and waits for all; total time is roughly the slowest one, not the sum. Use Promise.all for independent operations, sequential await when each depends on the previous result.

### Backpressure

Backpressure arises when a producer generates work faster than a consumer processes it. Unhandled, queues grow unboundedly and memory runs out.

Signal the producer to slow down: in streams, pause the readable stream when the writable buffer is full; in queues, cap queue depth and reject new jobs (or block the producer) at the cap. Ignoring backpressure is how systems OOM (out of memory) crash under load; build it in explicitly.

### Putting It Together

These concerns connect: horizontal scaling needs stateless handling, which ties to session/auth management; heavy concurrent load exposes race conditions that only appear at scale; a cache reducing database load must be invalidated securely to avoid serving stale data across tenants.

Understand the tradeoffs, choose deliberately, and build these in from the start rather than bolting them on after something breaks.
