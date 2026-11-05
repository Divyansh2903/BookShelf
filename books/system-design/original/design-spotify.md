# Design Spotify

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

- Search for songs, artists, albums, and playlists
- Stream songs with adaptive quality
- Playlist management with create, read, update, delete, and share
- Song recommendations driven by an ML pipeline

### Non-Functional Requirements

- High availability: Audio delivery must degrade gracefully under partial failures, not fail completely
- Low latency streaming: The first audio chunk must begin playing within milliseconds of hitting play
- Massive read throughput: The read/write ratio is heavily skewed toward reads across every service
- Fault tolerance: No single point of failure should take down core playback
- Eventual consistency is acceptable for non-critical paths like recommendations and search indexing

## 2. Capacity Estimation

- **DAU:** 200 million
- **Daily streams:** 1 billion
- **Average song size:** 5 MB
- **Total data consumed per day:** 5 MB \* 1B = ~1 PB/day (for easier-estimation)

This is the raw consumption number, but it is not what your infrastructure actually needs to serve from the origin. With a CDN cache hit rate of roughly 80%, only 20% of requests reach origin servers, bringing that number down to approximately **200 TB/day** at origin, which is far more manageable.

The estimation immediately tells us three things. First, a CDN is **non-negotiable.** Without it, origin infrastructure costs would be catastrophic. Second, caching must be aggressive at every layer of the stack, not just at the edge. Third, because the read/write ratio is so extreme, the entire system should be optimized for read performance, and write paths can afford slightly more latency.

<<<SECTION 2>>>
## 3. API Gateway

Every client request, whether from a mobile app, desktop client, web browser, or smart TV, enters the system through the API Gateway. Its responsibilities are:

- **Authentication and authorization:** Validating tokens before any request reaches a downstream service
- **Rate limiting:** Preventing abuse and protecting downstream services from traffic spikes
- **Request routing:** Directing requests to the correct microservice
- **Protocol translation:** Normalizing requests from different client types

One critical design decision is knowing what the API Gateway should not do. It must never be in the path of heavy processing. Specifically, the audio upload and transcoding pipeline must bypass it entirely. Routing a multi-hundred-megabyte audio file through the API Gateway would make it a severe bottleneck and introduce unnecessary latency. The Gateway is designed for lightweight, fast-path request handling, not for moving large binary payloads.

<<<SECTION 3>>>
## 4. Upload and Transcoding Pipeline

This is the most complex write path in the system. When a record label or artist uploads a new track, the following sequence occurs.

### Step 1: Direct Upload to Transcoding Service

The raw audio file is sent directly to the Transcoding Service, completely bypassing the API Gateway. This is intentional. The file is large, the processing is CPU-intensive, and neither of those properties belongs behind a request router.

### Step 2: Transcoding

The Transcoding Service is responsible for three things:

**Quality variants.** The raw file is encoded into multiple bitrate variants. Typically 96kbps for very low bandwidth, 128kbps for normal, 256kbps for high quality, and 320kbps for premium. This is what enables Spotify to seamlessly downgrade audio quality when a user's network degrades, without interrupting playback.

**Chunking.** Each quality variant is broken into small segments of roughly 2-10 seconds each. These chunks are independent, stateless HTTP objects. This is fundamental to the entire streaming architecture. It is what makes CDN caching viable, what enables seeking to any position in a song without downloading everything before it, and what allows the client to switch quality variants mid-stream by simply switching which chunk URL it requests next.

**DRM certification.** Each chunk is encrypted and tied to a license that only authenticated, paying users can obtain. This protects the intellectual property of artists and labels.

### Step 3: Storage in S3

The processed chunks, across all quality variants, are stored in blob storage (S3 or equivalent). Blob storage is the right choice here because audio chunks are large, immutable, and never updated in place. Once a chunk is written, it never changes. S3 gives us durability, virtually unlimited storage, and native integration with CDN distributions.

### Step 4: Event Published to Kafka

Once transcoding completes, the Transcoding Service publishes a single event to a Kafka topic  (something like song.transcoded), containing the song ID and relevant metadata. The Transcoding Service does not care what happens next. It does not call the Metadata Service or the Search Service directly. This decoupling is intentional and critical.

### Step 5: Fanout via Kafka Consumers

Two independent consumers subscribe to the song.transcoded topic:

**Metadata Worker:** Reads the event and writes song metadata (title, artist, album, genre, duration, chunk manifest URL) to the Metadata DB, then updates the Metadata Cache.

**Search Indexing Worker:** Reads the same event and indexes the song into Elasticsearch, making it discoverable via search within seconds.

This is the event-driven fanout pattern. Neither consumer blocks the other. If the Search Indexing Worker is temporarily down, it simply falls behind on the Kafka offset and catches up when it recovers, so no data is lost. This is the correct way to keep multiple datastores eventually consistent without tight coupling between services.

### Bottlenecks in This Pipeline

The transcoding step itself is the primary bottleneck. Encoding a single track into five quality variants, chunking each variant, and applying DRM is CPU-intensive and can take minutes for long tracks. This is handled by running the Transcoding Service as a horizontally scalable worker pool, many workers pulling jobs from a queue. Individual transcoding jobs are independent, so this scales linearly. The Kafka layer downstream has no meaningful bottleneck at this scale since it is designed for exactly this kind of high-throughput event streaming.

<<<SECTION 4>>>
## 5. Streaming Service

Streaming is the most read-heavy, latency-sensitive path in the entire system. When a user hits play:

### Step 1: Metadata and Signed URL Request

The client sends GET /songs/{id} to the Streaming Service via the API Gateway. The Streaming Service does two things: it fetches song metadata from the Metadata Service (title, artist, album art, duration), and it generates a **signed URL** pointing to the HLS manifest file in S3/CDN. The signed URL has a short TTL and is tied to the authenticated user, which is how DRM enforcement works at the delivery layer.

### Step 2: HLS Manifest

The client fetches the HLS manifest file, which is a small text file listing all available quality variants and the URLs of every chunk for each variant. This manifest is itself a cacheable object served by the CDN.

### Step 3: Chunk Fetching

The client begins fetching chunks sequentially. Each chunk request looks like GET /songs/{song_id}/{quality}/{chunk_index}.ts. These requests go to the CDN edge node closest to the user. On a cache hit, which happens roughly 80% of the time for popular songs, the CDN serves the chunk directly with no backend involvement whatsoever. On a cache miss, the CDN fetches the chunk from S3, caches it, and serves it.

### HLS being the Right Protocol

HLS (HTTP Live Streaming) was designed precisely for this use case. It operates entirely over standard HTTP, which means every chunk is a normal HTTP GET request that CDNs handle natively. Chunks are static objects with deterministic URLs, making them perfectly cacheable. The client controls quality adaptation locally by switching which variant's chunks it requests. The server does not need to know or care. This simplicity is what makes the architecture so resilient: the streaming path has almost no statefulness on the server side once a session begins.

### Resilience Property

Because chunks are cached independently at the CDN edge, a user who is mid-stream continues receiving audio even if the Metadata Service, Streaming Service, or even the origin S3 bucket becomes temporarily unreachable. The CDN has the chunks. This is an emergent resilience property of the architecture, not something that requires special failover logic. It is the reason why Spotify can continue playing songs on a degraded network connection even when it cannot reach its own backend.

### Bottlenecks in Streaming

The CDN absorbs 80% of load, so the real bottleneck is the 20% of requests that miss the cache and hit S3. S3 is highly available and durable but adds latency on cache misses. For newly uploaded songs that have never been requested before, the first listener triggers a cache fill. this is called a cold start and results in slightly higher latency for that first request. This is generally acceptable for the upload use case but worth noting. The Streaming Service itself, which only issues signed URLs and fetches metadata, is stateless and horizontally scalable with no meaningful bottleneck.

<<<SECTION 5>>>
## 6. Search Service

Search is a fundamentally different read pattern from streaming. A user types a partial string and expects ranked, fuzzy-matched results across songs, artists, albums, and playlists, all within milliseconds.

### Storage Engine - Elasticsearch

Elasticsearch is the right tool for this problem. It is built on top of an inverted index, which makes full-text search, partial matching, and relevance ranking extremely fast. It handles:

- **Prefix and fuzzy matching-** Typing "Tay" returns Taylor Swift, typing "Bohemn" returns Bohemian Rhapsody
- **Multi-entity search-** A single query searches across songs, artists, albums, and playlists simultaneously
- **Relevance ranking-** Results are ranked by a combination of text match score, popularity signals, and personalization

Elasticsearch is not used as the system of record. It is a search index that is derived from the Metadata DB. The source of truth for any song's metadata lives in the Metadata DB. Elasticsearch is a read-optimized projection of that data.

### Keeping Elasticsearch in Sync

This is where the Kafka fanout described in the upload pipeline pays off. The Search Indexing Worker subscribes to the song.transcoded topic and writes to Elasticsearch for every new upload. For updates, Say an artist changes their name. The Metadata Service publishes an update event to a separate Kafka topic that the Search Indexing Worker also consumes. This keeps Elasticsearch eventually consistent with the source of truth without any synchronous coupling.

### Caching Hot Search Results

For extremely common queries, searching for "Drake", "Taylor Swift", "workout playlist", results are cached in Redis with a short TTL. This prevents Elasticsearch from being hammered by identical queries thousands of times per second.

### Bottlenecks in Search

Elasticsearch clusters can become bottlenecks under extreme query volume, particularly for complex multi-field queries with fuzzy matching enabled. The mitigation is a combination of Redis caching for hot queries (which filters out the majority of repeat traffic before it hits Elasticsearch), horizontal scaling of the Elasticsearch cluster, and query optimization, tuning analyzers and index mappings for the specific access patterns of music search.

<<<SECTION 6>>>
## 7. Metadata Service

The Metadata Service is the source of truth for all descriptive data about songs, artists, albums, and playlists. It is the most widely depended-upon service in the system Search, Streaming, Playlists, and Recommendations all read from it.

### Database - PostgreSQL (Sharded)

Song metadata has a clear relational structure. A song belongs to an album, an album belongs to an artist, an artist has many songs, and a song has many genres. PostgreSQL handles these relationships naturally and gives strong consistency guarantees, which matter here, when a new song is indexed into Elasticsearch, the metadata it indexes must match what is in the Metadata DB.

At Spotify's scale, a single PostgreSQL instance cannot handle the read load. The database is horizontally sharded, typically by artist ID or song ID, and each shard has multiple read replicas. The majority of metadata reads go to read replicas, and writes go to the primary.

### Cache - Redis

A Redis cache sits in front of the Metadata DB and absorbs the vast majority of read traffic. Hot metadata (popular artists, trending songs, top albums) has a very high cache hit rate since the same records are requested millions of times per day. Cache invalidation happens when the Metadata Worker processes an upload event or an update event from Kafka.

### Bottlenecks in Metadata

The Metadata Service is one of the two most critical bottlenecks in the system, the other being the CDN. Three major services depend on it. Without Redis, the PostgreSQL read replicas would be overwhelmed. Without sharding, a single database instance would become a hard ceiling on throughput. The combination of Redis caching, read replicas, and horizontal sharding is what makes this layer scale. The remaining risk is cache stampede. If Redis goes down, every service simultaneously falls back to the database. This is mitigated with circuit breakers and staggered TTLs.

<<<SECTION 7>>>
## 8. Playlist Service

Playlists are a social and personal feature. Users create them, curate them, share them with friends, and in some cases collaborate on them. The data model is straightforward: a user has many playlists, a playlist has many songs (referenced by song ID), and a playlist can be shared with other users.

### Access Patterns

The access patterns for playlists are simple and key-based:

- Fetch all playlists for a user - lookup by user ID
- Fetch all songs in a playlist - lookup by playlist ID
- Add or remove a song - write by playlist ID
- Share a playlist - associate another user ID with a playlist ID

There are no complex joins needed at read time. When the client needs song details (title, artist, duration), it fetches those separately from the Metadata Service using the song IDs stored in the playlist. The Playlist Service itself only stores and returns IDs.

### Database - Cassandra

Given simple key-based access patterns, high write volume (users are constantly modifying playlists), and the need to scale to billions of playlists globally, Cassandra is the right choice over PostgreSQL here.

Cassandra is a wide-column store optimized for high write throughput and horizontal scalability. It does not support joins, which is fine because we do not need them; song metadata is fetched separately. Its partition key model maps directly to the access patterns: partition by user ID to get all playlists for a user, partition by playlist ID to get all songs in a playlist.

Cassandra's replication factor (typically 3 across multiple availability zones) ensures that even if nodes go down, playlist reads and writes continue without interruption. This is a significant resilience advantage over a single-primary relational database.

### Bottlenecks in Playlists

The primary concern with Cassandra is hot partitions. If a single extremely popular shared playlist (say, a Spotify editorial playlist with millions of followers) is accessed constantly, its partition receives disproportionate traffic. This is mitigated by caching popular playlists in Redis, so the vast majority of reads for hot playlists never reach Cassandra at all.

<<<SECTION 8>>>
## 9. Recommendation Service

The ML model itself is out of scope, but the data infrastructure feeding it is not. Recommendations are only as good as the behavioral signals they are built on.

Signals Collected

- **Play events-** Which song was played, for how long, and whether it was skipped early
- **Playlist additions-** Which songs users actively choose to save
- **Search patterns-** Which artists and genres a user searches for repeatedly
- **Genre distribution-** The spread of genres across a user's listening history
- **Collaborative filtering signals-** Users who listened to song X also listened to song Y

### Ingestion Architecture

Every user interaction generates an event. At 1 billion streams per day plus skips, searches, and playlist modifications, this is an extremely high-volume write path. Writing these events synchronously to a database would be catastrophic, it would create write bottlenecks that degrade the user experience.

Instead, every client interaction publishes an event to Kafka. Workers consume from Kafka and write to an analytics store (Cassandra or ClickHouse work well here, both handle high write volume and time-series style data efficiently). The ML pipeline reads from the analytics store on a periodic schedule (hourly or daily), recomputes recommendations, and writes the results back to Redis keyed by user ID.

### Serving Recommendations

Serving a recommendation to a user is a single Redis read - GET recommendations:{user_id}. It is one of the cheapest operations in the entire system. All the heavy work happens offline in the ML pipeline, not at request time.

### Bottlenecks in Recommendations

The bottleneck is not in serving recommendations but in the ingestion pipeline. Kafka must handle the full event volume from all DAU simultaneously. This is well within Kafka's design envelope, it is built for exactly this scale. The analytics store write throughput is the more nuanced concern, which is why ClickHouse or Cassandra (rather than PostgreSQL) are appropriate choices for that layer.

<<<SECTION 9>>>
## 10. Full Data Flow Summary

**Upload Flow:**  
Label -> Transcoding Service -> S3 (chunks, all quality variants)  
                            -> Kafka (song.transcoded event)  
                                -> Metadata Worker -> Metadata DB + Redis Cache  
                                -> Search Worker   -> Elasticsearch  
  
**Playback Flow:**  
Client -> API Gateway -> Streaming Service -> Signed URL + Metadata  
Client -> CDN edge node (cache hit ~80%)  -> audio chunk served directly  
Client -> CDN edge node (cache miss ~20%) -> S3 -> CDN caches -> audio chunk served  
  
**Search Flow:**  
Client -> API Gateway -> Search Service -> Redis (hot query cache)  
                                      -> Elasticsearch (cache miss)  
                                      -> Metadata Service (fetch full metadata for results)  
  
**Playlist Flow:**  
Client -> API Gateway -> Playlist Service -> Cassandra (playlist structure)  
                                        -> Metadata Service (song details for each ID)  
  
**Event Ingestion Flow:**  
Client interactions -> Kafka -> Analytics Workers -> Analytics DB  
                                                -> ML Pipeline (periodic) -> Redis (recommendations)

<<<SECTION 10>>>
## 11. Resilience and Fault Tolerance

**CDN + HLS chunking** is the most important resilience property in the system. Because audio chunks are independently cached at edge nodes and served over plain HTTP, a user mid-stream continues receiving audio even if the Metadata Service, Streaming Service, or origin S3 becomes temporarily unreachable. No special failover logic is required, it is a natural consequence of the architecture.

**Kafka decoupling** means the upload pipeline components can fail and recover independently. If the Search Indexing Worker goes down for an hour, it simply falls behind on its Kafka offset and catches up on recovery. No events are lost. The Transcoding Service and Metadata Worker are completely unaffected.

**Cassandra replication** with a replication factor of 3 across availability zones ensures that playlist data survives node and zone failures. Cassandra's tunable consistency allows the Playlist Service to choose between strong consistency (all replicas must agree) and eventual consistency (fastest available replica responds) depending on the operation.

**Redis caching at multiple layers** reduces dependency on primary datastores under high load. If Metadata DB read replicas are slow, Redis absorbs the majority of traffic anyway. Circuit breakers prevent cache failures from cascading into full database overload.

**Read replicas on Metadata DB** ensure that the most widely depended-upon datastore in the system has no single point of failure for reads. Writes go to the primary, reads fan out across replicas.

<<<SECTION 11>>>
## 12. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, routing)

**Blob Storage** -> AWS S3 (Immutable audio chunks, durable, CDN-native)

**CDN** -> CloudFront / AkamaiEdge (caching, absorbs 80% of streaming load)

**Streaming Protocol** -> HLS (Chunked, adaptive bitrate, CDN-friendly, stateless)

**Decoupling** -> Apache Kafka (High-throughput event fanout, durable, replayable)

**Search Engine** -> Elasticsearch (Full-text, fuzzy matching, relevance ranking)

**Metadata DB** -> PostgreSQL (sharded + replicas) (Relational structure, strong consistency)

**Playlist DB** -> Cassandra (Key-based access, high write throughput, horizontal scale)

**Cache** -> Redis (Hot metadata, recommendations, search results, playlist hot reads)

**Analytics Store** -> Cassandra / ClickHouse (High write volume, time-series data, ML pipeline input)

That's all, folks...Cheers!!!
