# Design Bit.ly and Pastebin

<<<SECTION 1>>>
## Designing Bit.ly - the URL shortener

**Interview structure:** functional requirements; non-functional requirements (latency, scale, availability); back-of-envelope math; high-level design; deep dives on bottlenecks.

**Functional requirements:**
1. Shorten a long URL
2. Redirect the short URL to the original
3. Analytics (optional in most interviews)

**Nature:** read-heavy. A URL is shortened once but accessed many times, which drives caching, read replicas, and service separation.

**Back-of-envelope:** assume 10M DAU and 1B lifetime URLs. Rounding seconds per day to 100k gives ~10,000 req/s. Writes are ~1% (~100 req/s), reads ~99% (~9,900 req/s). Always separate them; they scale independently.

### Short link generation

Common mistake: taking the first 6 characters of an MD5 or SHA-256 hash. Two URLs can share the same 6-char prefix (collision).

Instead, Base62-encode an auto-incremented ID. Each ID is unique, so its encoding is unique: no collisions, no retries. 6 Base62 characters give ~56B URLs. (62 = 0-9 + a-z + A-Z = 10+26+26.)

**Architecture:** Client -> API gateway -> two services -> database.
1. **Shortener service** (writes): generates the Base62 ID, stores the mapping.
2. **Redirector service** (reads): looks up the short URL, returns the long URL.

### Caching & scaling reads

Use Redis with LRU eviction plus a TTL. ~20% of URLs drive 80% of traffic, so LRU keeps hot links and evicts unvisited ones.

Cache misses go to read replicas. Scaling order: Redis, then read replicas, then DB sharding only if write load also becomes a problem. Don't shard early.

### DB schema

- `urlId` (unique ID)
- `shortURL`
- `longURL` (redirect target)
- `userID` (creator)
- `created_at`

SQL works: simple lookups, no complex joins. Cassandra is viable at very large scale, using one denormalized table since it doesn't support joins.

<<<SECTION 2>>>
## Designing Pastebin

**Functional requirements:**
1. Paste text, get a short link
2. Anyone with the link can read it
3. Links expire after some time

**Nature:** also read-heavy (created once, read many times). Same caching: Redis with LRU for frequently accessed pastes.

### Key difference from Bit.ly: content storage

Biggest mistake: storing the text blob in the database. Large text slows the DB significantly. Split storage:
1. **Database** stores metadata only: userID, shortLink, S3 URL pointer, created_at, expires_at.
2. **Object storage** (e.g. AWS S3) stores the text.

The DB holds a pointer, not the content, keeping it lean and fast.

### Architecture

Client -> API gateway -> two services -> DB + S3.
1. **Write service:** uploads text to S3, generates a Base62 ID, saves metadata + S3 URL to DB, in one operation.
2. **Read service:** fetches metadata from DB by short link, fetches content from S3, returns it.

### Expiry (important)

Always add `expires_at` to the schema and mention a cleanup job that removes expired pastes from both DB and S3. This Pastebin-specific detail shows you think about real product behaviour, not just the happy path.
