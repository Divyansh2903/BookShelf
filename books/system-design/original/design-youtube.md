# Design Youtube

<<<SECTION 1>>>
## Problem Scope

We focus on two core flows: **video uploading and video streaming**. Auth and social features like comments, likes, and subscriptions are out of scope.

### Constraints and assumptions:

- Max video size: 1 GB
- 5 million daily active users
- Each user watches 5 videos per day == 25 million video views per day
- 10% of users upload 1 video per day == 500,000 video uploads per day
- Average raw video size: 300 MB

## 2. Back of the Envelope Estimation

**Raw upload storage:** 500,000 videos/day × 300 MB = 150 TB/day of raw video ingested

**Actual storage after transcoding:** Each video gets transcoded into multiple resolutions: 360p, 480p, 720p, 1080p, and potentially 4K. This multiplies storage by roughly 3-4x.

Realistic storage requirement: ~450–600 TB/day

**Streaming:** 25 million views/day means roughly 290 video streams per second at peak. Video bytes are served from CDN edge nodes, not origin servers, so origin bandwidth requirements are a fraction of total delivery bandwidth.

## 3. High Level Architecture Overview

The system has two major pipelines running in parallel:

1. **Video pipeline:** handles upload, transcoding, and delivery
1. **Metadata pipeline:** handles all structured data about videos

These two pipelines are loosely coupled and communicate asynchronously through Kafka.

<<<SECTION 2>>>
## 4. Video Upload Flow

### Step 1: Presigned URL Generation

When a user selects a video and hits upload, the client does not send video bytes to the API server. Instead, the client requests a presigned S3 URL from the API server. The API server generates this URL and returns it. The client then uploads the raw video file directly to S3 using that URL.

This is critical. Routing a 1 GB file through your API server fleet is wasteful, introduces unnecessary latency, and creates a bottleneck. Direct-to-S3 upload keeps API servers doing what they are good at, i.e. handling lightweight requests.

### Step 2: Triggering the Transcoding Pipeline

Once the raw video lands in S3, S3 fires an object creation event. This event is published to a Kafka topic. Transcoding workers consume from this topic and begin processing the video. This keeps the pipeline fully asynchronous and decoupled, workers process at their own pace and the system handles traffic spikes gracefully without overwhelming the transcoding fleet.

### Step 3: Transcoding Pipeline (DAG Model)

Video processing is modeled as a Directed Acyclic Graph (DAG).

The DAG separates processing into three streams:

- Video tasks: transcoding into multiple resolutions, watermarking, thumbnail generation, inspection
- Audio tasks: extraction and encoding
- Metadata tasks: parsing and storing video metadata

The video file is first split into Groups of Pictures (GoPs), short, independently decodable chunks. This enables two things: parallelism across workers and resumability on failure.

### The pipeline has six components:

**Preprocessor:** It splits the video into GoP chunks, generates the DAG for that video, and stores chunks in temporary fast storage (in-memory or a fast cache layer) for use during processing.

**DAG Scheduler:** It takes the generated DAG and breaks it into discrete tasks, scheduling them for execution.

**Resource Manager:** It maintains task queues, worker queues, and running queues. Acts as the brain of the processing cluster, allocating tasks to available workers.

**Task Workers:** They execute the assigned tasks.

**Temporary Storage:** Fast intermediate storage used to pass chunks between pipeline stages. Discarded once processing is complete.

**Encoded Video Output:** Final transcoded files in all target resolutions, pushed to origin storage for CDN distribution.

### Step 4: Completion and Metadata Update

When transcoding completes, the worker does not write directly to the metadata database. Instead, it publishes a completion event to a Kafka completion topic. A completion handler service consumes this event and updates the metadata database and cache to mark the video as available for streaming.

This decoupling is intentional. Direct DB writes from workers would create tight coupling, make retries harder, and risk thundering herd on the database during peak upload hours.

<<<SECTION 3>>>
## 5. Video Streaming Flow

Streaming Protocol: HLS

YouTube uses adaptive streaming protocols. HLS (HTTP Live Streaming) is the dominant one. Here is how it works:

- The transcoded video is stored as small segments, typically 2–10 seconds each
- A manifest file (M3U8) is generated, acting as an index of all chunks across all available resolutions
- The client downloads the manifest first, then fetches chunks sequentially as playback progresses
- The client never downloads the full file, it stays a few chunks ahead of the playback head

### Adaptive Bitrate Streaming

The video player continuously monitors two signals: available network bandwidth and buffer health (how many seconds of video are pre-loaded). Based on these signals, the player autonomously decides which resolution to request for the next chunk.

The M3U8 manifest supports this by containing multiple playlists, one per resolution. When conditions change, the player simply switches which playlist it pulls chunks from. No server-side event is needed. this is entirely client-side logic.

### Streaming Hop by Hop

1. User hits play -> API server is called
1. API server fetches video metadata from cache (Redis) or DB -> returns CDN URL and manifest URL
1. Client fetches M3U8 manifest from CDN edge node
1. Client begins pulling video chunks from the CDN edge node
1. On a CDN cache miss, the edge node fetches the chunk from origin storage and caches it for subsequent requests
1. Player continuously adapts resolution based on bandwidth and buffer health

### Importance of CDN (Content Delivery Network)

Video files are static content, the same bytes served to every viewer. This makes them perfect CDN candidates. A popular video uploaded once can be cached at hundreds of edge nodes globally and served millions of times without touching origin servers. Without CDN, a trending video would cause a thundering herd on origin servers, a problem no amount of horizontal scaling alone can cheaply solve.

<<<SECTION 4>>>
## 6. Data Layer

Metadata Database: DynamoDB

Video metadata (title, description, uploader ID, CDN URL, processing status, timestamps) is stored in DynamoDB. The primary access pattern is a simple key-value lookup by video ID, which maps cleanly to DynamoDB's model. For more geographically distributed deployments, Cassandra is an alternative worth considering.

Caching: Redis with LFU Eviction

Hot video metadata is cached in Redis. YouTube's access pattern is heavily skewed. A small fraction of videos receive the vast majority of views. Caching the top 20% of videos by popularity yields a very high cache hit rate without needing to cache the entire catalog.

LFU (Least Frequently Used) is the right eviction policy here. A viral video that has been receiving millions of views for three days should stay in cache over a video accessed once an hour ago. LRU (Least Recently Used) would wrongly evict the popular video in favor of the recently accessed one. LFU correctly captures the frequency-based nature of YouTube's traffic.

## 7. System Architecture Summary

{{IMG:1}}

<<<SECTION 5>>>
## 8. Key Design Decisions Summary

**Raw file upload** -> Presigned S3 URL (Avoids routing GBs through API servers)

**Pipeline trigger** -> S3 event to Kafka (Async, decoupled, scalable)

**Transcoding model** -> DAG with GoP splitting (Parallelism and fault tolerance)

**Streaming protocol** -> HLS with adaptive bitrate (Chunked delivery, client-side quality adaptation)

**Content delivery** -> CDN (Static content, massive cache hit rate)

**Metadata store** -> DynamoDB (Key-value access pattern by video ID)

**Cache eviction** -> LFU Frequency (skewed access pattern)

**Inter-service communication** ->Kafka (Decoupling, async, replay capability)

That's all, folks....Cheers!!
