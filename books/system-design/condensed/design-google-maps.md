# Design Google Maps

<<<SECTION 1>>>
## 1. Requirements

**Functional**
- User location fetching (device GPS)
- Map rendering (tiles at all zoom levels)
- Route calculation between two points
- ETA with real-time traffic
- Real-time traffic integration
- Place search

**Out of scope:** Street View, indoor maps, public transit routing, offline maps, Google Maps Platform API for third parties, satellite imagery pipeline.

**Non-functional**
- High reliability: maps must never go down
- High routing and location accuracy
- Low latency: tiles under 50ms, routes under 2 seconds
- Massive scale: 500M DAU, 50M concurrent
- Traffic reflects current conditions within minutes

## 2. Capacity Estimation

- **DAU:** 500M; **concurrent:** 10% = 50M
- **Location pings:** 50M users every 10-20 s = ~5M QPS
- **Tile requests:** 50M x 20 tiles per interaction / 15 s = ~67M/sec
- **CDN tile hit rate:** 90%+ (popular city tiles requested millions of times), leaving ~7M origin requests/sec
- **Route QPS:** 10% of concurrent users = ~2.5M QPS
- **Tile storage:** ~50 PB (440 PB theoretical across all zoom levels, reduced by sparse oceans, deserts, uninhabited land)
- **Traffic ingestion:** ~5M GPS pings/sec (same as location pings)

This dwarfs every earlier system in the series. At 67M tiles/sec, the CDN is the most critical component; without a global CDN absorbing 90%+ of tile traffic, origin would collapse instantly.

<<<SECTION 2>>>
## 3. API Gateway

Handles auth, rate limiting, and routing, treating each traffic type differently:
- **Tile requests:** anonymous (public tiles), extremely high volume, read-only; routed straight to the Tile Service CDN layer.
- **Location pings:** authenticated, high-volume writes; rate limited per device.
- **Route calculations:** authenticated, expensive, lower volume; rate limited per user to protect routing.
- **Search:** authenticated, low volume; routed to search and geocoding.

## 4. Map Tile System

### Tile coordinate system

The world is a grid of square tiles at 22 zoom levels (0-21):
- **Zoom 0:** whole world in 1 tile (256x256 px)
- **Zoom 1:** 4 tiles (2x2)
- **Zoom N:** 4^N tiles
- **Zoom 21:** street level, ~4.4 trillion tiles

Each tile is a 256x256 PNG, ~100 KB. Theoretical storage is 440 PB; excluding oceans, deserts, and uninhabited regions (~70% of Earth's surface) gives ~50 PB.

Tiles use a deterministic key `{zoom_level}/{x}/{y}` (grid coordinates at that zoom), so clients build any tile URL without a DB lookup: `https://tiles.maps.google.com/{zoom}/{x}/{y}.png`. The URL itself is the cache key, which makes CDN caching so effective.

### Map rendering pipeline (offline batch)

Tiles are pre-rendered from vector map data when the data changes, not on demand.

**Data sources** feeding the Map Data Store:
- Licensed providers (HERE, TomTom)
- OpenStreetMap contributions
- Ground truth operators manually verifying road changes
- User reports (closures, new roads)
- Satellite imagery analysis (ML detects new roads in aerial photos)

The Map Data Store is a geospatial DB (PostGIS at its core), the source of truth for roads, buildings, and geography.

**Rendering flow** (e.g. a new road in Mumbai):
1. A ground truth operator verifies the road and updates the Map Data Store.
2. The store publishes `map.data.updated` to Kafka with the changed bounding box.
3. The rendering pipeline finds tiles at each zoom level intersecting the box (one road can affect thousands of tiles across zooms 10-21) and re-renders only those, each as a 256x256 PNG from vector data (roads, buildings, labels, colors).
4. Tiles are stored in S3 at `tiles/{zoom}/{x}/{y}.png`.
5. CDN cache for affected URLs is invalidated via the purge API.
6. Users get the update on their next request.

Rendering is CPU-intensive but embarrassingly parallel (each tile independent), so it scales across thousands of workers.

### Tile serving via CDN

On pan/zoom, the client computes the tile coordinates for the viewport and requests them, e.g. `GET https://tiles.maps.google.com/15/24456/14689.png`.
- **Hit (90%+):** edge serves directly, under 10ms near an edge node.
- **Miss:** CDN fetches from S3, caches at the edge, serves; 50-100ms.

Low-zoom tiles (0-10, world to country) are cached at every edge globally since everyone requests them. High-zoom tiles (15-21, neighborhood to street) are cached at regional nodes since they matter only locally.

### Tile storage in S3

S3 is the origin for all 50 PB: virtually unlimited storage and native CDN integration. Tiles are immutable once rendered; a re-render overwrites the same key and the CDN cache is invalidated.

### Bottlenecks

- **Rendering pipeline** during large changes (a major highway opening touches thousands of tiles at many zooms). Mitigated by prioritizing high-zoom tiles (street level, most requested) over low-zoom tiles (country level, cached for months) in the render queue.
- **CDN** during major events (earthquake emergency routing, big sporting events) when one area spikes. Handled by pre-warming edge nodes for expected events.

<<<SECTION 3>>>
## 5. Navigation Service and Routing

### Graph data model

A directed weighted graph:
- **Nodes:** intersections and endpoints (~500M globally)
- **Edges:** road segments (~1B globally)
- **Weights:** travel time from distance and speed limit, adjusted by real-time traffic

### Nodes Table (PostgreSQL + PostGIS)

```pgsql
node_id           BIGINT, primary key
lat               FLOAT
long              FLOAT
location          GEOGRAPHY(POINT, 4326) [GIST spatial index]
importance_rank   INTEGER (assigned during CH preprocessing)
node_type         ENUM('intersection', 'highway_junction', 'traffic_signal', 'roundabout')
```

### Edges Table (PostgreSQL)

```pgsql
edge_id           BIGINT, primary key
from_node_id      BIGINT, foreign key -> Nodes
to_node_id        BIGINT, foreign key -> Nodes
distance_m        INTEGER
speed_limit_kmh   INTEGER
road_type         ENUM('highway', 'arterial', 'local', 'shortcut')
is_one_way        BOOLEAN
is_shortcut       BOOLEAN (true for CH preprocessed shortcut edges)
shortcut_via      BIGINT (contracted node ID this shortcut bypasses)
free_flow_speed   FLOAT (historical average speed at this segment)
```

Each region's graph is loaded into memory on Navigation Service instances as an adjacency list; all routing runs in memory for sub-second performance.

### Contraction Hierarchies (CH) preprocessing

Plain Dijkstra on 500M nodes takes minutes per query. CH preprocesses offline.

**Importance ranking** per node, based on:
- Road type (highway junctions above local intersections)
- Number of shortest paths through the node (betweenness centrality)
- Connectivity (nodes linking major roads rank higher)

**Node contraction:** from least to most important, remove each node and add shortcut edges between its neighbors to preserve shortest-path distances. E.g. contracting low-importance B in `A --5km--> B --3km--> C` yields `A --8km--> C` (shortcut added, B removed).

What remains is only high-importance nodes (major highway junctions, arterial intersections); a Mumbai to Delhi query traverses ~10M nodes instead of 500M. Shortcuts are stored in Edges with `is_shortcut = true` and `shortcut_via` = the contracted node; path reconstruction expands them back into real segments for turn-by-turn directions.

### Full routing flow: Bandra to Connaught Place

1. **Geocoding:** Bandra, Mumbai -> (19.0544, 72.8375); Connaught Place, Delhi -> (28.6315, 77.2167).
2. **Partition loading:** the world graph is split into regional partitions; only those on the route (Maharashtra, Madhya Pradesh, Rajasthan, Delhi) are loaded for the query.
3. **Bidirectional CH search:** forward from Bandra up through more important nodes (local streets -> SV Road -> Bandra-Worli Sea Link -> Western Express Highway -> NH48); backward from Connaught Place (local streets -> Ring Road -> NH48). They meet on NH48 in Rajasthan; the path is rebuilt by expanding shortcuts.
4. **Traffic layer:** CH gives the geometrically optimal path; traffic adjusts weights live. Current speeds for all route segments come from Redis via `MGET traffic:segment_1 traffic:segment_2 ... traffic:segment_N`. Travel times are recomputed; if the path is heavily congested, the top 3 alternatives are evaluated and the fastest by time is returned.

### Step 5 - ETA Calculation

ETA = SUM(segment_distance_km / current_speed_kmh) over all segments + estimated delay at traffic signals (historical average per signal) + time-of-day adjustment (6pm Friday is slower than 2am Sunday on the same route).

Historical speeds are stored per segment per hour per day of week. A route computed at 5:30pm Friday uses Friday-evening historical speeds for segments the user will reach in 2 hours, not current speeds.

6. **Route caching (Redis):** key `route:{origin_geohash_p6}:{dest_geohash_p6}:{time_bucket_5min}`; value `{ waypoints, segment_ids, base_eta, alternative_routes }`; TTL 5 minutes, balancing freshness (traffic changes fast) against compute cost.
7. **Active navigation and re-routing:** the client pings every 5 seconds. The service watches for **deviation** (user left the route) and **traffic change** (a route segment became significantly more congested); either triggers a re-route from the current position with the same CH query.

**Bottlenecks:** the CH query takes milliseconds. The cost is loading many partitions for long routes; mitigated by keeping all partitions pre-loaded on instances with enough RAM (a South Asia instance keeps the whole South Asia graph in memory, never loading on demand).

<<<SECTION 4>>>
## 6. Location Service and Traffic Pipeline

### Location ingestion

Users with navigation or location sharing active send a GPS ping every 10-20 seconds:

```json
{
  "user_id": "uuid",
  "lat": 19.0721,
  "long": 72.8846,
  "speed_kmh": 45,
  "heading": 270,
  "accuracy_m": 8,
  "timestamp": 1726123456
}
```

The stateless, horizontally scalable Location Service takes 5M pings/sec and publishes immediately to Kafka topic `location.pings`, partitioned by user_id. Kafka absorbs bursts and decouples ingestion from processing.

### Map Matching Service

Raw GPS can't be mapped to segments directly due to error (5-10 m) and ambiguity (several roads within the error radius). The service snaps each ping to a segment with a **Hidden Markov Model (HMM)**.

**Example:** a ping at (19.0721, 72.8846), heading 270 degrees (westbound), with three segments within 15 m: the Western Express Highway flyover (westbound), SV Road below it (westbound), and a service road beside SV Road (eastbound only). Which gets the 45 kmh update?

The HMM scores candidates on three signals at once:
1. **Proximity:** closer scores higher; reported accuracy (8 m) defines the probability distribution around the coordinate.
2. **Heading alignment:** must match segment direction; eastbound-only segments are eliminated, westbound score higher.
3. **Transition probability:** given segment X at the previous ping (15 s ago), how likely is segment Y now? Road topology rules out impossible moves (no teleporting from the flyover to a road 500 m away in 15 s).

The top scorer wins. Matches below 0.7 confidence are discarded rather than corrupting traffic data.

### Map Matching Service Output:

```json
{
  "edge_id": "highway_segment_447",
  "speed_kmh": 45,
  "timestamp": 1726123456,
  "confidence": 0.94
}
```

Published to Kafka topic `location.matched`.

### Traffic aggregation with Apache Flink

The Traffic Service consumes `location.matched` with Flink. Writing Redis per ping (5M writes/sec) would be catastrophic, so Flink aggregates: **2-minute sliding window per segment, median speed of matched pings, updated every 30 seconds.**

Median, not average, filters outliers: one 0 kmh ping from a user at a red light doesn't make a highway look congested when 50 others show 80 kmh.

### Congestion Level Computation:

```
def congestion_level(current_speed, free_flow_speed):
    ratio = current_speed / free_flow_speed
    if ratio > 0.8:  return 'free_flow'
    if ratio > 0.6:  return 'light'
    if ratio > 0.4:  return 'moderate'
    if ratio > 0.2:  return 'heavy'
    return 'standstill'
```

```python
{
  "edge_id": "highway_segment_447",
  "speed_kmh": 45,
  "timestamp": 1726123456,
  "confidence": 0.94
}
```

free_flow_speed is the segment's historical average for the current time of day and day of week.

**Redis update:** key `traffic:{edge_id}`; value `{ current_speed_kmh: 45, free_flow_speed: 80, congestion_level: 'light', updated_at: timestamp }`; TTL 5 minutes. If no pings arrive for 5 minutes, the key expires and Navigation falls back to historical speeds.

**Broadcast to navigators:** when Flink sees a segment's congestion level change by one level, it publishes `traffic.updated` to Kafka; Navigation Service consumes it and pushes updates over WebSocket to users whose active routes include that segment.

### Location data storage

Raw pings are not stored permanently; only aggregated segment speeds go to a time-series store.

### TrafficHistory Table (Cassandra)

```pgsql
edge_id           BIGINT, partition key
time_bucket       TIMESTAMP (rounded to 5 minutes), clustering key
avg_speed_kmh     FLOAT
congestion_level  TEXT
sample_count      INTEGER
```

Partitioning by edge_id and clustering by time_bucket makes historical time-range queries very fast. This feeds the historical speed model for ETAs.

### Bottlenecks

Map Matching is the main bottleneck at 5M pings/sec, as each ping needs a PostGIS query for candidate segments within 50 m. Mitigations:
- Partition `location.pings` by geographic region so workers handle only their region
- Cache the road graph in memory on workers (same adjacency list as Navigation) to avoid DB lookups for HMM transition probabilities
- Drop low-accuracy pings (accuracy_m > 50) before matching

<<<SECTION 5>>>
## 7. Geocoding Service

Converts addresses to coordinates (forward) and coordinates to addresses (reverse):
- **Forward:** "Connaught Place, Delhi" -> (28.6315, 77.2167)
- **Reverse:** (28.6315, 77.2167) -> "Connaught Place, New Delhi, Delhi 110001"

**Data model (Places):**

```pgsql
place_id        UUID, primary key
name            VARCHAR
address         TEXT
city            VARCHAR
country         VARCHAR
lat             FLOAT
long            FLOAT
location        GEOGRAPHY(POINT) [GIST spatial index]
place_type      ENUM('city', 'neighborhood', 'street', 'poi', 'address')
search_vector   TSVECTOR (PostgreSQL full-text search index)
```

Forward geocoding combines full-text search on name and address with geospatial ranking (results near the user rank higher). Reverse geocoding uses `ST_DWithin` to find the nearest address. Hot queries (major cities, landmarks) are cached in Redis with long TTLs since they rarely change.

<<<SECTION 6>>>
## 8. User Service

Manages profiles, saved places, search history, and navigation preferences.

**Users:**

```pgsql
user_id           UUID, primary key
email             VARCHAR, unique
name              VARCHAR
home_location     GEOGRAPHY(POINT)
work_location     GEOGRAPHY(POINT)
preferred_routes  JSONB (avoid highways, avoid tolls, etc)
created_at        TIMESTAMP
```

**SavedPlaces:**

```pgsql
user_id     UUID, foreign key -> Users
place_id    UUID, foreign key -> Places
label       VARCHAR (Home, Work, Favorite, etc)
saved_at    TIMESTAMP
```

Preferences (avoid highways, avoid tolls, prefer scenic routes) act as edge weight modifiers in the CH query; e.g. toll edges get much higher weight for users avoiding tolls.

## 9. Analytics Service

Processes aggregated location and routing data for BI and map quality:
- Popular routes and destinations inform infrastructure planning
- Consistently congested areas reveal road capacity issues
- Route deviation patterns (frequent off-route at one point) signal missing roads or mis-mapped one-way streets in the Map Data Store
- Search query patterns reveal places missing from the geocoding DB

Data flows Kafka -> Apache Spark batch pipeline -> S3 data lake, queried by tools like BigQuery and Redshift.

<<<SECTION 7>>>
## 10. Full Data Flow Summary

**Map tile request:** client pans/zooms and computes tile coordinates -> `GET tiles/{zoom}/{x}/{y}.png` to CDN. Hit (90%+): edge serves under 10ms. Miss: CDN fetches from S3, caches at edge, serves.

**Map data update:**
1. Ground truth operator updates road data in the Map Data Store (PostGIS).
2. Store -> Kafka (`map.data.updated` with changed bounding box).
3. Rendering pipeline: identify affected tiles at all zooms -> re-render in parallel (thousands of workers) -> store in S3 -> purge CDN for affected URLs.
4. Users see the update on next tile request.

**Location ping:**
1. Device -> Location Service (5M pings/sec) -> Kafka (`location.pings`, partitioned by region).
2. Map Matching: PostGIS candidates within 50 m -> HMM scoring (proximity + heading + transition probability) -> matched edge_id + speed -> Kafka (`location.matched`).
3. Flink: 2-minute sliding window per edge_id -> median speed, congestion level -> every 30 s `SET traffic:{edge_id} {speed, congestion}` in Redis -> on congestion change, Kafka (`traffic.updated`).
4. Navigation Service consumes `traffic.updated` -> WebSocket push to active navigators on affected routes.

**Route calculation:** Client -> API Gateway -> Navigation Service -> Geocoding (addresses to coordinates) -> load regional partitions -> bidirectional CH query -> Redis `MGET traffic:{edge_id}` for all segments (apply traffic weights) -> evaluate top 3 alternatives -> ETA (segment times + time-of-day historical patterns) -> cache `route:{origin_hash}:{dest_hash}:{time_bucket}` TTL 5min -> return route + ETA + alternatives.

**Active navigation:** device pings Navigation Service every 5 s. Deviation (off route) -> re-route from current position. Traffic change (`traffic.updated` for a route segment) -> recompute ETA; if a faster alternative exists, push a re-route suggestion via WebSocket.

<<<SECTION 8>>>
## 11. Resilience and Fault Tolerance

- **CDN absorbs 90%+ of tile traffic:** an S3 origin failure affects only the ~10% misses, and the CDN serves stale tiles for hours if S3 is down; users see slightly outdated maps, not a broken app.
- **Kafka durability:** no GPS data lost if Map Matching workers crash; they replay from Kafka offsets on recovery.
- **In-memory graph on Navigation instances:** routing continues if the PostgreSQL road graph DB is down, degrading to cached historical traffic instead of real-time, never failing completely.
- **5-minute Redis TTL on traffic:** stale data auto-expires; if the pipeline lags, Navigation falls back to historical speed models instead of showing wrong real-time data.
- **Flink checkpointing** preserves sliding-window state across worker restarts.
- **Geographic partitioning** of the road graph and Kafka pipeline isolates faults: a Southeast Asia issue doesn't affect routing in Europe.
- **Map Matching confidence threshold (0.7)** keeps corrupt GPS data out, trading slightly lower coverage for accuracy.
- **CH preprocessing is immutable** once computed: the shortcut graph is stored durably and recomputed only on significant road network changes (new highway). Daily traffic changes affect only edge weights, not structure.

<<<SECTION 9>>>
## 12. Technology Choices Summary

- **API Gateway:** Kong / AWS API Gateway (auth, rate limiting, traffic-type routing)
- **Map Tile Storage:** AWS S3 (50 PB, immutable objects, native CDN integration)
- **Tile CDN:** CloudFront / Akamai (global edge caching, 90%+ hit rate, deterministic URL cache keys)
- **Map Rendering Pipeline:** distributed workers via Kafka (parallel re-render on data change, priority queue for high-zoom tiles)
- **Map Data Store:** PostgreSQL + PostGIS (source of truth for road/geographic data, GIST spatial index)
- **Road Graph Storage:** PostgreSQL + PostGIS + in-memory adjacency list on Navigation instances (CH graph in RAM for sub-millisecond traversal)
- **Routing Algorithm:** Contraction Hierarchies with bidirectional search (offline preprocessing, millisecond queries)
- **Location Ingestion:** Apache Kafka partitioned by region (5M pings/sec, decoupled from processing)
- **Map Matching:** HMM on in-memory road graph (GPS to segment attribution, confidence threshold filtering)
- **Traffic Aggregation:** Apache Flink, 2-minute sliding windows (median speed per segment, 30-second cadence)
- **Traffic Store:** Redis, 5-minute TTL (current speed and congestion per segment, MGET for batch route lookup)
- **Traffic History:** Apache Cassandra (time-series segment speeds, partition by edge_id, cluster by time_bucket)
- **Route Cache:** Redis, 5-minute TTL (keyed by origin/destination geohash + time bucket)
- **Geocoding DB:** PostgreSQL + PostGIS + full-text index (forward/reverse geocoding, spatial ranking)
- **Active Navigation:** WebSockets (real-time route updates, traffic pushes, re-routing triggers)
- **Analytics Pipeline:** Kafka + Apache Spark + S3 data lake (batch processing of location and routing patterns)
- **User Service DB:** PostgreSQL (profiles, saved places, route preferences)
