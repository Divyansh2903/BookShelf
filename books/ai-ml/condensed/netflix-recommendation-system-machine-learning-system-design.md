# Netflix Recommendation System - Machine Learning System Design

<<<SECTION 1>>>
## Netflix ML Recommendation System: High Level Design

**Problem:** Netflix serves hundreds of millions of users across movies, series, and documentaries. Beyond storage and streaming, the challenge is choosing what to show each user on app open, so it feels personal, relevant, and fresh every time.

Strict bucketing (movie watchers get only movies, series watchers only series) creates silos and kills discovery. A **hybrid weighted recommendation model** instead gives a mostly-movies user ~70% movies, 15% series, 15% documentaries.

Two metrics drive every layer: **recall** (did we surface content they'd like?) and **precision** (how much of what we surfaced did they engage with?).

<<<SECTION 2>>>
## Scale and Capacity Estimation

**Traffic**
- 200M DAU; catalog of 100K titles (movies + series + documentaries)
- ~50 events/user/day: 200M x 50 x 1KB = 10TB/day raw interaction data
- ~2 sessions/user/day, one homepage load each: 200M x 2 = 400M requests/day -> ~4,600 RPS average, ~10K RPS peak

**Storage**
- Content metadata: 100K x 1KB = **100MB** (fully cacheable in memory)
- Videos: S3, served via CDN
- Item embeddings: 100K x 128 dims x 4 bytes = **~50MB** (fits in memory)
- User embeddings: 200M x 128 dims x 4 bytes = **~100GB** (Redis or DynamoDB, updated periodically)
- Behavioral data lake: Cassandra, ingesting 10TB/day

**Latency budget:** homepage must load in under 200ms, so the pipeline can't run per request. Recommendations are **pre-computed and cached**; the homepage fetch is a cache read.

<<<SECTION 3>>>
## Handling New Users: Cold Start Strategy

New users have no history, session data, or behavioral signals. Three strategies:

1. **Explicit genre onboarding:** show 5 to 8 genre cards (rom-coms, thrillers, etc.) at signup. Max 3 to 5 taps; drop-off is high if it feels like a form.
2. **Global and regional trending:** most new users want popular content, so show Top 10 globally and historically famous titles. Social proof reduces decision fatigue.
3. **Geographic and device signals:** location is a strong implicit signal (India skews to Bollywood and regional-language content, Korea to K-dramas); the CDN serves regional content with low latency. Device at signup (mobile in India at 10 PM) is weak but useful.

After 2 to 3 watched titles, behavioral signals accumulate and collaborative filtering is blended in; the cold start model gracefully fades as personal data grows.

<<<SECTION 4>>>
## Behavioral Signals

Raw clicks are weak. The system also captures:

- **Session watch time** (hours watched, not just opens)
- **Completion rate**: 90% is strongly positive; dropping at 20 minutes is negative
- **Re-watches**: one of the strongest affinity signals
- **Explicit ratings** (thumbs up/down): sparse but high quality
- **Search queries**: direct intent ("crime thriller" states genre preference)
- **Watchlist adds without playback**: interest with friction
- **Time of day and device**: morning mobile suggests short/casual; evening TV suggests long-form immersive
- **Skip intro / skip recap**: engagement depth and familiarity

The **Data Aggregator Service** writes these to Cassandra keyed by user_id + timestamp, a write-heavy, time-series-like workload Cassandra is built for.

<<<SECTION 5>>>
## What Are Embeddings?

Embeddings underpin the whole system. A machine can't understand "Breaking Bad" or "The Big Bang Theory"; an **embedding** is a dense vector (typically 128 or 256 dimensions) encoding an entity's semantic properties:

Breaking Bad = \[0.82, 0.11, 0.94, 0.03, ...\]   (128 numbers)  
Narcos         = \[0.79, 0.13, 0.91, 0.06, ...\]   (128 numbers)

These are close in space: both are high-tension crime dramas with drug themes and similar audiences. **Similar content and similar users cluster together**, so recommendation becomes nearest-neighbor search.

- **Item embeddings**: one per title; ~50MB (100K x 128 x 4 bytes), fits in memory.
- **User embeddings**: one per user from behavioral history; ~100GB (200M x 128 x 4 bytes), in Redis, updated regularly.

<<<SECTION 6>>>
## System Architecture: Three Core Services

Behind the API Gateway and load balancers:

1. **User Service**: profile management. On app open it triggers the Recommendation Service to hydrate the homepage. Kafka between them decouples profile update events from recommendation refreshes, so login spikes don't overwhelm the pipeline.
2. **Recommendation Service**: the core; runs a **two-stage ML pipeline** (candidate picker, then ranker).
3. **Data Aggregator Service**: consumes all behavioral signals (clicks, session/watch time, re-watches, watchlist adds, etc.) into Cassandra, where models train. Kafka buffers the high-throughput stream before storage.

<<<SECTION 7>>>
## The Two-Stage ML Pipeline

One model ranking 100K titles to 20 is infeasible at 10K RPS within 200ms, hence two stages.

### Stage 1: Candidate Picker (Recall Model)

Reduce 100K titles to the top 100. Prioritizes recall (don't miss liked content); speed over perfect ranking. Uses **Approximate Nearest Neighbor (ANN) search**: the user embedding is compared against all item embeddings and the 100 closest retrieved, in milliseconds with **FAISS** (Facebook AI Similarity Search) or **Pinecone**. Collaborative filtering (watched X, also watched Y) broadens recall beyond the user's own history.

Flow: User embedding -> ANN search over item embeddings -> Top 100 candidates

### Stage 2: Ranker (Precision Model)

Score the 100 and keep the top 20. Prioritizes precision with richer, costlier features in a heavier neural network: watch history and affinity scores; content freshness and release date; time of day and device; thumbnail CTR for similar users; completion rates for similar content among collaborative peers. The top 20 go to **Redis**, keyed by user_id.

Flow: 100 candidates + rich features -> Neural ranker -> Top 20 scores -> Redis

### Profile Hydration

The User Service does a Redis **MGET** for the user's pre-computed top 20 (sub-millisecond). No ML inference at request time, so the 200ms budget is easy.

### Data Storage and Model Freshness: Lambda Architecture

Deep retraining takes hours and can't run continuously, yet recent behavior (a thriller 10 minutes ago) should count immediately. The **Lambda Architecture** solves both:

- **Batch layer** (depth, accuracy): overnight full retrain on all Cassandra data every 24 hours; user and item embeddings fully recomputed, capturing long-term and seasonal patterns.
- **Speed layer** (freshness): a lightweight model on the real-time Kafka stream incrementally updates user embeddings from recent sessions. Three thrillers in a row shift recommendations within minutes, not next day.

### Diversity Injection: Avoiding the Echo Chamber

A pure precision ranker eventually serves 20 crime thrillers: an echo chamber that kills discovery and raises churn. A **post-ranking diversity layer** between ranker and Redis write reshuffles and caps the 20:

- **Category capping**: no genre gets more than 5 to 6 of 20 slots.
- **Novelty injection**: 2 to 3 slots for never-seen titles even with slightly lower scores, driving niche discovery.
- **Exploration vs exploitation (bandit)**: 85% of slots exploit known preferences, 15% explore; engagement there gradually updates the user embedding.
- **Shelf-based diversity**: the homepage is shelves ("Because you watched X", "Trending in India", "New Releases", "Top 10 Today"), each with its own diversity and category rules; a UX and algorithmic fix.

### End-to-End Request Flow

1. User opens app -> API Gateway -> Load Balancer
2. User Service (profile lookup) -> \[Kafka event\] -> Recommendation Service
3. Redis lookup (MGET top 20 for user_id), pre-computed, sub-millisecond
4. Homepage rendered with personalized shelves

In background: Data Aggregator ingests session signals -> Kafka -> Cassandra -> batch retraining (24h) + speed layer (real-time) -> updated user embeddings -> Candidate Picker -> Ranker -> Diversity Layer -> Redis.

### Technology Summary

- **API Gateway + Load Balancer**: entry point, traffic distribution
- **Kafka**: service decoupling, buffering event streams
- **Cassandra**: behavioral data lake (time-series events by user_id + timestamp)
- **FAISS / Pinecone**: ANN candidate generation
- **Redis**: pre-computed top 20 per user, sub-ms MGET
- **S3 + CDN**: video, thumbnails, trailers with regional caching
- **Lambda Architecture**: batch (24h) + speed layer (real-time Kafka)
