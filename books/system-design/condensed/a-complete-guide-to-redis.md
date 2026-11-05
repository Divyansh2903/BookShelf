# A Complete Guide to Redis

<<<SECTION 1>>>
## What is Redis?

Redis (Remote Dictionary Server) is an open-source, in-memory data structure store used as a database, cache, message broker, and streaming engine. Created by Salvatore Sanfilippo in 2009, it is one of the most popular databases. It keeps all data in RAM rather than on disk, handling millions of operations per second with sub-millisecond latency.

## Need for Redis?

Disk reads/writes add latency; working in memory removes it. Ideal for: caching hot data, user sessions, real-time leaderboards and analytics, message queues and pub/sub, rate limiting and distributed locks.

## Redis vs Traditional Databases

### Redis vs SQL vs NoSQL

| Redis | SQL | NoSQL |
|---|---|---|
| In-memory | Disk | Disk |
| Sub-millisecond | Milliseconds | Milliseconds |
| Key-value | Relational tables | Document/column |
| Persistence optional | Persistent | Persistent |
| Caching, sessions, queues | Transactions, complex queries | Flexible schemas, horizontal scaling |

<<<SECTION 2>>>
## Core Concepts

- **Key-Value Model:** every key points to a value (string, list, set, hash, and more).
- **Single-threaded:** one command at a time, so no race conditions and operations are atomic by default; still very fast because it's in memory.
- **Persistence:** data can be saved to disk to survive restarts.
- **Expiry:** any key can have a TTL, after which it's auto-deleted; suits caching.

## Data Structures in Redis

Redis's rich set of purpose-built data structures sets it apart from other caches.

### 1. Strings

The basic type: text, integers, or binary data up to 512MB.

```redis
SET name "Alice"
GET name          → "Alice"

SET counter 10
INCR counter      → 11
INCRBY counter 5  → 16
```

**Use cases:** caching HTML, storing config values, counters, rate limiting.

### 2. Lists

Strings ordered by insertion; add at head or tail.

```redis
LPUSH tasks "task1"
LPUSH tasks "task2"
RPUSH tasks "task3"

LRANGE tasks 0 -1   → ["task2", "task1", "task3"]
LPOP tasks          → "task2"
```

**Use cases:** message queues, activity feeds, stacks and queues.

### 3. Sets

Unordered unique strings; duplicates ignored.

```redis
SADD tags "redis"
SADD tags "database"
SADD tags "redis"     → still only one "redis"

SMEMBERS tags         → {"redis", "database"}
SISMEMBER tags "redis" → 1 (true)
```

Supports union, intersection, difference:

```redis
SUNION set1 set2
SINTER set1 set2
SDIFF set1 set2
```

**Use cases:** unique visitors, tags, mutual friends, permissions.

### 4. Sorted Sets (ZSets)

Sets where each member has a score; auto-sorted by score.

```redis
ZADD leaderboard 100 "Alice"
ZADD leaderboard 200 "Bob"
ZADD leaderboard 150 "Carol"

ZRANGE leaderboard 0 -1 WITHSCORES
→ Alice 100, Carol 150, Bob 200

ZRANK leaderboard "Alice"  → 0 (lowest score = rank 0)
```

### 5. Hashes

Field-value pairs under one key, like a table row.

```redis
HSET user:1 name "Alice" age "30" city "NYC"
HGET user:1 name       → "Alice"
HGETALL user:1         → {name: Alice, age: 30, city: NYC}
HINCRBY user:1 age 1   → 31
```

**Use cases:** storing objects, user profiles, product data.

### 6. Bitmaps

Strings treated as bit arrays (not a separate type); very memory-efficient for boolean states.

```redis
SETBIT active_users 1001 1   → user 1001 is active
GETBIT active_users 1001     → 1
BITCOUNT active_users        → total active users
```

**Use cases:** daily active users, feature flags, attendance tracking.

### 7. HyperLogLog

Probabilistic count of unique items without storing them: fixed ~12KB regardless of input size, ~0.81% error.

```redis
PFADD visitors "user1" "user2" "user3"
PFCOUNT visitors   → 3
```

**Use cases:** counting unique page views, unique search queries, approximate analytics.

### 8. Streams

Append-only log, like Kafka. Each entry has an auto-generated unique ID and field-value pairs.

```redis
XADD events * action "login" user "Alice"
XADD events * action "purchase" user "Bob"

XRANGE events - +    → all entries in order
```

Consumers read individually or in consumer groups.

**Use cases:** event sourcing, activity logs, real-time data pipelines.

### 9. Geospatial Indexes

Stores longitude/latitude and runs location queries natively.

```redis
GEOADD locations 13.361 38.115 "Palermo"
GEOADD locations 15.087 37.502 "Catania"

GEODIST locations Palermo Catania km   → 166.27
GEOSEARCH locations FROMMEMBER Palermo BYRADIUS 200 km ASC
```

<<<SECTION 3>>>
## Core Features of Redis

### 1. Expiry & TTL

Any key can have a TTL, after which it's auto-deleted; fundamental to caching.

```redis
SET session "abc123"
EXPIRE session 3600       → expires in 3600 seconds (1 hour)

TTL session               → returns seconds remaining
PTTL session              → returns milliseconds remaining

PERSIST session           → removes the expiry, key lives forever
```

Or set expiry on creation:

```redis
SET session "abc123" EX 3600     → seconds
SET session "abc123" PX 3600000  → milliseconds
```

At TTL 0, keys are deleted lazily (on access) or actively (background sweep).

**Use cases:** session tokens, OTPs, temporary cache, rate limit windows.

### 2. Eviction Policies

`maxmemory-policy` decides which keys to delete when memory is full:

- `noeviction`: error when full
- `allkeys-lru`: least recently used
- `volatile-lru`: LRU among keys with TTL
- `allkeys-lfu`: least frequently used
- `volatile-ttl`: shortest TTL first
- `allkeys-random`: random

```conf
# in redis.conf
maxmemory 256mb
maxmemory-policy allkeys-lru
```

Pure caches usually use `allkeys-lru` or `allkeys-lfu`.

### 3. Transactions

Queue commands and execute them atomically; no other client can interleave.

```redis
MULTI           → start transaction
SET balance 100
DECRBY balance 30
INCR txn_count
EXEC            → execute all at once
```

Cancel:

```redis
MULTI
SET key1 "value"
DISCARD         → cancel, nothing is executed
```

**No rollback:** if one command fails, the rest still run. By design: speed over complex error handling.

**Use cases:** moving values between keys, grouped updates that must stay consistent.

### 4. Optimistic Locking with WATCH

`WATCH` a key before a transaction; if it changes before `EXEC`, the transaction aborts.

```redis
WATCH balance

MULTI
DECRBY balance 50
EXEC            → returns nil if balance changed since WATCH
```

### 5. Pipelining

Normally each command is sent and awaited separately. Pipelining batches commands into one round trip.

Without:

```redis
SET a 1   → wait → SET b 2 → wait → SET c 3 → wait
```

With:

```redis
SET a 1 → SET b 2 → SET c 3 → wait (one round trip)
```

Can improve throughput 5–10x in high-latency environments; most client libraries support it. Unlike transactions, it is **not atomic**: other clients' commands can interleave.

### 6. Lua Scripting

`EVAL` runs Lua scripts server-side, atomically (nothing runs in between).

```redis
EVAL "return redis.call('SET', KEYS[1], ARGV[1])" 1 mykey myvalue
```

Atomic increment with a cap:

```lua
local current = redis.call('GET', KEYS[1])
if tonumber(current) < tonumber(ARGV[1]) then
  return redis.call('INCR', KEYS[1])
else
  return current
end
```

Load once, call by SHA hash:

```redis
SCRIPT LOAD "return redis.call('GET', KEYS[1])"
→ returns a SHA hash

EVALSHA <sha> 1 mykey
```

**Use cases:** rate limiting logic, atomic check-and-set, complex conditional updates.

### 7. Pub/Sub

Publishers send to a channel; subscribers receive in real time.

```redis
# Subscriber (client 1)
SUBSCRIBE news

# Publisher (client 2)
PUBLISH news "Redis 8.0 released!"

# Client 1 receives:
→ "Redis 8.0 released!"
```

Pattern subscriptions:

```redis
PSUBSCRIBE news.*       → matches news.tech, news.sports, etc.
```

**Limitations:** messages aren't persisted (offline subscribers miss them); no acknowledgement or delivery guarantees. For reliable messaging, use Streams.

**Use cases:** live notifications, chat systems, real-time dashboards, event broadcasting.

<<<SECTION 4>>>
## Persistence & Reliability in Redis

In-memory data is lost on restart or crash unless persisted. Two mechanisms, usable together.

### 1. RDB (Redis Database Snapshots)

Point-in-time snapshot of the whole dataset to a binary `dump.rdb`. Redis forks the main process, so it keeps serving while the snapshot is written in the background.

```conf
# redis.conf — auto snapshot rules
save 900 1       → save if at least 1 key changed in 900 seconds
save 300 10      → save if at least 10 keys changed in 300 seconds
save 60 10000    → save if at least 10000 keys changed in 60 seconds
```

Manual snapshots:

```redis
BGSAVE     → background save (non-blocking)
SAVE       → foreground save (blocks all commands until done)
LASTSAVE   → returns Unix timestamp of last successful save
```

**Pros:** compact file, easy to back up and transfer; fast restarts (one binary file); minimal impact during normal operation.

**Cons:** data since the last snapshot is lost on crash; forking can be slow and memory-intensive for very large datasets.

**Use cases:** backups, disaster recovery, dataset transfers between environments.

### 2. AOF (Append Only File)

Logs every write command to `appendonly.aof`; on restart Redis replays it to rebuild the dataset.

```conf
# redis.conf
appendonly yes
appendfilename "appendonly.aof"
```

fsync policy controls flush frequency:

```conf
appendfsync always    → flush after every command (safest, slowest)
appendfsync everysec  → flush every second (good balance — default)
appendfsync no        → let the OS decide (fastest, least safe)
```

With `everysec`, at most 1 second of data is lost on crash.

#### AOF Rewriting

The AOF grows over time; rewriting compacts it to the minimum commands needed for the current state:

```redis
BGREWRITEAOF    → triggers background AOF rewrite
```

Automatic rewrite:

```conf
# redis.conf
auto-aof-rewrite-percentage 100   → rewrite when AOF doubles in size
auto-aof-rewrite-min-size 64mb    → but only if it's at least 64MB
```

**Pros:** far more durable than RDB (at most 1 second lost); human-readable, easy to inspect and repair; append-only means no seeks and little corruption risk (a half-written last command is fixed with `redis-check-aof`).

**Cons:** larger files than RDB; slower restarts (replay vs loading a snapshot); slightly higher write overhead.

### 3. RDB + AOF Hybrid (Recommended)

Since Redis 4.0, both can be enabled. On AOF rewrite, Redis writes an RDB snapshot inside the AOF, then appends new commands: fast restarts from the snapshot plus full durability from the following commands.

```conf
# redis.conf
appendonly yes
aof-use-rdb-preamble yes    → enables hybrid mode
```

Recommended for most production systems.

### 4. No Persistence (Pure Cache Mode)

For a pure cache where data loss is acceptable, disable persistence:

```conf
# redis.conf
save ""
appendonly no
```

Maximum performance: Redis never writes to disk.

### 5. Data Recovery

Restart load order: 1) AOF (if enabled, more complete), 2) RDB (if no AOF), 3) empty dataset. Back up `dump.rdb` and `appendonly.aof` regularly, especially before upgrades.

### Key Configuration Summary

```conf
# redis.conf - recommended production setup
save 900 1
save 300 10
save 60 10000

appendonly yes
appendfsync everysec
aof-use-rdb-preamble yes
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
```

<<<SECTION 5>>>
## Scalability & Architecture in Redis

For high availability, fault tolerance, and horizontal scaling beyond one instance, Redis offers Replication, Sentinel, and Cluster.

### 1. Replication

A master copies its data to one or more replicas, kept in sync in real time.

```conf
# On the replica - redis.conf
replicaof 192.168.1.1 6379

# Or at runtime
REPLICAOF 192.168.1.1 6379

# To stop replication
REPLICAOF NO ONE
```

**How it works:**
1. Replica connects to master
2. Master sends a full RDB snapshot
3. Master then streams every write command in real time
4. After a dropped connection, partial resync catches up without a full transfer

**Properties:** asynchronous (master doesn't wait for replica confirmation); replicas read-only by default; multiple replicas per master; replicas can have replicas (cascading/chained).

**Pros:** read scaling, hot-backup redundancy, offloading heavy work (backups, analytics).

**Con:** no automatic failover; if the master dies, a human or tool must promote a replica.

### 2. Redis Sentinel

A separate process that monitors master and replicas and automatically promotes a replica if the master fails.

```conf
# sentinel.conf
sentinel monitor mymaster 192.168.1.1 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 60000
sentinel parallel-syncs mymaster 1
```

The `2` is the quorum: at least 2 Sentinels must agree the master is down, preventing split-brain from a single false positive.

**Failover:**
1. Sentinel detects master unreachable
2. Waits `down-after-milliseconds` to confirm
3. Sentinels elect a leader
4. Leader promotes the most up-to-date replica
5. Other replicas follow the new master
6. Clients are notified of the new address

**Service discovery:**

```redis
# Ask Sentinel for the current master address
SENTINEL get-master-addr-by-name mymaster
→ 192.168.1.2 6379   (could be a different IP after failover)
```

Apps query Sentinel for the master address instead of hardcoding it. Run at least 3 Sentinels on separate machines for reliable quorum.

Sentinel does **not** shard data or scale writes, and manages one master per configuration.

### 3. Redis Cluster

Horizontal sharding: data is split automatically across multiple masters, with built-in replication and failover (no Sentinel needed).

**How sharding works-Hash Slots:**

The keyspace has 16,384 hash slots; each key maps via CRC16:

```text
slot = CRC16(key) % 16384
```

Slots are spread across masters:

```text
Node A -> slots 0 to 5460
Node B -> slots 5461 to 10922
Node C -> slots 10923 to 16383
```

Each master can have replicas for fault tolerance.

**Setting up a cluster:**

```bash
# Start each node with cluster mode enabled - redis.conf
cluster-enabled yes
cluster-config-file nodes.conf
cluster-node-timeout 5000

# Create the cluster (3 masters, 3 replicas)
redis-cli --cluster create \
  192.168.1.1:6379 \
  192.168.1.2:6379 \
  192.168.1.3:6379 \
  192.168.1.4:6379 \
  192.168.1.5:6379 \
  192.168.1.6:6379 \
  --cluster-replicas 1
```

**Cluster commands:**

```redis
CLUSTER INFO           -> cluster health and state
CLUSTER NODES          -> all nodes and their slot ranges
CLUSTER KEYSLOT mykey  -> which slot a key maps to
```

**Hash Tags (controlling key placement):**

To force keys onto the same slot (for multi-key operations), use hash tags:

```redis
SET {user:1}.name "Alice"
SET {user:1}.age  "30"
→ both keys hash on "user:1", land on same slot
```

**Failover:** a failed master's replica is promoted automatically; with no replica, that part of the keyspace is unavailable.

**Limitations:** multi-key commands and Lua scripts only work on keys in the same slot; clients need slightly more complex support.

## Security & Operations in Redis

### 1. Authentication

Redis has no authentication by default: anyone reaching the port can run any command. Always enable it in production.

**Simple password (requirepass):**

```conf
# redis.conf
requirepass your_strong_password

# Client must authenticate before any command
AUTH your_strong_password
```

One password, full access for all clients; not granular enough for multi-user environments.

<<<SECTION 6>>>
### 2. ACL- Access Control Lists

Since Redis 6.0: multiple users, each with own password, allowed commands, and allowed keys.

```redis
# Create a user
ACL SETUSER alice on >password123 ~cache:* +GET +SET

# Breakdown:
# on          → user is active
# >password123 → password
# ~cache:*    → can only access keys starting with cache:
# +GET +SET   → can only run GET and SET
```

```redis
# View all users
ACL LIST

# View current user
ACL WHOAMI

# Delete a user
ACL DELUSER alice

# Test what a user can do
ACL DRYRUN alice SET cache:key value
```

ACLs can live in a file:

```conf
# redis.conf
aclfile /etc/redis/users.acl
```

The always-present default user should be restricted or disabled in production:

```redis
ACL SETUSER default off
```

**Common ACL patterns:**

```redis
# Read-only user
ACL SETUSER readonly on >pass ~* +@read

# Cache-only user (specific key prefix)
ACL SETUSER cacheuser on >pass ~session:* +GET +SET +DEL +EXPIRE

# Admin user (full access)
ACL SETUSER admin on >adminpass ~* +@all
```

<<<SECTION 7>>>
### 3. Network Security

**Bind to specific interfaces:**

```conf
# redis.conf- only accept connections from localhost
bind 127.0.0.1

# Accept from localhost and one internal IP
bind 127.0.0.1 192.168.1.10
```

Never bind `0.0.0.0` in production unless behind a firewall.

**Disable dangerous commands:**

```conf
# redis.conf - rename a command to make it inaccessible
rename-command FLUSHALL ""
rename-command CONFIG   ""
rename-command DEBUG    ""
rename-command SHUTDOWN ""
```

Renaming to `""` disables a command entirely.

**Protected mode:**

With no bind address and no password, protected mode blocks external connections automatically:

```conf
protected-mode yes   → default, blocks external access without auth
```

### 4. TLS / SSL

Redis 6.0+ supports native TLS for client-server encryption.

```conf
# redis.conf
tls-port 6380
tls-cert-file /etc/redis/redis.crt
tls-key-file  /etc/redis/redis.key
tls-ca-cert-file /etc/redis/ca.crt
tls-auth-clients yes    → require client certificates
```

```bash
# Connect with TLS via redis-cli
redis-cli -p 6380 \
  --tls \
  --cert /etc/redis/client.crt \
  --key  /etc/redis/client.key \
  --cacert /etc/redis/ca.crt
```

Use TLS whenever Redis isn't on the app's machine, especially across networks or clouds.

<<<SECTION 8>>>
### 5. Memory Management

Critical since Redis lives in RAM.

**Memory limit:**

```conf
# redis.conf
maxmemory 512mb
maxmemory-policy allkeys-lru
```

**Current usage:**

```redis
INFO memory

# Key fields:
# used_memory          → bytes used by data
# used_memory_human    → human readable
# mem_fragmentation_ratio → ratio of RSS to used memory (ideally ~1.0-1.5)
```

**Memory fragmentation:**

Fragmentation makes Redis use more physical RAM than the data needs; fix with active defragmentation:

```conf
# redis.conf
activedefrag yes
active-defrag-ignore-bytes 100mb   → start defrag after 100mb fragmentation
active-defrag-threshold-lower 10   → start at 10% fragmentation
```

**Analyze memory per key:**

```redis
MEMORY USAGE mykey        → bytes used by a specific key
MEMORY DOCTOR             → Redis suggestions for memory issues
MEMORY STATS              → full breakdown of memory usage
```

**Object encoding:**

Small structures use compact encodings automatically (e.g. a small hash uses listpack, not a full hashtable). Tunable thresholds:

```conf
# redis.conf
hash-max-listpack-entries 128
hash-max-listpack-value   64
zset-max-listpack-entries 128
zset-max-listpack-value   64
```

Staying under them saves significant memory.

<<<SECTION 9>>>
### 6. Monitoring

**The INFO command:**

`INFO` is the main health tool, with stats by section:

```redis
INFO server       → version, uptime, OS
INFO clients      → connected clients, blocked clients
INFO memory       → memory usage and fragmentation
INFO stats        → commands processed, hits, misses
INFO replication  → master/replica status
INFO keyspace     → number of keys per database
INFO all          → everything at once
```

**Key metrics to watch:**

```text
connected_clients         → spikes may indicate connection leaks
used_memory               → make sure it stays under maxmemory
keyspace_hits/misses      → cache hit rate = hits / (hits + misses)
evicted_keys              → if rising, memory is too tight
rejected_connections      → maxclients limit being hit
instantaneous_ops_per_sec → current throughput
```

**SLOWLOG- finding slow commands:**

Logs commands over a time threshold:

```conf
# redis.conf
slowlog-log-slower-than 10000   → log commands slower than 10ms (in microseconds)
slowlog-max-len 128

# Query the slow log
SLOWLOG GET        → last 128 slow commands
SLOWLOG GET 10     → last 10
SLOWLOG LEN        → how many entries
SLOWLOG RESET      → clear the log
```

**MONITOR- live command stream:**

```redis
MONITOR    → streams every command received by Redis in real time
```

Debugging only: significant performance impact in production.

**CLIENT commands:**

```redis
CLIENT LIST          → all connected clients with details
CLIENT GETNAME       → name of current connection
CLIENT SETNAME myapp → name your connection for easier debugging
CLIENT KILL ID 42    → kill a specific client connection
```

### 7. RedisInsight

The official, free GUI (redis.io/redisinsight): key and data structure browser, real-time memory/performance graphs, slow log viewer, built-in CLI, Pub/Sub debugger, cluster topology view. Recommended for development and production monitoring.

### Key Configuration Summary

```conf
# redis.conf — production security and operations setup

# Auth
requirepass your_strong_password
aclfile /etc/redis/users.acl

# Network
bind 127.0.0.1
protected-mode yes
rename-command FLUSHALL ""
rename-command CONFIG   ""

# TLS
tls-port 6380
tls-cert-file /etc/redis/redis.crt
tls-key-file  /etc/redis/redis.key

# Memory
maxmemory 512mb
maxmemory-policy allkeys-lru
activedefrag yes

# Monitoring
slowlog-log-slower-than 10000
slowlog-max-len 128
```

## Real-World Patterns in Redis

Battle-tested production patterns.

<<<SECTION 10>>>
### 1. Caching Patterns

#### Cache-Aside (Lazy Loading)

Most common. Check cache first; on miss, load from DB and populate cache.

```pseudocode
function getData(key):
    data = redis.GET(key)

    if data is null:
        data = database.query(key)
        redis.SET(key, data, EX 3600)

    return data
```

**Pros:** caches only what's needed. **Cons:** first request always hits the DB (cold start).

#### Write-Through

Every DB write also writes the cache, keeping it in sync.

```pseudocode
function saveData(key, value):
    database.save(key, value)
    redis.SET(key, value, EX 3600)
```

**Pros:** always fresh, no cold start. **Cons:** slower writes; cache fills with data that may never be read.

#### Write-Behind (Write-Back)

Write to cache immediately; flush to DB asynchronously in the background.

```pseudocode
function saveData(key, value):
    redis.SET(key, value)
    redis.LPUSH(write_queue, {key, value})   → background worker drains this
```

**Pros:** very fast writes. **Cons:** data loss if Redis crashes before flush.

#### Cache Stampede Prevention

When a popular key expires, hundreds of requests hit the DB at once. Fix with a lock:

```pseudocode
function getData(key):
    data = redis.GET(key)
    if data: return data

    # Try to acquire lock
    lock = redis.SET(lock:key, 1, NX EX 10)

    if lock:
        data = database.query(key)
        redis.SET(key, data, EX 3600)
        redis.DEL(lock:key)
    else:
        sleep(50ms)
        return getData(key)    → retry
```

<<<SECTION 11>>>
### 2. Session Management

The standard session store in distributed systems: all app servers share one Redis, so any server can read any session.

```pseudocode
# On login
sessionId = generateUUID()
redis.HSET(session:sessionId, userId, "123", role, "admin", loginTime, now())
redis.EXPIRE(session:sessionId, 86400)   → 24 hours

# On each request
session = redis.HGETALL(session:sessionId)
if session is null: redirect to login

# Extend session on activity
redis.EXPIRE(session:sessionId, 86400)

# On logout
redis.DEL(session:sessionId)
```

### 3. Rate Limiting

**Fixed Window:**

Count requests per user per window. Simple, but allows bursts at window boundaries.

```pseudocode
function isAllowed(userId):
    key = ratelimit:userId:currentMinute()
    count = redis.INCR(key)

    if count == 1:
        redis.EXPIRE(key, 60)

    return count <= 100    → allow max 100 requests per minute
```

**Sliding Window with Sorted Sets:**

More accurate: store each request timestamp as a score, remove old ones, count the rest.

```pseudocode
function isAllowed(userId):
    now = currentTimestampMs()
    windowStart = now - 60000   → last 60 seconds
    key = ratelimit:userId

    redis.MULTI
        ZREMRANGEBYSCORE(key, 0, windowStart)       → remove old requests
        ZADD(key, now, now)                          → add current request
        ZCARD(key)                                   → count requests in window
        EXPIRE(key, 60)
    results = redis.EXEC

    return results[2] <= 100    → allow max 100 per 60 seconds
```

<<<SECTION 12>>>
### 4. Distributed Locks

For operations only one server may perform at a time.

**Basic lock with SETNX:**

```pseudocode
# Acquire lock
lock = redis.SET(lock:resource, clientId, NX EX 30)
→ NX = only set if not exists
→ EX 30 = auto-release after 30 seconds

if lock is null: someone else holds it, retry or fail

# Do the critical work
processPayment()

# Release lock — only if we own it (Lua for atomicity)
redis.EVAL("
    if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
    else
        return 0
    end
", 1, lock:resource, clientId)
```

**Redlock- Multi-Node Distributed Lock:**

Stronger guarantee: acquire on multiple independent instances; valid only on a majority (N/2 + 1):

```pseudocode
nodes = [redis1, redis2, redis3, redis4, redis5]
acquired = 0
lockId = generateUUID()

for node in nodes:
    if node.SET(lock:resource, lockId, NX EX 30):
        acquired++

if acquired >= 3:    → majority
    # lock is valid, do work
else:
    # release on all nodes, retry
    for node in nodes:
        node.DEL(lock:resource)
```

<<<SECTION 13>>>
### 5. Job Queues

**Simple queue with Lists:**

```pseudocode
# Producer - push jobs to the queue
redis.LPUSH(jobqueue, JSON.stringify({type: "email", to: "alice@example.com"}))

# Consumer - blocking pop, waits until a job arrives
job = redis.BRPOP(jobqueue, timeout=0)
process(job)
```

`BRPOP` blocks instead of polling, which is efficient.

**Reliable queue - preventing job loss:**

A consumer crash mid-job loses the job. Fix with a processing list:

```pseudocode
# Atomically move job from queue to processing list
job = redis.BLMOVE(jobqueue, processing, RIGHT, LEFT, timeout=0)
process(job)
redis.LREM(processing, 1, job)    → remove after success

# Recovery worker — requeue stuck jobs
stuckJobs = redis.LRANGE(processing, 0, -1)
for job in stuckJobs:
    if isExpired(job):
        redis.LREM(processing, 1, job)
        redis.LPUSH(jobqueue, job)
```

### 6. Leaderboards

Sorted Sets fit perfectly: scores stay sorted automatically.

```pseudocode
# Add or update a player score
redis.ZADD(leaderboard, 1500, "Alice")
redis.ZADD(leaderboard, 2300, "Bob")
redis.ZADD(leaderboard, 1900, "Carol")

# Top 10 players (highest score first)
redis.ZREVRANGE(leaderboard, 0, 9, WITHSCORES)
→ Bob 2300, Carol 1900, Alice 1500

# A player's rank (0-indexed)
redis.ZREVRANK(leaderboard, "Alice")   → 2

# A player's score
redis.ZSCORE(leaderboard, "Alice")    → 1500

# Increment score (after a game)
redis.ZINCRBY(leaderboard, 200, "Alice")   → 1700

# Players within a score range
redis.ZRANGEBYSCORE(leaderboard, 1000, 2000, WITHSCORES)
```

Weekly/monthly boards use time-scoped keys:

```text
leaderboard:2026:week22
leaderboard:2026:05
```

and expire automatically when no longer needed.

### 7. Pub/Sub for Real-Time Notifications

```pseudocode
# Server - publish an event when something happens
redis.PUBLISH(notifications:user:123, JSON.stringify({
    type: "message",
    from: "Bob",
    text: "Hey!"
}))

# Client listener - subscribed and waiting
redis.SUBSCRIBE(notifications:user:123)
→ receives event instantly
```

For live notifications, chat, live dashboards, collaborative features.

### 8. Autocomplete with Sorted Sets

Store completions with score 0 and use lexicographic range queries.

```pseudocode
# Index all terms
redis.ZADD(autocomplete, 0, "redis")
redis.ZADD(autocomplete, 0, "redis cluster")
redis.ZADD(autocomplete, 0, "redis sentinel")
redis.ZADD(autocomplete, 0, "relational database")

# Search for prefix "redis"
redis.ZRANGEBYLEX(autocomplete, "[redis", "[redis\xff")
→ "redis", "redis cluster", "redis sentinel"
```

### 9. Bloom Filter (via RedisBloom)

Check whether an item was seen without storing every item; a tiny fraction of a full set's memory.

```pseudocode
# Add items
redis.BF.ADD(seen_emails, "alice@example.com")

# Check before processing
exists = redis.BF.EXISTS(seen_emails, "alice@example.com")
→ 1 (probably seen) or 0 (definitely not seen)
```

## Modern Redis

Redis Stack bundles modules that make Redis a multi-model database: full-text search, native JSON, time series, probabilistic structures, and vector similarity search for AI.

<<<SECTION 14>>>
### 1. Redis Stack

Official distribution of Redis core plus curated modules:

- **RedisJSON:** native JSON storage and querying
- **RediSearch:** full-text search, secondary indexing
- **RedisTimeSeries:** time series ingestion and querying
- **RedisBloom:** probabilistic structures
- **RedisGraph:** graph DB (deprecated 2023)

Install via Docker:

```bash
docker run -d --name redis-stack -p 6379:6379 -p 8001:8001 redis/redis-stack:latest
```

Port 8001 serves the built-in RedisInsight GUI.

### 2. RedisJSON

Store, update, and query JSON natively, with no string serialize/deserialize on every read.

```redis
# Store a JSON document
JSON.SET user:1 $ '{"name":"Alice","age":30,"address":{"city":"NYC","zip":"10001"}}'

# Get the full document
JSON.GET user:1 $
→ {"name":"Alice","age":30,"address":{"city":"NYC","zip":"10001"}}

# Get a nested field
JSON.GET user:1 $.address.city
→ "NYC"

# Update a specific field
JSON.SET user:1 $.age 31

# Increment a numeric field
JSON.NUMINCRBY user:1 $.age 1
→ 32

# Append to an array
JSON.SET product:1 $ '{"tags":["electronics"]}'
JSON.ARRAPPEND product:1 $.tags '"sale"' '"featured"'
→ ["electronics","sale","featured"]

# Delete a field
JSON.DEL user:1 $.address.zip

# Get the type of a field
JSON.TYPE user:1 $.age
→ integer
```

**JSONPath syntax** for queries:

```text
$           → root
$.field     → top-level field
$.a.b       → nested field
$[*]        → all array elements
$..field    → recursive search for field anywhere in document
$[0]        → first array element
```

Especially powerful with RediSearch indexing JSON fields.

<<<SECTION 15>>>
### 3. RediSearch

Full-text search, secondary indexing, filtering, and aggregation over Hashes and JSON documents.

**Create an index:**

```redis
# Index on Hash fields
FT.CREATE idx:users ON HASH PREFIX 1 user:
    SCHEMA
        name TEXT WEIGHT 2.0
        age  NUMERIC SORTABLE
        city TAG

# Index on JSON fields
FT.CREATE idx:products ON JSON PREFIX 1 product:
    SCHEMA
        $.name    AS name    TEXT
        $.price   AS price   NUMERIC SORTABLE
        $.tags[*] AS tags    TAG
```

**Search:**

```redis
# Full-text search
FT.SEARCH idx:users "Alice"

# Filter by numeric range
FT.SEARCH idx:users "@age:[25 35]"

# Filter by tag
FT.SEARCH idx:users "@city:{NYC}"

# Combined query
FT.SEARCH idx:users "@city:{NYC} @age:[25 35]"

# Fuzzy search (typo tolerance)
FT.SEARCH idx:users "%aliice%"

# Search with pagination
FT.SEARCH idx:users "Alice" LIMIT 0 10

# Return specific fields only
FT.SEARCH idx:users "Alice" RETURN 2 name age
```

**Aggregation:**

```redis
# Count users per city
FT.AGGREGATE idx:users "*"
    GROUPBY 1 @city
    REDUCE COUNT 0 AS total
    SORTBY 2 @total DESC

# Average age per city
FT.AGGREGATE idx:users "*"
    GROUPBY 1 @city
    REDUCE AVG 1 @age AS avg_age
```

**Autocomplete with RediSearch:**

```redis
FT.SUGADD autocomplete "redis cluster" 1.0
FT.SUGADD autocomplete "redis sentinel" 1.0

FT.SUGGET autocomplete "redis" FUZZY MAX 5
→ "redis cluster", "redis sentinel"
```

<<<SECTION 16>>>
### 4. RedisTimeSeries

Built for time-stamped data: metrics, sensor readings, financial data.

```redis
# Create a time series
TS.CREATE temperature:sensor1 RETENTION 86400000 LABELS location kitchen

# Add data points
TS.ADD temperature:sensor1 * 22.5    → * = current timestamp
TS.ADD temperature:sensor1 * 23.1
TS.ADD temperature:sensor1 1717000000000 21.8   → custom timestamp (ms)

# Get latest value
TS.GET temperature:sensor1

# Get range
TS.RANGE temperature:sensor1 1716000000000 1717000000000

# Aggregation over time
TS.RANGE temperature:sensor1 - + AGGREGATION avg 3600000
→ average temperature per hour
```

**Downsampling with rules:**

```redis
# Create a downsampled series — hourly average
TS.CREATE temperature:sensor1:hourly

TS.CREATERULE temperature:sensor1 temperature:sensor1:hourly
    AGGREGATION avg 3600000
```

Raw data compacts into the downsampled series automatically, saving memory but keeping trends.

**Multi-series query:**

```redis
# Query across all sensors by label
TS.MRANGE - + FILTER location=kitchen
```

<<<SECTION 17>>>
### 5. RedisBloom

Four probabilistic structures with tiny memory footprints.

**Bloom Filter (has this item been seen?)**

```redis
BF.ADD emails "alice@example.com"
BF.ADD emails "bob@example.com"

BF.EXISTS emails "alice@example.com"   → 1 (probably yes)
BF.EXISTS emails "new@example.com"    → 0 (definitely no)
```

False positives possible, false negatives not. Ideal for deduplication.

**Cuckoo Filter, like Bloom but supports deletion:**

```redis
CF.ADD     visited "page:home"
CF.EXISTS  visited "page:home"   → 1
CF.DEL     visited "page:home"
CF.EXISTS  visited "page:home"   → 0
```

**Count-Min Sketch- frequency estimation:**

```redis
CMS.INCRBY events click 5 view 20 share 3

CMS.QUERY events click   → approximately 5
CMS.QUERY events view    → approximately 20
```

Tracks top events without storing every occurrence.

**Top-K- track the K most frequent items:**

```redis
TOPK.ADD trending "redis" "kafka" "redis" "postgres" "redis"

TOPK.LIST trending
→ redis (3), kafka (1), postgres (1)
```

For trending topics, most-visited pages, popular products.

<<<SECTION 18>>>
### 6. Redis as a Vector Database

Since RediSearch 2.4 (2022), Redis Stack has native vector similarity search, making Redis a vector store for AI/ML: store embeddings, search for semantically similar items.

**What are vectors?**

An embedding model (e.g. OpenAI's text-embedding-ada-002) turns text, images, or audio into a high-dimensional float array (vector). Similar content yields nearby vectors; vector search finds a query vector's nearest neighbors.

**Create a vector index:**

```redis
FT.CREATE idx:embeddings ON HASH PREFIX 1 doc:
    SCHEMA
        content TEXT
        embedding VECTOR HNSW 6
            TYPE FLOAT32
            DIM 1536
            DISTANCE_METRIC COSINE
```

HNSW (Hierarchical Navigable Small World) is the approximate nearest neighbor algorithm used.

**Store a document with its embedding:**

```redis
HSET doc:1 content "Redis is an in-memory database" embedding <float32 bytes>
```

**Search for similar documents:**

```redis
FT.SEARCH idx:embeddings "*=>[KNN 5 @embedding $query_vector AS score]"
    PARAMS 2 query_vector <float32 bytes>
    SORTBY score
    RETURN 2 content score
    DIALECT 2
```

Returns the 5 most similar documents.

**Use cases:** semantic search (meaning, not just keywords), recommendations (similar products/content), RAG (Retrieval Augmented Generation, giving LLMs context), image similarity, anomaly detection.

<<<SECTION 19>>>
### 7. Redis Cloud

Fully managed offering by Redis Ltd, removing operational burden. Features: automatic failover and backups; multi-region active-active replication (conflict-free cross-region sync); Redis Stack modules included; scaling via slider with no manual cluster management; on AWS, Google Cloud, Azure.

**Active-Active geo-distribution:**

Unlike standard replication, writes are accepted in multiple regions simultaneously; conflicts are resolved automatically with CRDTs (Conflict-free Replicated Data Types).

```text
Region US-East  → write SET user:1 "Alice"
Region EU-West  → write SET user:1 "Bob"
→ conflict resolved by last-write-wins or merge strategy
```

Ideal for global apps needing low-latency writes everywhere.

### 8. Redis 7.x and 8.x Highlights

**Redis 7.0:**

- Redis Functions: Lua script replacement, persistent across restarts
- Multi-part AOF: lower rewrite overhead
- Sharded Pub/Sub: native in Cluster mode
- LMPOP / ZMPOP: atomic pop from multiple lists or sorted sets

```redis
# Redis Functions example
FUNCTION LOAD "#!lua name=mylib\nredis.register_function('myfunc', function(keys, args) return args[1] end)"
FCALL myfunc 0 "hello"   → "hello"
```

**Redis 8.0 (2025):**

- Redis Stack modules merged into core (no separate install)
- Better memory efficiency and cluster performance
