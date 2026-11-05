# Design Netflix

<<<SECTION 1>>>
## High-Level Design: Netflix

## 1. Requirements

### Functional Requirements

- Content ingestion and transcoding pipeline (studio to streamable)
- Stream movies, series, and documentaries
- Search for content
- Watchlist management
- Continue watching (resume playback)
- Recommendation service
- Metrics and data aggregation
- Notifications (new content alerts, resume watching prompts)

### Out of Scope

- Live streaming
- Offline downloads (architecturally similar to streaming, just pre-fetched chunks)
- Billing and subscription management
- Content licensing and DRM internals
- Multi-profile management per account
- Studio collaboration tools

### Non-Functional Requirements

- Ultra-high availability, playback must never stop mid-stream
- Low latency playback initiation, first frame under 2 seconds
- Adaptive bitrate streaming, quality degrades gracefully under poor network conditions, never buffers
- No cold start on major releases, proactive cache warming before release day
- Petabyte-scale storage for 15,000 titles across 1200 variants each
- Eventual consistency acceptable for recommendations, watchlist, and metrics
- Strong consistency required for subscription entitlement and DRM licensing

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 100 million
- **Average watch time per user:** 150 minutes per day (roughly 3 episodes or 1 movie)
- **Total streaming minutes per day:** 100M x 150 mins = 15 billion minutes per day
- **Average streaming bitrate:** 10 Mbps across all quality levels
- **Total data served per day:** 15B mins x 60 secs x 10 Mbps / 8 = ~11 PB per day
- **Netflix library:** ~15,000 titles, average 90 minutes per title
- **Variants per title:** ~1200 (combinations of resolution, codec, HDR format, audio format)
- **Storage per variant per title:** 10 Mbps x 90 mins x 60 secs / 8 = ~6.75 GB
- **Storage per title:** 6.75 GB x 1200 variants = ~8 TB per title
- **Total library storage:** 8 TB x 15,000 titles = **~120 PB total**
- **Chunks per title per variant:** 90 mins x 6 chunks/min = ~540 chunks per variant
- **Total stored objects:** 540 x 1200 x 15,000 = **~9.7 billion objects in S3**

The dominant challenge is not write throughput as in Twitter or Amazon, but serving 11 PB of data per day to 100 million concurrent viewers with sub-2-second playback initiation and zero buffering. Netflix accounts for roughly 15% of global internet traffic during peak hours. This single fact drives the entire architecture toward edge-first content delivery via Open Connect.

<<<SECTION 3>>>
## 3. API Gateway

All client requests enter through the API Gateway which handles authentication, rate limiting, and routing. Unlike previous systems, the API Gateway in Netflix has an additional responsibility: **regional routing**. Netflix serves users across every continent and routes playback requests to the nearest streaming infrastructure cluster. Content licensing also varies by region, so the Gateway enforces geo-based access controls before any request reaches the Streaming Service.

The API Gateway never handles video chunk delivery. Chunks are served entirely by Open Connect Appliances with no backend API involvement in the hot path.

## 4. Content Ingestion and Transcoding Pipeline

This is the most complex transcoding pipeline across all seven systems we have designed. A single 2-hour movie arriving as a 100GB raw master file must become approximately 864,000 individual chunk files before a single user can stream it.

### Master File Delivery

Studios deliver raw master files to Netflix via AWS Direct Connect (dedicated high-bandwidth fiber links) or for very large files, physical hard drives shipped to Netflix data centers. The raw master is stored in S3 immediately on arrival as the permanent archive.

Transcoding Pipeline Stages

**Stage 1 - Preprocessor**  
The Preprocessor receives the raw master file and performs three tasks:

**GOP splitting (Group of Pictures):** The video is split into GOPs, each typically 2 seconds long. A GOP is a self-contained, independently encodable unit of video frames. A 2-hour movie produces roughly 3600 GOPs. This splitting is the key insight that enables massive parallelization. Each GOP can be encoded independently without knowledge of other GOPs.

**DAG generation:** The Preprocessor constructs a Directed Acyclic Graph of all encoding tasks. Each node in the DAG is a single GOP x Variant combination. A 2-hour movie produces 3600 GOPs x 1200 variants = **4.32 million encoding tasks** in the DAG.

**Audio and subtitle separation:** Audio tracks (stereo, 5.1, Dolby Atmos) and subtitle files are separated from the video stream and processed independently through their own encoding pipelines.

**Stage 2 - DAG Scheduler**  
The DAG Scheduler receives the task graph and splits it into individual tasks, placing them into a distributed Task Queue backed by Kafka. Tasks are prioritized intelligently. The first few GOPs of every variant are encoded first, ensuring the title can begin streaming before full encoding is complete. A user can start watching episode 1 of a new series while episodes 2 and 3 are still being encoded.

**Stage 3 - Resource Manager**  
The Resource Manager maintains three queues:

- **Task Queue:** all pending encoding tasks from the DAG Scheduler
- **Worker Queue:** all available encoding workers ready to accept tasks
- **Running Queue:** all currently executing tasks with their assigned workers

The Resource Manager matches tasks to available workers continuously, scaling the worker pool up or down based on queue depth. Netflix runs thousands of EC2 instances for transcoding during peak ingestion periods.

**Stage 4 - Task Workers**  
Each Task Worker picks up a single GOP x Variant task and encodes it independently. Workers are specialized by variant type:

- **Video encoding workers:** H.264, H.265, AV1 encoders running on GPU-accelerated instances
- **Audio encoding workers:** AAC stereo, Dolby Digital 5.1, Dolby Atmos encoders
- **Subtitle workers:** convert subtitle files into timed text formats for all supported languages

Encoding a single GOP into a single variant takes milliseconds on a GPU worker. With thousands of workers running in parallel, a 2-hour movie is fully encoded across all 1200 variants in hours rather than the weeks it would take sequentially.

**Stage 5 - Output and Storage**  
Encoded chunks are written to S3 under a deterministic path:

content/{content_id}/{variant_id}/chunk_{gop_index}.m4s

This deterministic naming means any service can construct the URL for any chunk of any variant without a database lookup.

**Stage 6 - Kafka Fanout on Completion**  
When all chunks for a title are encoded, the Transcoding Service publishes a content.transcoded event to Kafka. Three consumers pick this up:

- **Metadata Worker** writes content metadata to the Content DB and Redis cache
- **Search Indexing Worker** indexes the title into Elasticsearch
- **MPD Generation Worker** generates the DASH manifest files for all device profiles and stores them in S3

### Variants Produced

Netflix encodes each title into approximately 1200 variants covering:

- **Resolutions:** 360p, 480p, 720p, 1080p, 4K
- **Codecs:** H.264 (widest device compatibility), H.265/HEVC (50% better compression than H.264), AV1 (Netflix's preferred codec, 30% better than H.265 but slower to encode)
- **HDR formats:** SDR (standard), HDR10, Dolby Vision
- **Audio formats:** AAC stereo, Dolby Digital 5.1, Dolby Atmos
- **Languages:** multiple audio tracks and subtitle tracks per title

### Bottlenecks in the Transcoding Pipeline

The encoding step itself is the bottleneck. AV1 encoding is significantly slower than H.264 or H.265 and requires more GPU time per GOP. Netflix mitigates this by running AV1 encoding at lower priority than H.264. A title becomes streamable in H.264 within hours of ingestion, and AV1 variants are completed in the background over the following days.

<<<SECTION 4>>>
## 5. Open Connect - Netflix's Custom CDN

Netflix does not primarily use third-party CDNs like CloudFront or Akamai for video chunk delivery. Instead, Netflix built its own CDN called **Open Connect**, consisting of thousands of **Open Connect Appliances (OCAs)**, Netflix-owned physical servers installed directly inside ISP data centers and internet exchange points globally.

How Open Connect Differs from a Standard CDN

### Standard CDN (CloudFront/Akamai):

- Cache fill happens reactively on first user request (cache miss -> origin -> cache fill -> serve)
- Traffic traverses the public internet between CDN edge nodes and the ISP
- Netflix has no control over what gets cached where or when

### Open Connect:

- Netflix proactively pushes content to OCAs every night during off-peak hours based on predicted regional popularity. Popular content is already sitting on the OCA before any user requests it.
- Traffic flows directly from the OCA inside the ISP network to the user's home router, never touching the public internet
- Netflix controls exactly what content sits on each appliance based on granular regional viewing data
- ISPs benefit because traffic stays within their network, reducing their transit costs

### Content Placement Strategy

Netflix's Content Placement Algorithm decides nightly which titles to push to which OCAs based on:

- Regional viewing history (what does this ISP's userbase watch most?)
- Upcoming release schedule (new episodes of popular shows are pre-positioned before release)
- Available storage per OCA (OCAs have finite SSD storage, typically 100-200 TB)
- Title popularity decay (older content that is no longer trending is evicted to make room)

### Proactive Cache Warming for New Releases

When Stranger Things Season 5 is scheduled to release on Friday, Netflix begins pushing all episode chunks to OCAs globally on Wednesday night. By Friday morning, every major OCA worldwide already has the content cached. When millions of users simultaneously hit play on Friday evening, every request is a cache hit. There is no cold start, no cache fill storm, no thundering herd.

For long-tail content (obscure documentaries, foreign language titles with small regional audiences) that does not justify OCA storage, Netflix falls back to a traditional CDN or serves directly from S3 origin.

### Bottlenecks in Open Connect

OCA storage capacity is finite. Not all 120 PB of Netflix's library can sit on OCAs, only the popular subset. The Content Placement Algorithm must continuously optimize what to cache where. OCAs that fill up must evict less popular content to make room for upcoming releases, and this eviction strategy directly affects cache hit rates and streaming quality for users of that ISP.

<<<SECTION 5>>>
## 6. Streaming Service

The Streaming Service manages playback sessions, authenticates users, generates signed URLs, selects appropriate variants, and tracks playback position for resume functionality.

### Full Playback Initiation Flow

**Step 1 - Play Request**  
User hits play. Client sends POST /playback/start with { user_id, content_id, device_type, supported_codecs, screen_resolution, audio_capabilities } to the Streaming Service via API Gateway.

**Step 2 - Parallel Entitlement Checks**  
Three checks run simultaneously:

- Is the user's subscription active? (User Profile Service -> Redis cache)
- Is this title licensed for the user's region? (Content licensing DB)
- Is the user's device DRM-certified? (Widevine for Android/Chrome, FairPlay for iOS/Safari, PlayReady for Windows)

If any check fails, playback is rejected immediately.

**Step 3 - Variant Selection**  
Based on the client's reported capabilities, the Streaming Service selects the appropriate variant set:

- A 2015 Android phone gets H.264 variants only, capped at 1080p
- A 4K TV with Dolby Vision support gets the full variant set including AV1 and HDR
- A browser on a Mac gets H.264 or H.265 depending on browser support

**Step 4 - Personalized MPD Manifest Generation**  
The Streaming Service generates a personalized MPEG-DASH MPD (Media Presentation Description) manifest for this specific user and device. The MPD contains:

- All available variant representations with their bitrates and resolutions
- Signed chunk URL patterns with short TTLs tied to the user's session
- Chunk duration and sequence information
- Audio track and subtitle track options

The MPD is signed per session. Chunk URLs embedded in the MPD are also signed with a TTL of a few hours. A user who cancels their subscription cannot use an old MPD to continue streaming.

**Step 5 - DRM License Issuance**  
Simultaneously, the Streaming Service calls the DRM License Service which issues a decryption key tied to the user's authenticated session. All chunks stored in S3 and OCAs are encrypted. The client holds the MPD and signed URLs but cannot decrypt the chunks without the DRM license. This is the core content protection mechanism.

### Step 6 - Playback Session Created

PlaybackSessions  
session_id        UUID, primary key  
user_id           UUID, foreign key -> Users  
content_id        UUID, foreign key -> Content  
device_id         UUID  
started_at        TIMESTAMP  
last_chunk_index  INTEGER  
last_position_ms  BIGINT  
quality_selected  VARCHAR  
updated_at        TIMESTAMP

last_chunk_index and last_position_ms are updated by the client every 30 seconds. This is what powers Continue Watching. On next play, the Streaming Service reads this record and generates an MPD starting from the last known position.

**Step 7 - ABR Algorithm Takes Over**  
The client receives the MPD and begins fetching chunks from the nearest OCA. The ABR (Adaptive Bitrate) algorithm running on the client makes all quality decisions:

- Starts at a conservative mid-quality variant
- Measures download speed of each chunk
- Monitors buffer health (seconds of video buffered ahead)
- Switches to higher variants as bandwidth allows, lower variants as bandwidth degrades
- Switches are seamless, the next chunk comes from a different variant URL, no playback interruption

Total time from hitting play to first frame: under 2 seconds on a good connection.

### Bottlenecks in the Streaming Service

The Streaming Service is stateless and horizontally scalable. The MPD generation step is the most compute-intensive part of session initiation since it generates personalized signed URLs for potentially thousands of chunks. This is mitigated by caching base MPD templates per device profile and only personalizing the signing step, rather than regenerating the full manifest from scratch for every session.

<<<SECTION 6>>>
## 7. Content Delivery - MPEG-DASH and ABR

### MPEG-DASH vs HLS

Netflix uses MPEG-DASH (Dynamic Adaptive Streaming over HTTP) rather than HLS. The key differences:

- **HLS** uses .m3u8 playlist files and .ts segments, developed by Apple, natively supported on iOS and Safari
- **DASH** uses .mpd manifest files and .m4s segments (fragmented MP4), codec-agnostic and more flexible for Netflix's multi-codec strategy

Netflix actually uses **CMAF (Common Media Application Format)** chunks that are compatible with both DASH and HLS clients, allowing a single set of encoded chunks to serve all device types. The manifest format differs per client but the underlying chunk files are shared.

MPD Structure

```xml
<MPD type="static" mediaPresentationDuration="PT2H">
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="avc1">
      <Representation id="v1" bandwidth="800000" width="640" height="360">
        <SegmentTemplate media="video_360p_$Number$.m4s" duration="2"/>
      </Representation>
      <Representation id="v2" bandwidth="3000000" width="1280" height="720">
        <SegmentTemplate media="video_720p_$Number$.m4s" duration="2"/>
      </Representation>
      <Representation id="v3" bandwidth="16000000" width="3840" height="2160">
        <SegmentTemplate media="video_4k_$Number$.m4s" duration="2"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a1" bandwidth="128000" audioSamplingRate="48000">
        <SegmentTemplate media="audio_aac_$Number$.m4s" duration="2"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
```

The ABR algorithm on the client reads this manifest and dynamically selects which Representation to request for each segment based on current network conditions and buffer state.

<<<SECTION 7>>>
## 8. User Profile Service

Manages all user data including authentication credentials, subscription status, viewing history, watchlist, and playback sessions.

### Data Model

### Users Table (PostgreSQL)

Users  
user_id           UUID, primary key  
email             VARCHAR, unique  
name              VARCHAR  
profile_pic_url   TEXT  
subscription_tier ENUM('standard', 'premium', '4k')  
subscription_end  TIMESTAMP  
created_at        TIMESTAMP

### Watchlist Table (PostgreSQL)

Watchlist  
user_id       UUID, foreign key -> Users  
content_id    UUID, foreign key -> Content  
added_at      TIMESTAMP  
PRIMARY KEY (user_id, content_id)

Simple key-based access. "Give me all watchlist items for user X" is WHERE user_id = X ORDER BY added_at DESC. Cached in Redis per user with a short TTL since watchlist changes are infrequent.

### WatchHistory Table (PostgreSQL)

WatchHistory  
user_id         UUID, foreign key -> Users  
content_id      UUID, foreign key -> Content  
watched_at      TIMESTAMP  
completion_pct  FLOAT  
episode_id      UUID (null for movies)

Watch history is append-only and high write volume. Every completed viewing session writes a record. This table is also the primary input for the Recommendation Service. Partitioned by user_id for fast per-user history fetches.

### Bottlenecks in the User Profile Service

Subscription status checks happen on every playback initiation. Redis caches subscription status per user with a TTL of a few minutes, frequent enough to catch cancellations promptly, infrequent enough to avoid hammering PostgreSQL. Watch history writes are high volume and are batched via Kafka consumers rather than written synchronously per session event.

<<<SECTION 8>>>
## 9. Metrics and Data Aggregation Service

Netflix collects a massive stream of playback events from every client. Every play, pause, seek, quality switch, buffer event, error, and completion generates an event. At 100M DAU watching 150 minutes each, the event volume is enormous.

Event Types Collected

- **Playback events:** play, pause, resume, seek, completion, abandonment
- **Quality events:** ABR quality switches, buffer underruns, startup time
- **Error events:** playback failures, DRM errors, network timeouts
- **Engagement events:** watchlist additions, search queries, recommendation clicks
- **Device events:** device type, OS version, app version, network type

### Ingestion Architecture

All client events are published to **Kafka** in real time. Kafka topics are partitioned by event type and user ID to enable parallel processing.

Two separate consumer pipelines process the event stream:

**Real-time Pipeline (Apache Flink)**  
Processes events within seconds for:

- Live operations dashboards (buffering ratios per region, error rates per device type, CDN cache hit rates)
- Anomaly detection (sudden spike in buffering events in Mumbai = OCA issue in that ISP)
- A/B test metrics (is the new ABR algorithm reducing startup time?)
- Real-time personalization signals (user just finished an episode -> trigger next episode notification)

Results land in Redis for live dashboard consumption and operational alerting.

**Batch Pipeline (Apache Spark)**  
Processes events in hourly and daily batches for:

- Recommendation model training data
- Content acquisition decisions ("which genres are growing fastest in Southeast Asia?")
- Business analytics (episode completion rates, drop-off points within episodes, binge patterns)
- OCA content placement optimization (which titles are most watched per ISP region?)

Results land in a **data lake on S3** in Parquet format for long-term storage and ML model training.

### Per-User Aggregations for Recommendations

The Metrics Service maintains per-user aggregated signals in Redis:

Key: user_signals:{user_id}  
Value: {  
  genres_watched: {drama: 45, thriller: 30, comedy: 15, ...},  
  avg_session_duration: 87,  
  preferred_watch_time: "evening",  
  completion_rate: 0.78,  
  recently_watched: \[content_id_1, content_id_2, ...\]  
}

These aggregations are updated by Flink consumers in near real time and consumed by the Recommendation Service.

### Per-Content Aggregations

Key: content_signals:{content_id}  
Value: {  
  total_watches: 4500000,  
  completion_rate: 0.82,  
  avg_rating: 4.3,  
  rewatch_rate: 0.12,  
  watchlist_adds: 890000  
}

High completion rate and rewatch rate are strong signals that a title should be recommended more aggressively and prioritized for OCA placement.

### Bottlenecks in the Metrics Service

Kafka ingestion is not a bottleneck since Kafka is designed for exactly this scale. The Flink real-time pipeline is the operational concern since it must process millions of events per second with low latency. The Spark batch pipeline runs on a schedule and its latency is acceptable for the use cases it serves.

<<<SECTION 9>>>
## 10. Recommendation Service

The Recommendation Service produces a personalized ranked list of titles for each user. Serving recommendations must be fast since they appear on the Netflix home screen the moment the app opens.

Two-Stage Architecture

**Stage 1 - Candidate Generation**  
From 15,000 titles, narrow down to ~500 candidates relevant to this user using:

- **Collaborative filtering:** users who watched the same titles as this user also watched Y -> Y is a candidate
- **Content-based filtering:** user watches a lot of crime thrillers -> other crime thrillers are candidates
- **Popularity signals:** trending titles in the user's region are always candidates

This stage runs as a batch job periodically (every few hours) and produces a candidate set per user stored in Redis.

**Stage 2 - Neural Ranking**  
The 500 candidates are ranked by a neural ranking model that incorporates:

- User's genre preferences from the Metrics Service
- Time of day (users watch different content on weekday evenings vs weekend afternoons)
- Device type (phone users prefer shorter content)
- Content freshness (new releases get a ranking boost)
- Social signals (titles popular among users with similar taste profiles)

Top 20 ranked recommendations are written to Redis per user:

Key: recommendations:{user_id}  
Value: \[content_id_1, content_id_2, ..., content_id_20\]  
TTL: 6 hours

Serving a recommendation is a single Redis GET. The entire ML pipeline complexity is hidden behind this one cache read.

The recommendation pipeline runs on a schedule, typically every 6 hours for most users, more frequently for highly active users. The Kafka event stream from the Metrics Service triggers immediate recommendation refresh when a user completes a title (high signal event) rather than waiting for the next scheduled run.

### Bottlenecks in the Recommendation Service

The neural ranking model running on 15,000 candidates per user is computationally expensive. Running it for 100 million users simultaneously is not feasible. This is handled by staggering computation. Not all users need fresh recommendations at the same time. Users who are currently watching do not need their home screen recommendations updated. The pipeline prioritizes users who are about to open the app based on historical usage patterns.

<<<SECTION 10>>>
## 11. Search Service

Netflix search covers content titles, genres, cast members, directors, and descriptive terms like "feel good movies" or "based on true story".

Storage Engine - Elasticsearch

Elasticsearch handles full-text search and relevance ranking across 15,000 content documents. The catalog is small compared to Amazon's 350 million products, so Elasticsearch cluster requirements are modest.

### Content document:

```json
{
  "content_id": "123",
  "title": "Stranger Things",
  "type": "series",
  "genres": ["sci-fi", "horror", "drama"],
  "cast": ["Millie Bobby Brown", "Finn Wolfhard"],
  "director": ["The Duffer Brothers"],
  "description": "When a young boy disappears...",
  "maturity_rating": "TV-14",
  "release_year": 2016,
  "total_watches": 4500000,
  "completion_rate": 0.82,
  "available_regions": ["US", "IN", "GB"]
}
```

### Ranking Signals

Netflix search ranking combines text relevance with:

- **Popularity:** total watch count and completion rate
- **Personalization:** titles in genres the user watches frequently rank higher
- **Regional availability:** titles not available in the user's region are excluded entirely
- **Recency:** new releases get a ranking boost for broad queries

### Keeping Elasticsearch in Sync

The Search Indexing Worker consumes from the content.transcoded Kafka topic for new titles and from content.updated topics for metadata changes. Popularity signals (watch counts, completion rates) are synced from the Metrics Service batch pipeline periodically rather than in real time.

<<<SECTION 11>>>
## 12. Notification Service

Same architecture as all previous systems. Kafka fanout from upstream services, APNs for iOS, FCM for Android, email via SES.

The Notification Service subscribes to:

- content.released -> "New episodes of Stranger Things are available" push notification
- session.completed -> "You finished Episode 3. Episode 4 is ready" prompt
- watchlist.available -> "A title on your watchlist just dropped in your region"
- recommendation.refresh -> periodic "We think you will love this" notifications for re-engagement

Netflix notifications are carefully throttled. Too many notifications causes app uninstalls. The Notification Service applies per-user frequency capping. No user receives more than one promotional notification per day regardless of how many triggers fire.

## 13. Full Data Flow Summary

**Content Ingestion Flow:**  
Studio -> AWS Direct Connect / Physical Drive -> S3 (raw master)  
S3 -> Preprocessor (GOP splitting, DAG generation, audio separation)  
DAG Scheduler -> Task Queue (Kafka)  
Resource Manager -> Task Workers (thousands of GPU EC2 instances)  
Task Workers -> S3 (encoded chunks per variant per GOP)  
All chunks complete -> Kafka (content.transcoded)  
    -> Metadata Worker        -> Content DB + Redis Cache  
    -> Search Indexing Worker -> Elasticsearch  
    -> MPD Generation Worker  -> S3 (manifest files per device profile)  
Open Connect nightly job -> pull popular content from S3 -> OCA storage in ISPs  
  
**Playback Initiation Flow:**  
User hits play -> API Gateway -> Streaming Service  
    -> User Profile Service (subscription check) \[parallel\]  
    -> Content Licensing DB (region check) \[parallel\]  
    -> DRM Service (device certification check) \[parallel\]  
-> Variant selection based on device capabilities  
-> Personalized MPD manifest generated with signed chunk URLs  
-> DRM license issued  
-> PlaybackSession record created in PostgreSQL  
-> MPD returned to client  
  
**Chunk Delivery Flow:**  
Client ABR algorithm reads MPD  
Client requests chunk -> Open Connect Appliance in user's ISP (cache hit ~95%)  
OCA cache miss -> Netflix CDN / S3 origin -> OCA caches -> serves chunk  
ABR switches quality variant based on bandwidth measurement per chunk  
  
**Metrics Ingestion Flow:**  
Client events (play, pause, buffer, quality switch) -> Kafka  
    -> Apache Flink (real-time) -> Redis (live dashboards, anomaly detection)  
    -> Apache Spark (batch)     -> S3 data lake (ML training, business analytics)  
    -> Per-user signal aggregations -> Redis (recommendation inputs)  
  
**Recommendation Flow:**  
Metrics Service -> Kafka -> Recommendation Pipeline  
Stage 1 (candidate generation, batch every 6 hours)  
    -> Collaborative filtering + content-based filtering -> 500 candidates per user  
Stage 2 (neural ranking)  
    -> Rank 500 candidates using user signals from Redis  
    -> Top 20 results -> Redis recommendations:{user_id} with 6hr TTL  
Client opens app -> GET recommendations:{user_id} -> single Redis read  
  
**Search Flow:**  
Client searches "crime thriller" -> Search Service  
    -> Redis (hot query cache)  
    -> Elasticsearch (personalized ranking by user genre preferences + popularity)  
    -> Redis MGET (hydrate content metadata for results)  
  
**Continue Watching Flow:**  
Client sends heartbeat every 30s -> Streaming Service  
    -> UPDATE PlaybackSessions SET last_position_ms = X WHERE session_id = Y  
User returns -> Streaming Service reads PlaybackSessions  
    -> Generate MPD starting from last_chunk_index  
    -> Playback resumes from exact position

<<<SECTION 12>>>
## 14. Resilience and Fault Tolerance

**Open Connect multi-OCA redundancy** means that if one OCA in an ISP goes down, requests fall back to the next nearest OCA or Netflix's CDN fallback. Users may experience a brief quality drop but playback never stops.

**Proactive cache warming** eliminates the cold start problem for all major releases. The thundering herd on release day is absorbed entirely by OCA cache hits, never reaching S3 origin.

**ABR algorithm client-side resilience** means the streaming client adapts to degraded network conditions automatically and continuously without any server involvement. Quality degrades gracefully but playback never buffers unless connectivity drops to zero.

**Kafka durability** in the transcoding pipeline means a worker crash does not lose work. Tasks are requeued from Kafka and picked up by another worker. The DAG Scheduler tracks completed tasks and only requeues incomplete ones.

**DAG-based transcoding parallelization** means a single worker failure affects only the GOP x Variant tasks it was processing. All other tasks continue unaffected. The Resource Manager detects the failed worker, releases its tasks back to the Task Queue, and assigns them to healthy workers.

**Playback session persistence in PostgreSQL** ensures Continue Watching survives app crashes, device switches, and backend restarts. The last known position is always durable.

**Two-stage recommendation pipeline** means a failure in the neural ranking stage falls back to the candidate generation results rather than showing no recommendations. A degraded recommendation is better than an empty home screen.

**Redis caching at every read layer** (subscription status, content metadata, recommendations, watchlist) means most read paths never touch PostgreSQL in the happy path. PostgreSQL failures degrade the experience gradually rather than causing complete outages.

**Metrics pipeline independence** means a Flink or Spark pipeline failure does not affect streaming, search, or any user-facing service. Metrics are collected for operational insight but are not on the critical path for playback.

<<<SECTION 13>>>
## 15. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, regional routing, geo-based access control)

**Master File Storage** -> AWS S3 (Raw studio masters, permanent archive, source for transcoding)

**Transcoding Compute** -> GPU-accelerated EC2 instances via DAG Scheduler + Kafka Task Queue (Parallel GOP x Variant encoding across thousands of workers)

**Encoded Chunk Storage** -> AWS S3 (864,000 objects per title, deterministic URL structure)

**Content Delivery** -> Netflix Open Connect Appliances in ISP data centers (Proactive cache warming, zero public internet traversal for popular content)

**Streaming Protocol** -> MPEG-DASH with CMAF chunks (Adaptive bitrate, multi-codec, compatible with HLS and DASH clients)

**DRM** -> Widevine + FairPlay + PlayReady (Per-session decryption keys, device-bound licensing)

**Content DB** -> PostgreSQL sharded + replicas (Title metadata, licensing, regional availability)

**User Profile DB** -> PostgreSQL (Subscription status, watch history, watchlist, playback sessions)

**Playback Session Store** -> PostgreSQL + Redis cache (Continue watching, resume position, subscription entitlement cache)

**Search Engine** -> Elasticsearch (Full-text search, personalized ranking, genre and cast indexing)

**Recommendation Store** -> Redis (Precomputed top 20 per user, single GET at home screen load)

**Real-time Metrics Pipeline** -> Apache Kafka + Apache Flink (Sub-second event processing, live dashboards, anomaly detection)

**Batch Metrics Pipeline** -> Apache Spark + S3 data lake (ML training data, business analytics, OCA placement optimization)

**User Signal Cache** -> Redis (Per-user genre preferences, completion rates, watch patterns for ranking)

**Notification Delivery** -> APNs + FCM + AWS SES (Push notifications and email with per-user frequency capping)

That's all, folks...Cheers!!
