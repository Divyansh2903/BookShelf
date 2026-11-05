# Design Bit.ly and Pastebin

<<<SECTION 1>>>
## Designing Bit.ly - the URL shortener

Before going forward with the design, it's important to highlight what those dreadful interviewers actually want.

### The structure interviewers want to see

1. Functional requirements
2. Non-functional requirements (latency, scale, availability)
3. Back-of-envelope math
4. High-level design
5. Deep dives on bottlenecks.

### Functional requirements for Bit.ly

1. Shorten a long URL
2. Redirect the short URL back to the original
3. Analytics (optional for most interviews to be honest)

### Nature of the system

This is a read-heavy system because a URL is shortened once but accessed many times. This single observation drives most of your design decisions, such as caching, read replicas, and service separation.

### Back-of-envelope

Let's have 10M Daily Active Users here for our assumption.

At 10M DAU with 1B lifetime URLs, rounding seconds in a day to 100k gives roughly 10,000 req/s total. But split reads from writes - writes are maybe 1% of traffic (~100 req/s), reads are the remaining 99% (~9,900 req/s). Always separate these. They scale independently.

### Now, the short link generation

There is a common mistake here, i.e., using MD5 or SHA-256 and taking the first 6 characters. Two different URLs can produce the same 6-char prefix, that's a collision.

Use Base62 encoding of an auto-incremented ID instead. Each ID is unique by definition, so its Base62 encoding is also unique. No collisions, no retries needed. With 6 characters in Base62 you get ~56B possible URLs.

P.S - 62 comes from : 0-9 numbers + a-z chars + A-Z chars (10+26+26)

Architecture will look something like this -

Client -> API gateway -> two services -> database.

1. Shortener service handles writes: generates the Base62 ID, stores the mapping in DB.
2. Redirector service handles reads: looks up the short URL, returns the long URL.

### Caching & scaling reads

Use Redis with LRU eviction. About 20% of URLs drive 80% of traffic — LRU naturally keeps hot links in cache and evicts ones nobody's visiting. Set a TTL on top of that.

For cache misses, use read replicas to distribute DB read load. The scaling hierarchy is: Redis first, read replicas second, DB sharding only if write load also becomes a problem. Don't jump to sharding early.

### DB schema would probably look something like this

- `urlId` (the unique ID for the url)
- `shortURL` (the shortened URL)
- `longURL` (the one to be redirected to)
- `userID` (the user who created the url)
- `created_at` (timing of its creation)

SQL works fine here. Queries are simple lookups, no complex joins. Cassandra is also viable at very large scale, but you'd store everything in one denormalized table since it doesn't support joins.

That's all folks for Bit.ly.

<<<SECTION 2>>>
## Designing Pastebin

### Functional requirements

1. Paste a block of text, get a short link
2. Anyone with the link can read the content
3. Links expire after some time

### Nature of the system

Also read-heavy, not write-heavy. A paste is created once and read many times. Same caching stuff can be used here. Redis with LRU eviction for frequently accessed pastes.

### The key difference from Bit.ly is content storage

The biggest mistake in Pastebin design is storing the text blob directly in the database. Large text content slows down your DB significantly.

So, we will split storage into two layers:

1. Database stores metadata only: userID, shortLink, an S3 URL pointer, created_at, expires_at.
2. Object storage (like AWS S3) stores the actual text content.

The DB holds a pointer to the content, not the content itself. This keeps our DB lean and fast.

### Architecture

Client -> API gateway -> two services -> DB + S3.

1. Write service: takes the text, uploads it to S3, generates a Base62 ID, saves metadata + S3 URL to DB, all in one operation.
2. Read service: takes the short link, fetches metadata from DB, fetches content from S3, returns it to the user.

### Expiry (imp here)

Always add expires_at to your schema and mention a cleanup job that removes expired pastes from both the DB and S3. This is a Pastebin-specific detail that signals you think about real product behaviour, not just the happy path.
