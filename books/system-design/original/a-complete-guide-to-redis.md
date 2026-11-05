# A Complete Guide to Redis

<<<SECTION 1>>>
## What is Redis?

Redis (Remote Dictionary Server) is an open-source, in-memory data structure store that can be used as a database, cache, message broker, and streaming engine. It was created by Salvatore Sanfilippo in 2009 and has since become one of the most popular databases in the world.

Unlike traditional databases that store data on disk, Redis keeps all data in RAM, which makes it extremely fast, and capable of handling millions of operations per second with sub-millisecond latency.

## Need for Redis?

Traditional databases read and write from disk, which introduces latency. Redis eliminates that by working entirely in memory. This makes it ideal for:

- Caching frequently accessed data
- Managing user sessions
- Real-time leaderboards and analytics
- Message queues and pub/sub systems
- Rate limiting and distributed locks

## Redis vs Traditional Databases

### Redis vs SQL vs NoSQL

| Redis | SQL Databases | NoSQL Databases |
|---|---|---|
| In-memory storage | Disk-based storage | Disk-based storage |
| Sub-millisecond speed | Millisecond latency | Millisecond latency |
| Key-value data model | Table-based relational model | Document/column-based model |
| Persistence optional | Persistent by default | Persistent by default |
| Best for caching, sessions, queues | Best for transactions and complex queries | Best for flexible schemas and horizontal scaling |

<<<SECTION 2>>>
## Core Concepts

- **Key-Value Model:** Everything in Redis is stored as a key pointing to a value. The value can be a string, list, set, hash, and more.
- **Single-threaded:** Redis processes one command at a time, which avoids race conditions and makes operations atomic by default. Despite being single-threaded, it is incredibly fast due to in-memory operations.
- **Persistence:** Redis is not purely volatile. It offers mechanisms to save data to disk so it survives restarts.
- **Expiry:** Every key can have a TTL (time to live), after which Redis automatically deletes it. This makes it naturally suited for caching.

## Data Structures in Redis

Redis is not just a simple key-value store. It supports a rich set of data structures, each designed for specific use cases. This is what sets Redis apart from other caches.

### 1. Strings

The most basic type in Redis. A string value can hold text, integers, or binary data up to 512MB.

```redis
SET name "Alice"
GET name          → "Alice"

SET counter 10
INCR counter      → 11
INCRBY counter 5  → 16
```

**Use cases:** caching HTML, storing config values, counters, rate limiting.

### 2. Lists

An ordered collection of strings, sorted by insertion order. You can add elements to the head or tail.

```redis
LPUSH tasks "task1"
LPUSH tasks "task2"
RPUSH tasks "task3"

LRANGE tasks 0 -1   → ["task2", "task1", "task3"]
LPOP tasks          → "task2"
```

**Use cases:** message queues, activity feeds, stacks and queues.

### 3. Sets

An unordered collection of unique strings. Duplicates are automatically ignored.

```redis
SADD tags "redis"
SADD tags "database"
SADD tags "redis"     → still only one "redis"

SMEMBERS tags         → {"redis", "database"}
SISMEMBER tags "redis" → 1 (true)
```

You can also perform union, intersection, and difference between sets.

```redis
SUNION set1 set2
SINTER set1 set2
SDIFF set1 set2
```

**Use cases:** unique visitors, tags, mutual friends, permissions.

### 4. Sorted Sets (ZSets)

Like sets, but every member has a score. Members are automatically sorted by score.

```redis
ZADD leaderboard 100 "Alice"
ZADD leaderboard 200 "Bob"
ZADD leaderboard 150 "Carol"

ZRANGE leaderboard 0 -1 WITHSCORES
→ Alice 100, Carol 150, Bob 200

ZRANK leaderboard "Alice"  → 0 (lowest score = rank 0)
```

### 5. Hashes

A map of field-value pairs stored under a single key, like a row in a database table.

```redis
HSET user:1 name "Alice" age "30" city "NYC"
HGET user:1 name       → "Alice"
HGETALL user:1         → {name: Alice, age: 30, city: NYC}
HINCRBY user:1 age 1   → 31
```

**Use cases:** storing objects, user profiles, product data.

### 6. Bitmaps

Not a separate data type. Bitmaps are strings treated as arrays of bits. Extremely memory efficient for tracking boolean states.

```redis
SETBIT active_users 1001 1   → user 1001 is active
GETBIT active_users 1001     → 1
BITCOUNT active_users        → total active users
```

**Use cases:** daily active users, feature flags, attendance tracking.

### 7. HyperLogLog

A probabilistic data structure used to count unique items without storing the items themselves. It uses a fixed ~12KB of memory regardless of input size, with a ~0.81% margin of error.

```redis
PFADD visitors "user1" "user2" "user3"
PFCOUNT visitors   → 3
```

**Use cases:** counting unique page views, unique search queries, approximate analytics.

### 8. Streams

An append-only log structure, similar to Kafka. Each entry has a unique auto-generated ID and contains field-value pairs.

```redis
XADD events * action "login" user "Alice"
XADD events * action "purchase" user "Bob"

XRANGE events - +    → all entries in order
```

Consumers can read from streams individually or as part of consumer groups.

**Use cases:** event sourcing, activity logs, real-time data pipelines.

### 9. Geospatial Indexes

Redis can store longitude/latitude coordinates and run location-based queries natively.

```redis
GEOADD locations 13.361 38.115 "Palermo"
GEOADD locations 15.087 37.502 "Catania"

GEODIST locations Palermo Catania km   → 166.27
GEOSEARCH locations FROMMEMBER Palermo BYRADIUS 200 km ASC
```

<<<SECTION 3>>>
## Core Features of Redis

### 1. Expiry & TTL

Every key in Redis can have a TTL (Time To Live), after which Redis deletes it automatically. This is fundamental to caching.

```redis
SET session "abc123"
EXPIRE session 3600       → expires in 3600 seconds (1 hour)

TTL session               → returns seconds remaining
PTTL session              → returns milliseconds remaining

PERSIST session           → removes the expiry, key lives forever
```

You can also set expiry at the time of creation:

```redis
SET session "abc123" EX 3600     → seconds
SET session "abc123" PX 3600000  → milliseconds
```

When TTL reaches 0, Redis deletes the key lazily (on access) or actively (background sweep).

**Use cases:** session tokens, OTPs, temporary cache, rate limit windows.

### 2. Eviction Policies

When Redis runs out of memory, it needs to decide which keys to delete. You configure this with the `maxmemory-policy` setting.

- `noeviction` -> Return error when memory is full
- `allkeys-lru` -> Evict least recently used keys
- `volatile-lru` -> Evict LRU keys that have TTL set
- `allkeys-lfu` -> Evict least frequently used keys
- `volatile-ttl` -> Evict keys with shortest TTL first
- `allkeys-random` -> Evict random keys

```conf
# in redis.conf
maxmemory 256mb
maxmemory-policy allkeys-lru
```

For a pure cache, `allkeys-lru` or `allkeys-lfu` is the most common choice.

### 3. Transactions

Redis transactions let you queue a group of commands and execute them all at once, atomically. No other client can inject commands in between.

```redis
MULTI           → start transaction
SET balance 100
DECRBY balance 30
INCR txn_count
EXEC            → execute all at once
```

To cancel a transaction:

```redis
MULTI
SET key1 "value"
DISCARD         → cancel, nothing is executed
```

**Important:** Redis transactions do not support rollback. If one command fails, the rest still execute. This is by design. Redis prioritizes speed over complex error handling.

**Use cases:** transferring values between keys, grouped updates that must stay consistent.

### 4. Optimistic Locking with WATCH

`WATCH` lets you monitor a key before a transaction. If the key changes before `EXEC` runs, the transaction is aborted.

```redis
WATCH balance

MULTI
DECRBY balance 50
EXEC            → returns nil if balance changed since WATCH
```

### 5. Pipelining

By default, each Redis command is sent and awaited one at a time. Pipelining lets you send multiple commands in one batch, dramatically reducing round-trip time.

Without pipelining:

```redis
SET a 1   → wait → SET b 2 → wait → SET c 3 → wait
```

With pipelining:

```redis
SET a 1 → SET b 2 → SET c 3 → wait (one round trip)
```

This can improve throughput by 5–10x in high-latency environments. Most Redis client libraries support pipelining natively.

**Note:** unlike transactions, pipelining does not guarantee atomicity. Commands in a pipeline can be interleaved with other clients.

### 6. Lua Scripting

Redis lets you run Lua scripts server-side using the `EVAL` command. The entire script runs atomically. No other command can execute in between.

```redis
EVAL "return redis.call('SET', KEYS[1], ARGV[1])" 1 mykey myvalue
```

A more practical example will be atomic increment with a cap:

```lua
local current = redis.call('GET', KEYS[1])
if tonumber(current) < tonumber(ARGV[1]) then
  return redis.call('INCR', KEYS[1])
else
  return current
end
```

You can also load scripts once and call them by their SHA hash:

```redis
SCRIPT LOAD "return redis.call('GET', KEYS[1])"
→ returns a SHA hash

EVALSHA <sha> 1 mykey
```

**Use cases:** rate limiting logic, atomic check-and-set, complex conditional updates.

### 7. Pub/Sub

Redis has a built-in publish/subscribe messaging system. Publishers send messages to a channel. Subscribers receive them in real time.

```redis
# Subscriber (client 1)
SUBSCRIBE news

# Publisher (client 2)
PUBLISH news "Redis 8.0 released!"

# Client 1 receives:
→ "Redis 8.0 released!"
```

You can also subscribe to patterns:

```redis
PSUBSCRIBE news.*       → matches news.tech, news.sports, etc.
```

**Important limitations of Pub/Sub:**

- Messages are not persisted. If a subscriber is offline, it misses the message.
- No acknowledgement or delivery guarantees.
- For reliable messaging, use Streams instead.

**Use cases:** live notifications, chat systems, real-time dashboards, event broadcasting.

<<<SECTION 4>>>
## Persistence & Reliability in Redis

Since Redis stores data in memory, it would all be lost on a restart or crash, unless you persist it to disk. Redis offers two main persistence mechanisms, and you can use both together.

### 1. RDB (Redis Database Snapshots)

RDB takes a point-in-time snapshot of your entire dataset and saves it to a binary file called `dump.rdb`. It does this by forking the main process, so Redis keeps serving requests while the snapshot is written in the background.

```conf
# redis.conf — auto snapshot rules
save 900 1       → save if at least 1 key changed in 900 seconds
save 300 10      → save if at least 10 keys changed in 300 seconds
save 60 10000    → save if at least 10000 keys changed in 60 seconds
```

You can also trigger a snapshot manually:

```redis
BGSAVE     → background save (non-blocking)
SAVE       → foreground save (blocks all commands until done)
LASTSAVE   → returns Unix timestamp of last successful save
```

**Advantages:**

- Very compact file, easy to backup and transfer
- Faster restarts, loading one binary file is quick
- Minimal performance impact during normal operation

**Disadvantages:**

- You can lose data between the last snapshot and a crash
- Forking can be slow and memory-intensive for very large datasets

**Use cases:** backups, disaster recovery, dataset transfers between environments.

### 2. AOF (Append Only File)

AOF logs every write command received by the server to a file called `appendonly.aof`. On restart, Redis replays the file to reconstruct the dataset.

```conf
# redis.conf
appendonly yes
appendfilename "appendonly.aof"
```

You control how often Redis flushes the AOF to disk with the fsync policy:

```conf
appendfsync always    → flush after every command (safest, slowest)
appendfsync everysec  → flush every second (good balance — default)
appendfsync no        → let the OS decide (fastest, least safe)
```

With `everysec`, you can lose at most 1 second of data on a crash.

#### AOF Rewriting

Over time, the AOF file grows large. Redis can compact it by rewriting only the minimum commands needed to reconstruct the current state:

```redis
BGREWRITEAOF    → triggers background AOF rewrite
```

You can also configure it to rewrite automatically:

```conf
# redis.conf
auto-aof-rewrite-percentage 100   → rewrite when AOF doubles in size
auto-aof-rewrite-min-size 64mb    → but only if it's at least 64MB
```

**Advantages:**

- Much more durable than RDB, at most 1 second of data loss
- Human-readable file, easy to inspect and repair
- Append-only means no seeks and little risk of corruption. A half-written last command is easy to repair with `redis-check-aof`

**Disadvantages:**

- AOF files are larger than RDB files
- Slower restarts. Replaying commands takes longer than loading a snapshot
- Slightly higher write overhead

### 3. RDB + AOF Hybrid (Recommended)

Since Redis 4.0, you can enable both persistence methods together. When AOF rewrite runs, Redis saves an RDB snapshot inside the AOF file, then appends any new commands after it. This gives you:

- Fast restarts from the embedded RDB snapshot
- Full durability from the AOF commands that follow

```conf
# redis.conf
appendonly yes
aof-use-rdb-preamble yes    → enables hybrid mode
```

This is the recommended setup for most production systems.

### 4. No Persistence (Pure Cache Mode)

If you are using Redis purely as a cache and data loss is acceptable, you can disable all persistence:

```conf
# redis.conf
save ""
appendonly no
```

This gives the maximum performance since Redis never writes to disk.

### 5. Data Recovery

When Redis restarts, it loads data in this priority order:

1. AOF file (if enabled) - preferred, more complete
2. RDB file (if no AOF) - fallback
3. Empty dataset (if neither exists)

You should always backup your `dump.rdb` and `appendonly.aof` files regularly, especially before upgrades.

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

A single Redis instance works well up to a point. But for high availability, fault tolerance, and horizontal scaling, Redis provides three layers of architecture: Replication, Sentinel, and Cluster.

### 1. Replication

Replication allows one Redis server (the master) to copy its data to one or more servers (replicas). Replicas stay in sync with the master in real time.

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
2. Master sends a full RDB snapshot to the replica
3. From that point, master streams every write command to the replica in real time
4. If connection drops, Redis uses partial resync to catch up without a full transfer

**Key properties:**

- Replication is asynchronous, so, master does not wait for replicas to confirm writes
- Replicas are read-only by default
- One master can have multiple replicas
- Replicas can themselves have replicas (cascading / chained replication)

**Advantages:**

- Read scaling: route read traffic to replicas
- Data redundancy: replicas serve as hot backups
- Offload heavy operations (backups, analytics) to replicas

**Disadvantage:**

- No automatic failover. If the master dies, a human or tool must promote a replica manually

### 2. Redis Sentinel

Sentinel solves the failover problem. It is a separate process that monitors your Redis master and replicas, and automatically promotes a replica to master if the master goes down.

```conf
# sentinel.conf
sentinel monitor mymaster 192.168.1.1 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 60000
sentinel parallel-syncs mymaster 1
```

The number 2 above means at least 2 Sentinels must agree the master is down before triggering a failover. This prevents split-brain from a single false positive.

**How failover works:**

1. Sentinel detects master is unreachable
2. Waits for `down-after-milliseconds` to confirm it is truly down
3. Sentinels vote and elect a leader among themselves
4. Leader promotes the most up-to-date replica to master
5. Other replicas are reconfigured to follow the new master
6. Clients are notified of the new master address

Sentinel also provides service discovery:

```redis
# Ask Sentinel for the current master address
SENTINEL get-master-addr-by-name mymaster
→ 192.168.1.2 6379   (could be a different IP after failover)
```

Your application always queries Sentinel for the master address instead of hardcoding it.

**Recommended setup:** at least 3 Sentinel instances on separate machines to ensure reliable quorum voting.

**What Sentinel does NOT do:**

- It does not shard data
- It does not scale writes
- It manages one master at a time per configuration

### 3. Redis Cluster

Redis Cluster provides horizontal sharding. Data is automatically split across multiple master nodes. It also includes built-in replication and failover without needing Sentinel.

**How sharding works-Hash Slots:**

Redis Cluster divides the keyspace into 16,384 hash slots. Every key is assigned to a slot using CRC16:

```text
slot = CRC16(key) % 16384
```

These slots are distributed across master nodes:

```text
Node A -> slots 0 to 5460
Node B -> slots 5461 to 10922
Node C -> slots 10923 to 16383
```

Each master can have one or more replicas for fault tolerance.

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

By default, each key lands on its own slot. If you need multiple keys to land on the same slot (for multi-key operations), use hash tags:

```redis
SET {user:1}.name "Alice"
SET {user:1}.age  "30"
→ both keys hash on "user:1", land on same slot
```

**Automatic failover in Cluster:**

- If a master goes down, its replica is automatically promoted
- If a master goes down with no replica, that portion of the keyspace becomes unavailable

**Limitations of Cluster:**

- Multi-key commands only work if all keys are on the same slot
- Lua scripts must only touch keys on the same slot
- Slightly more complex client support required

## Security & Operations in Redis

### 1. Authentication

By default, Redis has no authentication. Anyone who can reach the port can run any command. In production, always enable authentication.

**Simple password (requirepass):**

```conf
# redis.conf
requirepass your_strong_password

# Client must authenticate before any command
AUTH your_strong_password
```

This applies one password to all clients with full access. It works but is not granular enough for multi-user environments.

<<<SECTION 6>>>
### 2. ACL- Access Control Lists

Introduced in Redis 6.0, ACLs let you create multiple users, each with their own password, allowed commands, and allowed keys.

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

You can also define ACLs in a file:

```conf
# redis.conf
aclfile /etc/redis/users.acl
```

**Default user:** Redis always has a default user. In production, restrict or disable it:

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

Never bind to `0.0.0.0` in production unless behind a firewall.

**Disable dangerous commands:**

```conf
# redis.conf - rename a command to make it inaccessible
rename-command FLUSHALL ""
rename-command CONFIG   ""
rename-command DEBUG    ""
rename-command SHUTDOWN ""
```

Setting a command to `""` disables it completely.

**Protected mode:**

When no bind address and no password are set, Redis enables protected mode automatically, blocking external connections:

```conf
protected-mode yes   → default, blocks external access without auth
```

### 4. TLS / SSL

Redis 6.0+ supports native TLS for encrypting connections between clients and servers.

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

Use TLS whenever Redis is not on the same machine as the application, especially across networks or cloud environments.

<<<SECTION 8>>>
### 5. Memory Management

Redis lives in RAM, so memory management is critical.

**Set a memory limit:**

```conf
# redis.conf
maxmemory 512mb
maxmemory-policy allkeys-lru
```

**Check current memory usage:**

```redis
INFO memory

# Key fields:
# used_memory          → bytes used by data
# used_memory_human    → human readable
# mem_fragmentation_ratio → ratio of RSS to used memory (ideally ~1.0-1.5)
```

**Memory fragmentation:**

Over time, memory can become fragmented. Redis uses more physical RAM than the actual data requires. You can fix this with active defragmentation:

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

Redis automatically uses compact internal encodings for small data structures. For example, a small hash uses listpack instead of a full hashtable. You can tune the thresholds:

```conf
# redis.conf
hash-max-listpack-entries 128
hash-max-listpack-value   64
zset-max-listpack-entries 128
zset-max-listpack-value   64
```

Keeping data under these thresholds saves significant memory.

<<<SECTION 9>>>
### 6. Monitoring

**The INFO command:**

`INFO` is your primary tool for inspecting Redis health. It returns stats across several sections:

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

Redis logs commands that exceed a time threshold:

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

Use this for debugging only. It has a significant performance impact in production.

**CLIENT commands:**

```redis
CLIENT LIST          → all connected clients with details
CLIENT GETNAME       → name of current connection
CLIENT SETNAME myapp → name your connection for easier debugging
CLIENT KILL ID 42    → kill a specific client connection
```

### 7. RedisInsight

RedisInsight is the official GUI tool for Redis. It gives you:

- Visual browser for all keys and data structures
- Real-time memory and performance graphs
- Slow log viewer
- Built-in CLI
- Pub/Sub debugger
- Cluster topology view

It is free and available at redis.io/redisinsight. Highly recommended for development and production monitoring.

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

This is where Redis truly shines. These are battle-tested patterns used in production systems worldwide.

<<<SECTION 10>>>
### 1. Caching Patterns

#### Cache-Aside (Lazy Loading)

The most common pattern. The application checks the cache first. On a miss, it loads from the database and populates the cache.

```pseudocode
function getData(key):
    data = redis.GET(key)

    if data is null:
        data = database.query(key)
        redis.SET(key, data, EX 3600)

    return data
```

**Pros:** only caches what is actually needed

**Cons:** first request always hits the database (cold start)

#### Write-Through

Every database write also writes to the cache immediately. Cache is always in sync.

```pseudocode
function saveData(key, value):
    database.save(key, value)
    redis.SET(key, value, EX 3600)
```

**Pros:** cache is always fresh, no cold start

**Cons:** writes are slower, cache fills with data that may never be read

#### Write-Behind (Write-Back)

Write to the cache immediately, then asynchronously flush to the database in the background.

```pseudocode
function saveData(key, value):
    redis.SET(key, value)
    redis.LPUSH(write_queue, {key, value})   → background worker drains this
```

**Pros:** extremely fast writes

**Cons:** risk of data loss if Redis crashes before flush

#### Cache Stampede Prevention

When a popular key expires, hundreds of requests hit the database simultaneously. Fix this with a lock:

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

Redis is the standard choice for storing user sessions in distributed systems. All application servers share one Redis instance so any server can read any session.

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

Count requests per user within a time window. Simple but can allow bursts at window boundaries.

```pseudocode
function isAllowed(userId):
    key = ratelimit:userId:currentMinute()
    count = redis.INCR(key)

    if count == 1:
        redis.EXPIRE(key, 60)

    return count <= 100    → allow max 100 requests per minute
```

**Sliding Window with Sorted Sets:**

More accurate. Store each request timestamp as a score, remove old ones, count remaining.

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

When multiple servers need to perform an operation exclusively, use a distributed lock.

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

For stronger guarantees, acquire the lock on multiple independent Redis instances. A lock is valid only if acquired on the majority (N/2 + 1):

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

`BRPOP` blocks instead of polling, making it efficient.

**Reliable queue - preventing job loss:**

If a consumer crashes while processing, the job is lost. Fix with a processing list:

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

Sorted Sets are a perfect fit for leaderboards. Scores are always kept sorted automatically.

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

For weekly or monthly leaderboards, simply use time-scoped keys:

```text
leaderboard:2026:week22
leaderboard:2026:05
```

And expire them automatically when no longer needed.

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

Use this for live notifications, chat, live dashboards, and collaborative features.

### 8. Autocomplete with Sorted Sets

Store all possible completions with score 0. Use lexicographic range queries to find matches.

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

Check if an item has been seen before without storing every item. Uses a tiny fraction of the memory of a full set.

```pseudocode
# Add items
redis.BF.ADD(seen_emails, "alice@example.com")

# Check before processing
exists = redis.BF.EXISTS(seen_emails, "alice@example.com")
→ 1 (probably seen) or 0 (definitely not seen)
```

## Modern Redis

Redis has evolved far beyond a simple cache. Redis Stack bundles powerful modules that turn Redis into a multi-model database capable of full-text search, native JSON storage, time series data, probabilistic structures, and even vector similarity search for AI applications.

<<<SECTION 14>>>
### 1. Redis Stack

Redis Stack is the official distribution that ships Redis core along with a curated set of modules in one package:

- **RedisJSON** -> Native JSON storage and querying
- **RediSearch** -> Full-text search and secondary indexing
- **RedisTimeSeries** -> Time series data ingestion and querying
- **RedisBloom** -> Probabilistic data structures
- **RedisGraph** -> Graph database (deprecated in 2023)

You can install Redis Stack via Docker:

```bash
docker run -d --name redis-stack -p 6379:6379 -p 8001:8001 redis/redis-stack:latest
```

Port 8001 exposes RedisInsight, the built-in GUI.

### 2. RedisJSON

RedisJSON lets you store, update, and query JSON documents natively inside Redis. No more serializing JSON to a string and deserializing it on every read.

**Basic operations:**

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

**JSONPath syntax:**

RedisJSON uses JSONPath for querying:

```text
$           → root
$.field     → top-level field
$.a.b       → nested field
$[*]        → all array elements
$..field    → recursive search for field anywhere in document
$[0]        → first array element
```

RedisJSON is particularly powerful when combined with RediSearch for indexing and querying JSON fields.

<<<SECTION 15>>>
### 3. RediSearch

RediSearch adds full-text search, secondary indexing, filtering, and aggregation on top of Redis data. It works on both Hashes and JSON documents.

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

RedisTimeSeries is purpose-built for storing and querying time-stamped data like metrics, sensor readings, and financial data.

**Basic operations:**

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

Raw data compacts automatically into the downsampled series, saving memory while retaining trends.

**Multi-series query:**

```redis
# Query across all sensors by label
TS.MRANGE - + FILTER location=kitchen
```

<<<SECTION 17>>>
### 5. RedisBloom

RedisBloom adds four probabilistic data structures that solve common problems with a tiny memory footprint.

**Bloom Filter (has this item been seen?)**

```redis
BF.ADD emails "alice@example.com"
BF.ADD emails "bob@example.com"

BF.EXISTS emails "alice@example.com"   → 1 (probably yes)
BF.EXISTS emails "new@example.com"    → 0 (definitely no)
```

False positives are possible. False negatives are not. Perfect for deduplication.

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

Use for tracking top events without storing every occurrence.

**Top-K- track the K most frequent items:**

```redis
TOPK.ADD trending "redis" "kafka" "redis" "postgres" "redis"

TOPK.LIST trending
→ redis (3), kafka (1), postgres (1)
```

Use for trending topics, most-visited pages, popular products.

<<<SECTION 18>>>
### 6. Redis as a Vector Database

Since RediSearch 2.4 (2022), Redis Stack includes vector similarity search natively through RediSearch. This makes Redis usable as a vector store for AI and ML applications. Storing embeddings and searching for semantically similar items.

**What are vectors?**

When you run text, images, or audio through an embedding model (like OpenAI's text-embedding-ada-002), it produces a high-dimensional float array called a vector. Similar content produces vectors that are close together in space. Vector search finds the nearest neighbors to a query vector.

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

HNSW (Hierarchical Navigable Small World) is the approximate nearest neighbor algorithm used for fast vector search.

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

This returns the 5 most semantically similar documents to your query vector.

**Common use cases:**

- Semantic search: find documents by meaning, not just keywords
- Recommendation systems: find similar products or content
- RAG (Retrieval Augmented Generation): give LLMs relevant context
- Image similarity search
- Anomaly detection

<<<SECTION 19>>>
### 7. Redis Cloud

Redis Cloud is the fully managed cloud offering by Redis Ltd. It removes the operational burden of running Redis yourself.

**Key features:**

- Automatic failover and backups
- Multi-region active-active replication (conflict-free data sync across regions)
- Redis Stack modules included
- Scales with a slider, no manual cluster management
- Available on AWS, Google Cloud, and Azure

**Active-Active geo-distribution:**

Unlike standard replication, active-active allows writes in multiple regions simultaneously. Conflicts are resolved using CRDTs (Conflict-free Replicated Data Types) automatically.

```text
Region US-East  → write SET user:1 "Alice"
Region EU-West  → write SET user:1 "Bob"
→ conflict resolved by last-write-wins or merge strategy
```

This is ideal for globally distributed applications that need low-latency writes everywhere.

### 8. Redis 7.x and 8.x Highlights

**Redis 7.0:**

- Redis Functions: replacement for Lua scripts, persistent across restarts
- Multi-part AOF: reduces AOF rewrite overhead
- Sharded Pub/Sub: pub/sub that works natively in Cluster mode
- LMPOP / ZMPOP- pop from multiple lists or sorted sets atomically

```redis
# Redis Functions example
FUNCTION LOAD "#!lua name=mylib\nredis.register_function('myfunc', function(keys, args) return args[1] end)"
FCALL myfunc 0 "hello"   → "hello"
```

**Redis 8.0 (2025):**

- Redis Stack modules merged into Redis core, no separate installation needed
- Improved memory efficiency
- Enhanced cluster performance
