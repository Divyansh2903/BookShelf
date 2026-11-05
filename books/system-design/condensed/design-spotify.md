# Design Spotify

<<<SECTION 1>>>
## 1. Requirements

**Functional:**
- Search songs, artists, albums, playlists
- Stream songs with adaptive quality
- Playlist create, read, update, delete, share
- Recommendations from an ML pipeline

**Non-functional:**
- **High availability:** audio degrades gracefully under partial failure, not completely
- **Low latency:** first audio chunk plays within milliseconds of hitting play
- **Massive read throughput:** read/write ratio heavily skewed to reads in every service
- **Fault tolerance:** no single point of failure takes down playback
- **Eventual consistency** is fine for non-critical paths (recommendations, search indexing)

## 2. Capacity Estimation

- **DAU:** 200 million
- **Daily streams:** 1 billion
- **Average song:** 5 MB
- **Daily consumption:** 5 MB \* 1B = ~1 PB/day

With an ~80% CDN hit rate, only 20% reaches origin: ~**200 TB/day**.

Implications: a CDN is **non-negotiable** (origin costs would be catastrophic otherwise); caching must be aggressive at every layer, not just the edge; and the system should be optimized for reads, with write paths allowed slightly more latency.

<<<SECTION 2>>>
## 3. API Gateway

All client requests (mobile, desktop, web, smart TV) enter here. Responsibilities:

- **Authentication/authorization:** validate tokens before downstream services
- **Rate limiting:** stop abuse, protect services from spikes
- **Request routing** to the right microservice
- **Protocol translation:** normalize requests across client types

It must never be in the path of heavy processing. Audio upload and transcoding bypass it entirely: routing multi-hundred-megabyte files through it would make it a severe bottleneck and add latency. It handles lightweight, fast-path requests, not large binary payloads.

<<<SECTION 3>>>
## 4. Upload and Transcoding Pipeline

The most complex write path, triggered when a label or artist uploads a track.

**Step 1: Direct upload to Transcoding Service.** Bypasses the API Gateway, since the file is large and processing is CPU-intensive; neither belongs behind a request router.

**Step 2: Transcoding.** Three jobs:
- **Quality variants:** encode at 96kbps (very low bandwidth), 128kbps (normal), 256kbps (high), 320kbps (premium). Lets Spotify downgrade quality on a degraded network without interrupting playback.
- **Chunking:** split each variant into ~2-10 second segments, independent stateless HTTP objects. This makes CDN caching viable, allows seeking without downloading earlier parts, and lets the client switch quality mid-stream by requesting a different chunk URL.
- **DRM certification:** each chunk is encrypted and tied to a license only authenticated, paying users can get, protecting artists' and labels' IP.

**Step 3: Storage in S3.** Chunks for all variants go to blob storage (S3 or equivalent). Chunks are large, immutable, and never updated in place. S3 offers durability, virtually unlimited storage, and native CDN integration.

**Step 4: Event to Kafka.** On completion, the Transcoding Service publishes one event (e.g. `song.transcoded`) with song ID and metadata. It does not call the Metadata or Search Service directly; this decoupling is intentional and critical.

**Step 5: Fanout via Kafka consumers.** Two independent consumers:
- **Metadata Worker:** writes metadata (title, artist, album, genre, duration, chunk manifest URL) to the Metadata DB, then updates the Metadata Cache.
- **Search Indexing Worker:** indexes the song in Elasticsearch, searchable within seconds.

This **event-driven fanout** means neither consumer blocks the other. If the Search Indexing Worker is down, it falls behind on its Kafka offset and catches up later, losing no data. This keeps multiple datastores eventually consistent without tight coupling.

**Bottlenecks:** transcoding is the main one. Encoding five variants, chunking, and DRM is CPU-heavy and can take minutes for long tracks. Run the Transcoding Service as a horizontally scalable worker pool pulling jobs from a queue; jobs are independent, so it scales linearly. Kafka has no meaningful bottleneck at this scale.

<<<SECTION 4>>>
## 5. Streaming Service

The most read-heavy, latency-sensitive path. When a user hits play:

**Step 1: Metadata and signed URL.** Client sends `GET /songs/{id}` via the API Gateway. The Streaming Service fetches metadata from the Metadata Service (title, artist, album art, duration) and generates a **signed URL** to the HLS manifest in S3/CDN. The URL has a short TTL and is tied to the authenticated user, enforcing DRM at the delivery layer.

**Step 2: HLS manifest.** A small, CDN-cacheable text file listing all quality variants and every chunk URL per variant.

**Step 3: Chunk fetching.** Client fetches chunks sequentially: `GET /songs/{song_id}/{quality}/{chunk_index}.ts`, from the nearest CDN edge. On a hit (~80% for popular songs), the CDN serves it with no backend involvement. On a miss, the CDN fetches from S3, caches, and serves.

### HLS being the Right Protocol

HLS (HTTP Live Streaming) runs over standard HTTP, so each chunk is a normal GET that CDNs handle natively. Chunks are static with deterministic URLs, so perfectly cacheable. The client adapts quality locally by switching which variant's chunks it requests; the server needn't know. Once a session begins, the streaming path has almost no server-side state, which makes it resilient.

### Resilience Property

Since chunks are cached independently at the edge, a mid-stream user keeps receiving audio even if the Metadata Service, Streaming Service, or origin S3 is temporarily unreachable. This emerges from the architecture without special failover logic, and is why Spotify keeps playing on degraded connections even when it can't reach its backend.

### Bottlenecks in Streaming

The CDN absorbs 80%; the bottleneck is the 20% of misses hitting S3, which is highly available and durable but adds latency. A newly uploaded, never-requested song triggers a cache fill on first listen (**cold start**), slightly slower for that request; generally acceptable. The Streaming Service only issues signed URLs and fetches metadata, so it is stateless and horizontally scalable with no meaningful bottleneck.

<<<SECTION 5>>>
## 6. Search Service

A different read pattern: partial strings must return ranked, fuzzy-matched results across songs, artists, albums, and playlists within milliseconds.

### Storage Engine - Elasticsearch

Built on an **inverted index**, making full-text search, partial matching, and relevance ranking fast:
- **Prefix and fuzzy matching:** "Tay" returns Taylor Swift; "Bohemn" returns Bohemian Rhapsody
- **Multi-entity search:** one query spans songs, artists, albums, playlists
- **Relevance ranking:** text match score plus popularity signals and personalization

Elasticsearch is not the system of record. It is a read-optimized projection derived from the Metadata DB, which is the source of truth.

### Keeping Elasticsearch in Sync

The Search Indexing Worker consumes `song.transcoded` and writes each new upload. For updates (e.g. an artist renames), the Metadata Service publishes to a separate Kafka topic the worker also consumes. Elasticsearch stays eventually consistent with no synchronous coupling.

### Caching Hot Search Results

Very common queries ("Drake", "Taylor Swift", "workout playlist") are cached in Redis with a short TTL, so Elasticsearch isn't hit by identical queries thousands of times per second.

### Bottlenecks in Search

Elasticsearch can bottleneck under extreme volume, especially complex multi-field fuzzy queries. Mitigations: Redis caching of hot queries (filters most repeat traffic), horizontal scaling of the cluster, and query optimization (tuning analyzers and index mappings for music-search access patterns).

<<<SECTION 6>>>
## 7. Metadata Service

Source of truth for descriptive data on songs, artists, albums, and playlists. The most depended-upon service: Search, Streaming, Playlists, and Recommendations all read from it.

### Database - PostgreSQL (Sharded)

Metadata is clearly relational: a song belongs to an album, an album to an artist, an artist has many songs, a song has many genres. PostgreSQL handles this and gives strong consistency, which matters because metadata indexed into Elasticsearch must match the Metadata DB.

One instance can't handle the read load at Spotify scale. The DB is horizontally sharded (typically by artist ID or song ID), each shard with multiple read replicas. Most reads hit replicas; writes go to the primary.

### Cache - Redis

Redis in front of the DB absorbs most reads. Hot metadata (popular artists, trending songs, top albums) has a very high hit rate, as the same records are requested millions of times a day. Invalidation happens when the Metadata Worker processes an upload or update event from Kafka.

### Bottlenecks in Metadata

One of the two most critical bottlenecks (the other is the CDN), with three major services depending on it. Without Redis, read replicas would be overwhelmed; without sharding, one instance caps throughput. Redis + read replicas + sharding make it scale. Remaining risk: **cache stampede**, where a Redis outage sends every service to the DB at once. Mitigated with circuit breakers and staggered TTLs.

<<<SECTION 7>>>
## 8. Playlist Service

Users create, curate, share, and sometimes collaborate on playlists. Data model: a user has many playlists, a playlist has many songs (by song ID), and a playlist can be shared with other users.

### Access Patterns

Simple and key-based:
- All playlists for a user: lookup by user ID
- All songs in a playlist: lookup by playlist ID
- Add/remove a song: write by playlist ID
- Share: associate another user ID with a playlist ID

No joins at read time. The client fetches song details (title, artist, duration) separately from the Metadata Service using stored song IDs; the Playlist Service only stores and returns IDs.

### Database - Cassandra

Key-based access, high write volume (constant playlist edits), and billions of playlists globally make Cassandra a better fit than PostgreSQL.

It is a wide-column store optimized for write throughput and horizontal scale. No joins, which aren't needed. Its partition key model matches the access patterns: partition by user ID for a user's playlists, by playlist ID for a playlist's songs.

Replication factor (typically 3 across availability zones) keeps reads and writes going when nodes fail, a significant advantage over a single-primary relational DB.

### Bottlenecks in Playlists

**Hot partitions:** a hugely popular shared playlist (e.g. a Spotify editorial playlist with millions of followers) gets disproportionate traffic on its partition. Cache popular playlists in Redis so most of those reads never reach Cassandra.

<<<SECTION 8>>>
## 9. Recommendation Service

The ML model is out of scope; the data infrastructure feeding it is not. Recommendations are only as good as their behavioral signals.

**Signals collected:**
- **Play events:** which song, how long, whether skipped early
- **Playlist additions:** songs users choose to save
- **Search patterns:** artists and genres searched repeatedly
- **Genre distribution** across listening history
- **Collaborative filtering:** users who played X also played Y

### Ingestion Architecture

Every interaction generates an event. At 1 billion streams/day plus skips, searches, and playlist edits, writing synchronously to a database would create write bottlenecks that degrade UX.

Instead, clients publish events to Kafka. Workers write them to an analytics store (Cassandra or ClickHouse, both good at high write volume and time-series data). The ML pipeline reads it periodically (hourly or daily), recomputes recommendations, and writes results to Redis keyed by user ID.

### Serving Recommendations

A single Redis read: `GET recommendations:{user_id}`, one of the cheapest operations in the system. Heavy work happens offline.

### Bottlenecks in Recommendations

The bottleneck is ingestion, not serving. Kafka must take the full event volume from all DAU, well within its design envelope. Analytics store write throughput is the subtler concern, which is why ClickHouse or Cassandra (not PostgreSQL) fit that layer.

<<<SECTION 9>>>
## 10. Full Data Flow Summary

**Upload Flow:**
- Label -> Transcoding Service -> S3 (chunks, all quality variants)
- Transcoding Service -> Kafka (song.transcoded event)
  - -> Metadata Worker -> Metadata DB + Redis Cache
  - -> Search Worker -> Elasticsearch

**Playback Flow:**
- Client -> API Gateway -> Streaming Service -> Signed URL + Metadata
- Client -> CDN edge node (cache hit ~80%) -> audio chunk served directly
- Client -> CDN edge node (cache miss ~20%) -> S3 -> CDN caches -> audio chunk served

**Search Flow:**
- Client -> API Gateway -> Search Service -> Redis (hot query cache)
  - -> Elasticsearch (cache miss)
  - -> Metadata Service (fetch full metadata for results)

**Playlist Flow:**
- Client -> API Gateway -> Playlist Service -> Cassandra (playlist structure)
  - -> Metadata Service (song details for each ID)

**Event Ingestion Flow:**
- Client interactions -> Kafka -> Analytics Workers -> Analytics DB
  - -> ML Pipeline (periodic) -> Redis (recommendations)

<<<SECTION 10>>>
## 11. Resilience and Fault Tolerance

- **CDN + HLS chunking:** the most important resilience property. Chunks are cached independently at the edge over plain HTTP, so mid-stream users keep getting audio even if the Metadata Service, Streaming Service, or origin S3 is unreachable. No special failover logic needed.
- **Kafka decoupling:** upload components fail and recover independently. A Search Indexing Worker down for an hour falls behind on its offset and catches up; no events lost; Transcoding Service and Metadata Worker unaffected.
- **Cassandra replication:** factor 3 across availability zones keeps playlist data through node and zone failures. Tunable consistency lets the Playlist Service pick strong (all replicas agree) or eventual (fastest replica responds) per operation.
- **Multi-layer Redis caching:** reduces load on primary stores; if Metadata DB replicas are slow, Redis absorbs most traffic. Circuit breakers stop cache failures cascading into DB overload.
- **Metadata DB read replicas:** no single point of failure for reads on the most depended-upon store. Writes go to the primary; reads fan out.

<<<SECTION 11>>>
## 12. Technology Choices Summary

- **API Gateway:** Kong / AWS API Gateway (auth, rate limiting, routing)
- **Blob Storage:** AWS S3 (immutable audio chunks, durable, CDN-native)
- **CDN:** CloudFront / Akamai (edge caching, absorbs 80% of streaming load)
- **Streaming Protocol:** HLS (chunked, adaptive bitrate, CDN-friendly, stateless)
- **Decoupling:** Apache Kafka (high-throughput event fanout, durable, replayable)
- **Search Engine:** Elasticsearch (full-text, fuzzy matching, relevance ranking)
- **Metadata DB:** PostgreSQL, sharded + replicas (relational structure, strong consistency)
- **Playlist DB:** Cassandra (key-based access, high write throughput, horizontal scale)
- **Cache:** Redis (hot metadata, recommendations, search results, playlist hot reads)
- **Analytics Store:** Cassandra / ClickHouse (high write volume, time-series data, ML pipeline input)
