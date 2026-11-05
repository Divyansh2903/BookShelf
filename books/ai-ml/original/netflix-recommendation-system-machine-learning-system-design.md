# Netflix Recommendation System - Machine Learning System Design

<<<SECTION 1>>>
## Netflix ML Recommendation System: High Level Design

## Problem Statement

Netflix serves hundreds of millions of users across movies, series, and documentaries. The core challenge (apart from storing and streaming content) is figuring out what to show each user the moment they open the app, in a way that feels personal, relevant, and fresh every single time.

A naive approach would be to bucket users strictly: movie watchers get only movies, series watchers get only series.   
But this creates content silos and kills discovery. The better approach is a "**hybrid weighted recommendation model"**. If a user predominantly watches movies, their recommendation mix looks something like 70% movies, 15% series, and 15% documentaries. This respects affinity without locking the user into a silo.

The two ML metrics that anchor the entire system are **recall** (did we surface content the user would have liked?) and **precision** (of what we surfaced, how much did they actually engage with?). These two goals drive the architecture at every layer.

<<<SECTION 2>>>
## Scale and Capacity Estimation

Before designing the system, we anchor on numbers.

### Traffic

- DAU: 200 million
- Content catalog: 100K titles (movies + series + documentaries)
- User interactions per user per day: ~50 events
- Raw interaction data per day: 200M x 50 x 1KB = 10TB/day
- Sessions per user per day: ~2, with one homepage load per session
- Recommendation requests: 200M x 2 = 400M requests/day -> ~4,600 RPS average, ~10K RPS at peak

### Storage

- Content metadata: 100K x 1KB = **100MB** (tiny, fully cacheable in memory)
- Videos: stored in S3, served via CDN
- Item embeddings: 100K titles x 128 dimensions x 4 bytes = **~50MB** (fits entirely in memory)
- User embeddings: 200M users x 128 dimensions x 4 bytes = **~100GB** (stored in Redis or DynamoDB, updated periodically)
- Behavioral data lake: Cassandra, ingesting 10TB/day of raw signals

### Latency budget

- The Netflix homepage must load in under 200ms. This means the recommendation pipeline cannot run live on every request. Recommendations must be **pre-computed and cached**, so the homepage fetch is just a cache read.

<<<SECTION 3>>>
## Handling New Users: Cold Start Strategy

A brand new user has no watch history, no session data, and no behavioral signals. Three strategies handle this gracefully.

**1. Explicit genre onboarding**  
On signup, show the user 5 to 8 genre cards (rom-coms, thrillers, etc.) and ask them to pick what they are interested in. This is a lightweight explicit signal. The onboarding must be kept to 3 to 5 taps maximum since drop-off is high if it feels like a form.

**2. Global and regional trending content**  
Most new users come to Netflix for popular, well-known content. Surfacing globally trending titles (Top 10 globally) and historically famous pieces gives them an immediately useful experience. Social proof reduces decision fatigue.

**3. Geographic and device signals**  
A user's location is a strong implicit signal even before any interaction. Regional content affinity is real: India skews toward Bollywood and regional language content, Korea toward K-dramas, and so on. CDN serves this regional content with low latency. Device type at signup (mobile in India at 10 PM) is also a weak but useful signal.

**Transitioning to personalization**  
As soon as the user watches 2 to 3 pieces of content, behavioral signals start accumulating. The system begins blending collaborative filtering into the mix. The cold start model gracefully degrades as personal data grows.

<<<SECTION 4>>>
## Behavioral Signals

Raw clicks alone are a weak signal. The system must capture a richer set of user behaviours to build an accurate preference profile.

- **Session watch time**: Hours spent watching, not just what was opened
- **Completion rate**: A 90% completion is a strong positive signal; dropping off at 20 minutes is a negative one
- **Re-watches**: Rewatching a title is one of the strongest affinity signals in the system
- **Explicit ratings**: Thumbs up / thumbs down, sparse but high quality
- **Search queries**: Direct intent signal. Searching "crime thriller" tells you genre preference explicitly
- **Watchlist additions without playback**: Interest signal with friction
- **Time of day and device**: Mobile in the morning suggests short-form or casual content; TV in the evening suggests long-form immersive content
- **Skip intro / skip recap behavior**: Signals engagement depth and familiarity

All of these signals are ingested by the **Data Aggregator Service** and written into Cassandra, keyed by user_id + timestamp. This is a write-heavy, time-series-like workload, which is exactly what Cassandra is built for at this scale.

<<<SECTION 5>>>
## What Are Embeddings?

Before describing the ML pipeline, it is important to understand embeddings since they are the foundation of the entire recommendation system.

A machine cannot understand the title "Breaking Bad" or "The Big Bang Theory". It needs a numerical representation that captures the meaning and characteristics of that title. An embedding is a dense vector of numbers in a high-dimensional space, typically 128 or 256 dimensions, that encodes the semantic properties of an entity.

For example:

Breaking Bad = \[0.82, 0.11, 0.94, 0.03, ...\]   (128 numbers)  
Narcos         = \[0.79, 0.13, 0.91, 0.06, ...\]   (128 numbers)

These two vectors are close to each other in the embedding space because both are crime dramas with high tension, drug-related themes, and similar audience profiles. **Similar content clusters together. Similar users cluster together.** Recommendation becomes a nearest-neighbor search problem in this vector space.

Two types of embeddings power this system:

- **Item embeddings**: One vector per title. 100K titles x 128 dims x 4 bytes = ~50MB. Fits entirely in memory.
- **User embeddings**: One vector per user, built from their behavioral history. 200M users x 128 dims x 4 bytes = ~100GB. Stored in Redis, updated on a regular cadence.

<<<SECTION 6>>>
## System Architecture: Three Core Services

After passing through the API Gateway and load balancers, the recommendation system is built on three services.

### 1. User Service

Handles user profile management. When a user opens the app, the User Service triggers the Recommendation Service to hydrate that user's homepage. Kafka sits between the User Service and the Recommendation Service to decouple profile update events from recommendation refresh cycles. This ensures that a spike in logins does not overwhelm the recommendation pipeline.

### 2. Recommendation Service

This is the heart of the system. It runs a **two-stage ML pipeline**: a candidate picker followed by a ranker.

### 3. Data Aggregator Service

Consumes all behavioral signals (clicks, session time, watch time, re-watches, watchlist additions, etc.) from user sessions and writes them to Cassandra. The ML models train on this data. Kafka is used here as well to buffer the high-throughput event stream before it lands in storage.

<<<SECTION 7>>>
## The Two-Stage ML Pipeline

This is the core of the recommendation system. Going directly from 100K titles to a ranked list of 20 in a single model is computationally infeasible at 10K RPS with a 200ms budget. The two-stage approach solves this cleanly.

### Stage 1: Candidate Picker (Recall Model)

**Goal**: Reduce 100K titles to the top 100 candidates for a given user.

This stage prioritizes recall. It must not miss content the user would have liked. Speed matters more than perfect ranking here.

The mechanism is **Approximate Nearest Neighbor (ANN) search**. The user's embedding is compared against all item embeddings in vector space, and the 100 closest titles are retrieved. Tools like **FAISS** (Facebook AI Similarity Search) or **Pinecone** perform this search in milliseconds even over 100K vectors.

Collaborative filtering feeds into this stage as well: users who watched content X also watched Y. This broadens recall beyond the individual user's direct history.

### Flow: User embedding -> ANN search over item embeddings -> Top 100 candidates

### Stage 2: Ranker (Precision Model)

**Goal**: Score and rank the 100 candidates down to the top 20 titles to display.

This stage prioritizes precision. It takes richer, more expensive features and runs them through a heavier neural network model. Features include:

- User watch history and affinity scores
- Content freshness and release date
- Time of day and device type
- Thumbnail click-through rate for similar users
- Completion rates for similar content among collaborative peers

Each of the 100 candidates gets a score. The top 20 are selected and written to **Redis**, keyed by user_id.

Flow: 100 candidates + rich features -> Neural ranker -> Top 20 scores -> Redis

### Profile Hydration

When the User Service needs to populate the homepage, it calls Redis with an **MGET** for the user's pre-computed top 20. This is a sub-millisecond operation. The 200ms homepage budget is easily met because no ML inference happens at request time.

### Data Storage and Model Freshness: Lambda Architecture

Cassandra stores all behavioral data at scale. But two problems arise: deep model retraining takes hours and cannot run continuously, and real-time behavior (watching a thriller 10 minutes ago) should influence the next recommendation immediately.

The **Lambda Architecture** solves both.

**Batch layer**  
Full model retraining on the complete Cassandra dataset runs every 24 hours. This is the deep pass: user embeddings and item embeddings are fully recomputed, capturing long-term patterns and seasonal shifts. This runs overnight as a scheduled job.

**Speed layer**  
A lightweight model runs on the real-time Kafka stream. It captures recent signals (last session's watch behavior) and applies incremental updates to user embeddings without waiting for the next full retrain. If you just watched three thrillers in a row, your recommendations shift toward thrillers within minutes, not the next day.

Together:

- Batch layer -> depth and accuracy
- Speed layer -> freshness and responsiveness

Diversity Injection: Avoiding the Echo Chamber

A ranker that purely optimizes for precision will eventually serve a user 20 crime thrillers because that is their dominant affinity. This creates an echo chamber, kills content discovery, and increases churn over time.

A **post-ranking diversity layer** sits between the ranker output and the Redis write. It reshuffles and caps the final 20 using several strategies.

**Category capping**: No single genre occupies more than 5 to 6 of the 20 slots, regardless of affinity score.

**Novelty injection**: 2 to 3 slots are deliberately reserved for titles the user has never been exposed to, even if their ranker score is slightly lower. This drives discovery of niche content over time.

**Exploration vs exploitation (Bandit approach)**: 85% of slots exploit known preferences. 15% explore new territory. The model learns from engagement on the exploration slots and gradually incorporates new preferences into the user embedding.

**Shelf-based diversity**: Netflix's homepage is not a single list of 20. It is organized into horizontal shelves: "Because you watched X", "Trending in India", "New Releases", "Top 10 Today". Each shelf has its own diversity and category rules. This is both a UX and an algorithmic solution to the echo chamber problem.

### End-to-End Request Flow

User opens Netflix app  
        |  
        v  
API Gateway -> Load Balancer  
        |  
        v  
User Service (profile lookup)  
        |  
   \[Kafka event\]  
        |  
        v  
Recommendation Service  
        |  
        v  
Redis lookup (MGET top 20 for user_id)  <-- pre-computed, sub-millisecond  
        |  
        v  
Homepage rendered with personalized shelf content  
        |  
(In background)  
        |  
        v  
Data Aggregator Service ingests session signals -> Kafka -> Cassandra  
        |  
        v  
Batch retraining (every 24h) + Speed layer (real-time stream)  
        |  
        v  
Updated user embeddings -> Candidate Picker -> Ranker -> Diversity Layer -> Redis

Technology Summary

- **API Gateway + Load Balancer**: Entry point, traffic distribution
- **Kafka**: Decoupling between services, buffering high-throughput event streams
- **Cassandra**: Behavioral data lake, write-heavy time-series events keyed by user_id + timestamp
- **FAISS / Pinecone**: ANN search for candidate generation in vector space
- **Redis**: Pre-computed top 20 recommendations per user, sub-millisecond MGET reads
- **S3 + CDN**: Video storage and delivery, also serves thumbnails and trailers with regional caching
- **Lambda Architecture**: Batch (24h retraining) + Speed layer (real-time Kafka stream updates)

That's all, folks...Cheers!
