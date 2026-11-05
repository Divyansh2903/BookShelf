# Design Netflix

<<<SECTION 1>>>
## High-Level Design: Netflix

## 1. Requirements

**Functional:**
- Content ingestion and transcoding (studio to streamable)
- Stream movies, series, documentaries
- Search
- Watchlist
- Continue watching (resume)
- Recommendations
- Metrics and data aggregation
- Notifications (new content, resume prompts)

**Out of scope:** live streaming; offline downloads (similar to streaming, just pre-fetched chunks); billing and subscriptions; licensing and DRM internals; multi-profile per account; studio collaboration tools.

**Non-functional:**
- Ultra-high availability; playback never stops mid-stream
- First frame under 2 seconds
- Adaptive bitrate: quality degrades gracefully on poor networks, never buffers
- No cold start on major releases: proactive cache warming before release day
- Petabyte-scale storage: 15,000 titles x 1200 variants each
- Eventual consistency OK for recommendations, watchlist, metrics
- Strong consistency for subscription entitlement and DRM licensing

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 100M, averaging 150 min/day (~3 episodes or 1 movie)
- **Streaming minutes/day:** 15 billion
- **Average bitrate:** 10 Mbps across quality levels
- **Data served/day:** 15B min x 60 s x 10 Mbps / 8 = ~11 PB
- **Library:** ~15,000 titles, 90 min average
- **Variants per title:** ~1200 (resolution, codec, HDR format, audio format)
- **Per variant:** 10 Mbps x 90 min x 60 s / 8 = ~6.75 GB; **per title** ~8 TB
- **Total library:** 8 TB x 15,000 = **~120 PB**
- **Chunks per variant:** 90 min x 6/min = ~540
- **Stored objects:** 540 x 1200 x 15,000 = **~9.7 billion in S3**

Unlike Twitter or Amazon, the challenge isn't write throughput but serving 11 PB/day to 100M concurrent viewers with sub-2-second start and zero buffering. Netflix is ~15% of global internet traffic at peak, which drives the architecture toward edge-first delivery via Open Connect.

<<<SECTION 3>>>
## 3. API Gateway

The API Gateway handles authentication, rate limiting, and routing, plus **regional routing**: playback requests go to the nearest streaming cluster, and since licensing varies by region, it enforces geo-based access control before requests reach the Streaming Service. It never delivers video chunks; Open Connect Appliances serve those with no backend API on the hot path.

## 4. Content Ingestion and Transcoding Pipeline

The most complex transcoding pipeline in the series: a 2-hour movie arriving as a 100GB raw master must become ~864,000 chunk files before anyone can stream it.

**Master file delivery.** Studios deliver via AWS Direct Connect (dedicated high-bandwidth fiber) or, for very large files, shipped physical drives. The raw master goes to S3 on arrival as the permanent archive.

**Stage 1 - Preprocessor:**
- **GOP splitting:** the video is split into Groups of Pictures, typically 2 seconds each, self-contained and independently encodable. A 2-hour movie gives ~3600 GOPs. This is what enables massive parallelization.
- **DAG generation:** a Directed Acyclic Graph of encoding tasks, one node per GOP x Variant: 3600 x 1200 = **4.32 million tasks**.
- **Audio and subtitle separation:** audio (stereo, 5.1, Dolby Atmos) and subtitles go through their own pipelines.

**Stage 2 - DAG Scheduler:** splits the graph into tasks on a Kafka-backed distributed Task Queue, prioritizing the first few GOPs of every variant so a title can stream before encoding finishes (watch episode 1 while episodes 2 and 3 are still encoding).

**Stage 3 - Resource Manager** keeps three queues:
- **Task Queue:** pending tasks
- **Worker Queue:** available workers
- **Running Queue:** executing tasks and their workers

It continuously matches tasks to workers and scales the pool by queue depth; Netflix runs thousands of EC2 instances at peak ingestion.

**Stage 4 - Task Workers** each encode one GOP x Variant, specialized by type:
- **Video:** H.264, H.265, AV1 on GPU-accelerated instances
- **Audio:** AAC stereo, Dolby Digital 5.1, Dolby Atmos
- **Subtitles:** timed text formats for all supported languages

One GOP into one variant takes milliseconds on a GPU; thousands of parallel workers finish all 1200 variants of a 2-hour movie in hours instead of weeks.

**Stage 5 - Output:** chunks go to S3 at a deterministic path, so any service can build any chunk URL without a DB lookup:

`content/{content_id}/{variant_id}/chunk_{gop_index}.m4s`

**Stage 6 - Kafka fanout:** when all chunks are done, content.transcoded is published. Consumers:
- **Metadata Worker** → Content DB and Redis
- **Search Indexing Worker** → Elasticsearch
- **MPD Generation Worker** → DASH manifests for all device profiles, stored in S3

### Variants Produced (~1200)

- **Resolutions:** 360p, 480p, 720p, 1080p, 4K
- **Codecs:** H.264 (widest compatibility), H.265/HEVC (50% better compression than H.264), AV1 (preferred; 30% better than H.265 but slower to encode)
- **HDR:** SDR, HDR10, Dolby Vision
- **Audio:** AAC stereo, Dolby Digital 5.1, Dolby Atmos
- **Languages:** multiple audio and subtitle tracks

### Bottlenecks

Encoding is the bottleneck, especially AV1, which needs more GPU time per GOP. AV1 runs at lower priority than H.264: a title is streamable in H.264 within hours, and AV1 variants complete in the background over following days.

<<<SECTION 4>>>
## 5. Open Connect - Netflix's Custom CDN

Instead of mainly using CloudFront or Akamai for chunks, Netflix built **Open Connect**: thousands of Netflix-owned **Open Connect Appliances (OCAs)** installed inside ISP data centers and internet exchange points.

**Standard CDN (CloudFront/Akamai):**
- Reactive cache fill on first request (miss -> origin -> fill -> serve)
- Traffic crosses the public internet between CDN edge and ISP
- Netflix can't control what is cached where or when

**Open Connect:**
- Content is pushed to OCAs nightly in off-peak hours based on predicted regional popularity, so popular content is there before anyone requests it
- Traffic flows from the OCA inside the ISP to the user's router, never touching the public internet
- Netflix controls each appliance's content using granular regional viewing data
- ISPs save transit costs since traffic stays in their network

### Content Placement Strategy

The nightly Content Placement Algorithm decides what goes where based on:
- Regional viewing history (what this ISP's users watch most)
- Release schedule (new episodes of popular shows pre-positioned)
- OCA storage (finite SSD, typically 100-200 TB)
- Popularity decay (non-trending older content evicted)

### Proactive Cache Warming for New Releases

For a Friday release of Stranger Things Season 5, Netflix starts pushing all episode chunks to OCAs globally on Wednesday night. By Friday morning every major OCA has it, so when millions press play Friday evening every request is a cache hit: no cold start, no cache fill storm, no thundering herd.

Long-tail content (obscure documentaries, foreign titles with small regional audiences) that doesn't justify OCA space falls back to a traditional CDN or S3 origin.

### Bottlenecks

OCAs can't hold all 120 PB, only the popular subset. The algorithm must continuously optimize placement; full OCAs evict less popular content for upcoming releases, and that eviction strategy directly affects hit rates and streaming quality for that ISP's users.

<<<SECTION 5>>>
## 6. Streaming Service

Manages playback sessions, authenticates users, generates signed URLs, selects variants, and tracks position for resume.

### Full Playback Initiation Flow

**1. Play request:** client sends POST /playback/start with { user_id, content_id, device_type, supported_codecs, screen_resolution, audio_capabilities } via the API Gateway.

**2. Parallel entitlement checks** (any failure rejects playback immediately):
- Subscription active? (User Profile Service -> Redis cache)
- Title licensed in user's region? (Content licensing DB)
- Device DRM-certified? (Widevine for Android/Chrome, FairPlay for iOS/Safari, PlayReady for Windows)

**3. Variant selection** by reported capabilities:
- 2015 Android phone: H.264 only, capped at 1080p
- 4K TV with Dolby Vision: full set including AV1 and HDR
- Mac browser: H.264 or H.265 depending on browser support

**4. Personalized MPEG-DASH MPD manifest** (Media Presentation Description) for this user and device, containing:
- All variant representations with bitrates and resolutions
- Signed chunk URL patterns with short TTLs tied to the session
- Chunk duration and sequence info
- Audio and subtitle track options

The MPD is signed per session and chunk URLs carry a TTL of a few hours, so a user who cancels can't keep streaming with an old MPD.

**5. DRM license:** simultaneously, the DRM License Service issues a decryption key tied to the authenticated session. All chunks in S3 and OCAs are encrypted; without the license the client can't decrypt them. This is the core content protection.

### Step 6 - Playback Session Created

PlaybackSessions:
- session_id UUID, primary key
- user_id UUID, foreign key -> Users
- content_id UUID, foreign key -> Content
- device_id UUID
- started_at TIMESTAMP
- last_chunk_index INTEGER
- last_position_ms BIGINT
- quality_selected VARCHAR
- updated_at TIMESTAMP

The client updates last_chunk_index and last_position_ms every 30 seconds. This powers Continue Watching: on next play, the MPD starts from the last known position.

**7. ABR takes over.** The client fetches chunks from the nearest OCA; its Adaptive Bitrate algorithm makes all quality decisions:
- Starts at conservative mid quality
- Measures each chunk's download speed
- Monitors buffer health (seconds buffered ahead)
- Moves up or down variants as bandwidth changes
- Switches seamlessly: the next chunk simply comes from a different variant URL

Play to first frame: under 2 seconds on a good connection.

### Bottlenecks

The service is stateless and horizontally scalable. MPD generation is the most compute-intensive step (personalized signed URLs for potentially thousands of chunks), mitigated by caching base MPD templates per device profile and personalizing only the signing.

<<<SECTION 6>>>
## 7. Content Delivery - MPEG-DASH and ABR

### MPEG-DASH vs HLS

Netflix uses MPEG-DASH (Dynamic Adaptive Streaming over HTTP), not HLS:
- **HLS:** .m3u8 playlists and .ts segments, by Apple, native on iOS and Safari
- **DASH:** .mpd manifests and .m4s segments (fragmented MP4), codec-agnostic and more flexible for Netflix's multi-codec strategy

In practice Netflix uses **CMAF (Common Media Application Format)** chunks compatible with both DASH and HLS clients: one set of encoded chunks serves all devices; only the manifest format differs per client.

**MPD structure**

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

The client's ABR algorithm reads this and picks a Representation for each segment based on network conditions and buffer state.

<<<SECTION 7>>>
## 8. User Profile Service

Manages auth credentials, subscription status, viewing history, watchlist, and playback sessions.

**Users (PostgreSQL):** user_id UUID PK; email VARCHAR unique; name VARCHAR; profile_pic_url TEXT; subscription_tier ENUM('standard', 'premium', '4k'); subscription_end TIMESTAMP; created_at TIMESTAMP.

**Watchlist (PostgreSQL):** user_id UUID FK -> Users; content_id UUID FK -> Content; added_at TIMESTAMP; PRIMARY KEY (user_id, content_id). Simple key access: WHERE user_id = X ORDER BY added_at DESC. Cached in Redis per user with a short TTL since changes are infrequent.

**WatchHistory (PostgreSQL):** user_id UUID FK -> Users; content_id UUID FK -> Content; watched_at TIMESTAMP; completion_pct FLOAT; episode_id UUID (null for movies). Append-only and high volume; every completed session writes a record. Primary input to the Recommendation Service; partitioned by user_id for fast per-user fetches.

**Bottlenecks:** subscription status is checked on every playback start, so Redis caches it per user with a TTL of a few minutes (catches cancellations promptly without hammering PostgreSQL). Watch history writes are batched via Kafka consumers rather than written synchronously per event.

<<<SECTION 8>>>
## 9. Metrics and Data Aggregation Service

Every client play, pause, seek, quality switch, buffer event, error, and completion is an event; at 100M DAU x 150 minutes the volume is enormous.

**Event types:**
- **Playback:** play, pause, resume, seek, completion, abandonment
- **Quality:** ABR switches, buffer underruns, startup time
- **Error:** playback failures, DRM errors, network timeouts
- **Engagement:** watchlist adds, search queries, recommendation clicks
- **Device:** device type, OS version, app version, network type

### Ingestion Architecture

Events go to **Kafka** in real time, partitioned by event type and user ID for parallelism. Two consumer pipelines:

**Real-time (Apache Flink)**, within seconds:
- Live ops dashboards (buffering ratios per region, error rates per device, CDN hit rates)
- Anomaly detection (buffering spike in Mumbai = OCA issue at that ISP)
- A/B test metrics (does the new ABR algorithm cut startup time?)
- Real-time personalization (finished an episode -> trigger next-episode notification)

Results go to Redis for live dashboards and alerting.

**Batch (Apache Spark)**, hourly and daily:
- Recommendation model training data
- Content acquisition ("which genres are growing fastest in Southeast Asia?")
- Business analytics (episode completion rates, in-episode drop-off points, binge patterns)
- OCA placement optimization (most-watched titles per ISP region)

Results go to an **S3 data lake** in Parquet for long-term storage and ML training.

### Per-User Aggregations for Recommendations

Kept in Redis, updated by Flink in near real time, consumed by the Recommendation Service:

Key: user_signals:{user_id}
Value: { genres_watched: {drama: 45, thriller: 30, comedy: 15, ...}, avg_session_duration: 87, preferred_watch_time: "evening", completion_rate: 0.78, recently_watched: [content_id_1, content_id_2, ...] }

### Per-Content Aggregations

Key: content_signals:{content_id}
Value: { total_watches: 4500000, completion_rate: 0.82, avg_rating: 4.3, rewatch_rate: 0.12, watchlist_adds: 890000 }

High completion and rewatch rates signal a title should be recommended more aggressively and prioritized for OCA placement.

**Bottlenecks:** Kafka is built for this scale. Flink is the operational concern, processing millions of events per second at low latency. Spark runs on a schedule; its latency suits its use cases.

<<<SECTION 9>>>
## 10. Recommendation Service

Produces a personalized ranked title list per user; must be fast since it appears on the home screen as the app opens.

**Stage 1 - Candidate generation:** narrow 15,000 titles to ~500 via:
- **Collaborative filtering:** users who watched the same titles also watched Y -> Y is a candidate
- **Content-based filtering:** heavy crime-thriller viewer -> other crime thrillers
- **Popularity:** regional trending titles are always candidates

Runs as a periodic batch job (every few hours); candidate sets stored in Redis.

**Stage 2 - Neural ranking** of the 500 using:
- Genre preferences from the Metrics Service
- Time of day (weekday evenings vs weekend afternoons differ)
- Device type (phone users prefer shorter content)
- Content freshness (new releases boosted)
- Social signals (popular among similar-taste users)

Top 20 go to Redis: Key recommendations:{user_id}; Value [content_id_1, content_id_2, ..., content_id_20]; TTL 6 hours. Serving is one Redis GET, hiding the whole ML pipeline.

The pipeline runs typically every 6 hours, more often for highly active users. Completing a title (a high-signal event in the Kafka stream from the Metrics Service) triggers an immediate refresh.

**Bottlenecks:** neural ranking over 15,000 candidates per user is expensive and can't run for 100M users at once, so computation is staggered. Users currently watching don't need home screen updates; the pipeline prioritizes users predicted (from historical usage) to open the app soon.

<<<SECTION 10>>>
## 11. Search Service

Covers titles, genres, cast, directors, and descriptive terms ("feel good movies", "based on true story").

**Elasticsearch** handles full-text search and relevance over 15,000 documents; the catalog is small next to Amazon's 350 million products, so cluster needs are modest.

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

**Ranking** combines text relevance with:
- **Popularity:** watch count and completion rate
- **Personalization:** user's frequent genres rank higher
- **Regional availability:** unavailable titles excluded entirely
- **Recency:** new releases boosted for broad queries

**Sync:** the Search Indexing Worker consumes content.transcoded (new titles) and content.updated (metadata changes). Popularity signals sync periodically from the Metrics batch pipeline, not in real time.

<<<SECTION 11>>>
## 12. Notification Service

Same architecture as previous systems: Kafka fanout from upstream services, APNs (iOS), FCM (Android), SES (email). Subscribes to:
- content.released -> "New episodes of Stranger Things are available"
- session.completed -> "You finished Episode 3. Episode 4 is ready"
- watchlist.available -> "A title on your watchlist just dropped in your region"
- recommendation.refresh -> periodic "We think you will love this" re-engagement

Too many notifications cause uninstalls, so per-user frequency capping allows at most one promotional notification per day regardless of triggers.

## 13. Full Data Flow Summary

**Content ingestion:** Studio -> AWS Direct Connect / physical drive -> S3 (raw master) -> Preprocessor (GOP splitting, DAG generation, audio separation) -> DAG Scheduler -> Task Queue (Kafka) -> Resource Manager -> Task Workers (thousands of GPU EC2 instances) -> S3 (encoded chunks per variant per GOP) -> all chunks done -> Kafka (content.transcoded) -> Metadata Worker -> Content DB + Redis; Search Indexing Worker -> Elasticsearch; MPD Generation Worker -> S3 (manifests per device profile). Open Connect nightly job pulls popular content from S3 to OCAs in ISPs.

**Playback initiation:** play -> API Gateway -> Streaming Service -> parallel: User Profile Service (subscription), Content Licensing DB (region), DRM Service (device certification) -> variant selection by device -> personalized MPD with signed chunk URLs -> DRM license -> PlaybackSession in PostgreSQL -> MPD returned.

**Chunk delivery:** client ABR reads MPD -> requests chunk from OCA in user's ISP (~95% hit) -> on miss, Netflix CDN / S3 origin -> OCA caches and serves -> ABR switches variant per chunk based on measured bandwidth.

**Metrics ingestion:** client events (play, pause, buffer, quality switch) -> Kafka -> Flink (real-time) -> Redis (live dashboards, anomaly detection); Spark (batch) -> S3 data lake (ML training, analytics); per-user signal aggregations -> Redis (recommendation inputs).

**Recommendation:** Metrics Service -> Kafka -> pipeline. Stage 1 (batch every 6 hours): collaborative + content-based filtering -> 500 candidates per user. Stage 2 (neural ranking): rank using Redis user signals -> top 20 -> Redis recommendations:{user_id}, 6hr TTL. App open -> GET recommendations:{user_id}, one Redis read.

**Search:** "crime thriller" -> Search Service -> Redis (hot query cache) -> Elasticsearch (personalized by genre preferences + popularity) -> Redis MGET (hydrate content metadata).

**Continue watching:** client heartbeat every 30s -> Streaming Service -> UPDATE PlaybackSessions SET last_position_ms = X WHERE session_id = Y. On return, read PlaybackSessions -> MPD from last_chunk_index -> resume at exact position.

<<<SECTION 12>>>
## 14. Resilience and Fault Tolerance

- **Multi-OCA redundancy:** if an ISP's OCA fails, requests go to the next nearest OCA or Netflix's CDN fallback; maybe a brief quality drop, but playback never stops.
- **Proactive cache warming:** release-day thundering herds are absorbed by OCA hits and never reach S3 origin.
- **Client-side ABR:** adapts continuously to degraded networks without server involvement; quality drops gracefully, buffering only if connectivity hits zero.
- **Kafka durability in transcoding:** a worker crash loses no work; tasks are requeued from Kafka, and the DAG Scheduler requeues only incomplete tasks.
- **DAG parallelization:** a worker failure affects only its GOP x Variant tasks; the Resource Manager detects it, returns its tasks to the Task Queue, and reassigns them to healthy workers.
- **Playback sessions in PostgreSQL:** Continue Watching survives app crashes, device switches, and backend restarts; the last position is always durable.
- **Two-stage recommendations:** if neural ranking fails, fall back to candidate generation results; degraded beats an empty home screen.
- **Redis at every read layer** (subscription, content metadata, recommendations, watchlist): happy paths rarely touch PostgreSQL, so its failures degrade gradually rather than causing outages.
- **Independent metrics pipeline:** Flink or Spark failures don't affect streaming, search, or other user-facing services; metrics aren't on the playback critical path.

<<<SECTION 13>>>
## 15. Technology Choices Summary

- **API Gateway:** Kong / AWS API Gateway (auth, rate limiting, regional routing, geo access control)
- **Master File Storage:** S3 (raw masters, permanent archive, transcoding source)
- **Transcoding Compute:** GPU EC2 via DAG Scheduler + Kafka Task Queue (parallel GOP x Variant encoding on thousands of workers)
- **Encoded Chunk Storage:** S3 (864,000 objects per title, deterministic URLs)
- **Content Delivery:** Open Connect Appliances in ISP data centers (proactive warming, no public internet for popular content)
- **Streaming Protocol:** MPEG-DASH with CMAF chunks (ABR, multi-codec, HLS and DASH compatible)
- **DRM:** Widevine + FairPlay + PlayReady (per-session keys, device-bound licensing)
- **Content DB:** sharded PostgreSQL + replicas (title metadata, licensing, regional availability)
- **User Profile DB:** PostgreSQL (subscription, watch history, watchlist, playback sessions)
- **Playback Session Store:** PostgreSQL + Redis (resume position, entitlement cache)
- **Search:** Elasticsearch (full text, personalized ranking, genre and cast indexing)
- **Recommendation Store:** Redis (precomputed top 20 per user, single GET on home screen)
- **Real-time Metrics:** Kafka + Flink (sub-second processing, live dashboards, anomaly detection)
- **Batch Metrics:** Spark + S3 data lake (ML training, analytics, OCA placement)
- **User Signal Cache:** Redis (genre preferences, completion rates, watch patterns)
- **Notifications:** APNs + FCM + SES (push and email with per-user frequency capping)
