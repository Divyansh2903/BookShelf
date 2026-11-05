# Design Youtube

<<<SECTION 1>>>
## Problem Scope

Scope: **video upload and streaming**. Auth and social features (comments, likes, subscriptions) excluded.

### Constraints and assumptions:

- Max video size: 1 GB
- 5 million daily active users
- 5 videos watched per user per day = 25 million views/day
- 10% of users upload 1 video/day = 500,000 uploads/day
- Average raw video size: 300 MB

## 2. Back of the Envelope Estimation

- **Raw upload storage:** 500,000 videos/day × 300 MB = 150 TB/day.
- **After transcoding:** each video is transcoded to 360p, 480p, 720p, 1080p, and potentially 4K, multiplying storage ~3-4x. Realistic need: ~450–600 TB/day.
- **Streaming:** 25 million views/day ≈ 290 streams/second at peak. Bytes are served from CDN edges, so origin bandwidth is a fraction of the total.

## 3. High Level Architecture Overview

Two pipelines run in parallel, loosely coupled and communicating asynchronously through Kafka:

1. **Video pipeline:** upload, transcoding, delivery
2. **Metadata pipeline:** all structured data about videos

<<<SECTION 2>>>
## 4. Video Upload Flow

**Step 1: Presigned URL.** The client gets a presigned S3 URL from the API server and uploads the raw file directly to S3. Routing 1 GB through the API fleet wastes resources, adds latency, and bottlenecks; API servers stay on lightweight requests.

**Step 2: Trigger transcoding.** S3 fires an object creation event to a Kafka topic, consumed by transcoding workers. Async and decoupled: workers go at their own pace and spikes don't overwhelm the fleet.

**Step 3: Transcoding pipeline (DAG model).** Processing is modeled as a Directed Acyclic Graph with three streams:

- Video tasks: transcoding to multiple resolutions, watermarking, thumbnail generation, inspection
- Audio tasks: extraction and encoding
- Metadata tasks: parsing and storing video metadata

The video is first split into **Groups of Pictures (GoPs)**, short independently decodable chunks, for parallelism and resumability on failure.

Six components:

- **Preprocessor:** splits video into GoP chunks, generates the video's DAG, stores chunks in temporary fast storage (in-memory or fast cache).
- **DAG Scheduler:** breaks the DAG into discrete tasks and schedules them.
- **Resource Manager:** maintains task queues, worker queues, and running queues; the brain of the cluster, allocating tasks to available workers.
- **Task Workers:** execute assigned tasks.
- **Temporary Storage:** fast intermediate storage passing chunks between stages; discarded after processing.
- **Encoded Video Output:** final transcoded files in all target resolutions, pushed to origin storage for CDN distribution.

**Step 4: Completion.** The worker publishes a completion event to a Kafka topic instead of writing the DB; a completion handler updates the metadata DB and cache to mark the video available. Direct worker writes would mean tight coupling, harder retries, and thundering-herd risk on the DB at peak upload hours.

<<<SECTION 3>>>
## 5. Video Streaming Flow

**Protocol: HLS (HTTP Live Streaming)**, the dominant adaptive streaming protocol YouTube uses:

- Transcoded video is stored as small segments, typically 2–10 seconds.
- A manifest file (M3U8) indexes all chunks across all resolutions.
- The client downloads the manifest first, then fetches chunks sequentially during playback.
- The client never downloads the full file; it stays a few chunks ahead of the playback head.

### Adaptive Bitrate Streaming

The player watches bandwidth and buffer health (seconds pre-loaded) to pick each next chunk's resolution, switching among the manifest's per-resolution playlists. Entirely client-side.

### Streaming Hop by Hop

1. User hits play -> API server is called
2. API server fetches video metadata from cache (Redis) or DB -> returns CDN URL and manifest URL
3. Client fetches M3U8 manifest from CDN edge node
4. Client pulls video chunks from the CDN edge node
5. On a CDN cache miss, the edge fetches the chunk from origin and caches it
6. Player continuously adapts resolution based on bandwidth and buffer health

### Importance of CDN

Video is static (same bytes for all), ideal for CDN: cached at hundreds of edges, served millions of times without touching origin. Without it, a trending video causes a thundering herd on origin that horizontal scaling can't cheaply fix.

<<<SECTION 4>>>
## 6. Data Layer

**Metadata DB: DynamoDB.** Stores title, description, uploader ID, CDN URL, processing status, timestamps. The main access pattern is key-value lookup by video ID, which fits DynamoDB. Cassandra is an alternative for more geographically distributed deployments.

**Caching: Redis with LFU eviction.** Access is heavily skewed: a small fraction of videos get most views, so caching the top 20% by popularity yields a very high hit rate without caching the whole catalog.

LFU fits: a viral video with millions of views over three days should outlast one accessed once an hour ago; LRU would wrongly evict the popular one.

## 7. System Architecture Summary

{{IMG:1}}

<<<SECTION 5>>>
## 8. Key Design Decisions Summary

- **Raw file upload** -> Presigned S3 URL (avoids routing GBs through API servers)
- **Pipeline trigger** -> S3 event to Kafka (async, decoupled, scalable)
- **Transcoding model** -> DAG with GoP splitting (parallelism and fault tolerance)
- **Streaming protocol** -> HLS with adaptive bitrate (chunked delivery, client-side quality adaptation)
- **Content delivery** -> CDN (static content, massive cache hit rate)
- **Metadata store** -> DynamoDB (key-value access by video ID)
- **Cache eviction** -> LFU (frequency-skewed access pattern)
- **Inter-service communication** -> Kafka (decoupling, async, replay capability)
