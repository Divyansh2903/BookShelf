# Design Google Maps

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

- User location fetching (GPS coordinates from device)
- Map rendering (serving map tiles at all zoom levels)
- Route calculation (find best path between two points)
- ETA calculation (estimated time of arrival with real-time traffic)
- Real-time traffic integration
- Search for places on the map

### Out of Scope

- Street View
- Indoor maps
- Public transit routing
- Offline maps
- Google Maps Platform API for third-party developers
- Satellite imagery pipeline

### Non-Functional Requirements

- High reliability, maps must never go down
- High accuracy for routing and location
- Low latency, map tiles under 50ms, route calculation under 2 seconds
- Massive scalability, 500M DAU with 50M concurrent users
- Real-time traffic updates reflecting current road conditions within minutes

## 2. Capacity Estimation

- **DAU:** 500 million
- **Concurrent users:** 10% of DAU = 50 million
- **Location pings per second:** 50M users pinging every 10-20 seconds = ~5M QPS
- **Map tile requests per second:** 50M users x 20 tiles per interaction / 15 seconds = ~67M tile requests/second
- **CDN cache hit rate for tiles:** 90%+ (popular city tiles requested millions of times)
- **Origin tile requests after CDN:** ~7M requests/second
- **Route calculation QPS:** 10% of concurrent users calculating routes = ~2.5M QPS
- **Total map tile storage:** ~50 PB (440 PB theoretical across all zoom levels, reduced by sparse tiles for oceans, deserts, and uninhabited land)
- **Traffic data ingestion:** ~5M GPS pings/second, same as location pings

The scale here dwarfs every previous system in this series. 67 million tile requests per second makes the CDN the single most critical infrastructure component. Without a globally distributed CDN absorbing 90%+ of tile traffic, origin infrastructure would collapse instantly.

<<<SECTION 2>>>
## 3. API Gateway

All client requests enter through the API Gateway which handles authentication, rate limiting, and routing. Google Maps has several distinct traffic patterns that the Gateway must handle differently:

**Tile requests** are anonymous (no user auth needed for public map tiles), extremely high volume, and entirely read-only. The Gateway routes these directly to the Tile Service CDN layer.

**Location pings** are authenticated, high volume write operations. Rate limited per device to prevent abuse.

**Route calculations** are authenticated, computationally expensive, and relatively lower volume. Rate limited per user to prevent routing service overload.

**Search requests** are authenticated and relatively low volume. Routed to the search and geocoding services.

## 4. Map Tile System

Tile Coordinate System

The world map is divided into a grid of square tiles at 22 zoom levels (0 to 21):

- **Zoom 0:** entire world in 1 tile (256x256 pixels)
- **Zoom 1:** world in 4 tiles (2x2 grid)
- **Zoom N:** world in 4^N tiles
- **Zoom 21:** street-level detail, ~4.4 trillion tiles total

Each tile is a 256x256 pixel PNG image, roughly 100 KB each. The theoretical storage at all zoom levels is 440 PB. After excluding ocean tiles, desert tiles, and uninhabited regions (which account for roughly 70% of the Earth's surface), effective storage drops to approximately 50 PB.

Tiles are addressed by a deterministic three-component key: {zoom_level}/{x}/{y} where x and y are the tile grid coordinates at that zoom level. Any client can construct the URL for any tile without a database lookup:

[https://tiles.maps.google.com/](https://tiles.maps.google.com/){zoom}/{x}/{y}.png

This deterministic URL structure is what makes CDN caching so effective. The cache key is the URL itself.

### Map Rendering Pipeline (Offline Batch)

Tiles are pre-rendered offline from vector map data, not rendered on demand. The rendering pipeline runs when map data changes:

**Data Sources:**  
Map data comes from multiple sources that feed into the Map Data Store:

- Licensed map data providers (HERE, TomTom)
- OpenStreetMap contributions
- Ground truth operators who manually verify road changes
- User-submitted reports (road closures, new roads via the app)
- Satellite imagery analysis (ML pipeline detects new roads from aerial photos)

The Map Data Store is a specialized geospatial database (PostGIS at its core) that is the source of truth for all road, building, and geographic data.

**Rendering Flow:**  
When a new road is built in Mumbai:

1. Ground truth operator verifies the road and updates the Map Data Store
1. Map Data Store publishes [map.data](https://x.com//map.data).updated event to Kafka with the bounding box of the changed area
1. Map Rendering Pipeline consumes the event:Identifies which tiles at which zoom levels intersect the changed bounding box  
A single road change can affect thousands of tiles across zoom levels 10 to 21  
Re-renders only affected tiles, not the entire world  
Each tile rendered as a 256x256 PNG from vector map data (roads, buildings, labels, colors)
1. Rendered tiles stored in S3 under deterministic path: tiles/{zoom}/{x}/{y}.png
1. CDN cache invalidated for affected tile URLs via cache purge API
1. Users requesting those tiles get the updated version on next request

The rendering pipeline is horizontally scaled across thousands of workers since rendering is CPU-intensive but embarrassingly parallel. Each tile is rendered independently with no dependency on other tiles.

### Tile Serving via CDN

When a user pans or zooms the map, the client calculates which tile coordinates are needed for the current viewport and requests them:

GET [https://tiles.maps.google.com/15/24456/14689.png](https://tiles.maps.google.com/15/24456/14689.png)

**Cache hit (90%+ of requests):**  
CDN edge node serves the tile directly from edge cache. Latency under 10ms for users near an edge node.

**Cache miss:**  
CDN fetches from S3 origin, caches the tile at the edge, and serves it. CDN populates automatically for future requests. Latency 50-100ms.

Tiles at low zoom levels (0-10, world to country scale) are cached at every CDN edge node globally since they are requested by everyone. Tiles at high zoom levels (15-21, neighborhood to street scale) are cached at regional CDN nodes since they are only relevant to users in that geography.

### Tile Storage in S3

S3 is the origin store for all 50 PB of tile data. S3's virtually unlimited storage and native CDN integration make it the right choice. Tiles are immutable once rendered. When a tile is re-rendered due to a map data change, the new version overwrites the old S3 object at the same key, and the CDN cache is invalidated.

### Bottlenecks in the Tile System

The Map Rendering Pipeline is the bottleneck when large-scale map data changes occur (a major highway opening affects thousands of tiles at multiple zoom levels). This is mitigated by prioritizing high-zoom tiles (street level, most frequently requested) over low-zoom tiles (country level, cached for months) in the rendering queue.

The CDN is not a bottleneck at normal traffic levels but can become one during major events (earthquake emergency routing, major sporting events) when a specific geographic area sees a sudden spike in map requests. This is handled by pre-warming CDN edge nodes for expected high-traffic events.

<<<SECTION 3>>>
## 5. Navigation Service and Routing

### Graph Data Model

The road network is modeled as a directed weighted graph:

- **Nodes:** road intersections and endpoints (~500 million globally)
- **Edges:** road segments connecting intersections (~1 billion globally)
- **Edge weights:** travel time based on distance and speed limit (adjusted by real-time traffic)

### Nodes Table (PostgreSQL + PostGIS)

Nodes

```pgsql
node_id           BIGINT, primary key
lat               FLOAT
long              FLOAT
location          GEOGRAPHY(POINT, 4326) [GIST spatial index]
importance_rank   INTEGER (assigned during CH preprocessing)
node_type         ENUM('intersection', 'highway_junction', 'traffic_signal', 'roundabout')
```

### Edges Table (PostgreSQL)

Edges

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

The road graph for each region is loaded into memory on Navigation Service instances as an adjacency list. All routing queries are served from in-memory data for sub-second performance.

### Contraction Hierarchies (CH) Preprocessing

Running standard Dijkstra on a graph with 500 million nodes would take minutes per query, completely unacceptable. Contraction Hierarchies solves this with offline preprocessing:

**Importance Ranking:**  
Every node is assigned an importance rank based on:

- Road type (highway junctions rank higher than local street intersections)
- Number of shortest paths passing through the node (betweenness centrality)
- Road connectivity (nodes connecting major roads rank higher)

**Node Contraction:**  
Nodes are contracted from least important to most important. Contracting a node means removing it from the graph and adding shortcut edges between its neighbors to preserve shortest path distances:

Before contracting node B (low importance local intersection):  
A --5km--> B --3km--> C  
  
After contracting B:  
A --8km--> C (shortcut edge added, B removed)

After contracting all low-importance nodes, the remaining graph contains only high-importance nodes (major highway junctions, arterial road intersections). A Mumbai to Delhi query traverses this contracted graph of 10M nodes rather than 500 million.

Shortcut edges are stored in the Edges table with is_shortcut = true and shortcut_via pointing to the contracted node. Path reconstruction expands shortcuts back into original road segments for turn-by-turn directions.

Full Routing Flow: Bandra to Connaught Place

**Step 1 - Geocoding**  
Navigation Service calls Geocoding Service to convert addresses to coordinates:

- Bandra, Mumbai -> (19.0544, 72.8375)
- Connaught Place, Delhi -> (28.6315, 77.2167)

**Step 2 - Graph Partition Loading**  
The world graph is partitioned into regional tiles. Navigation Service identifies partitions the route passes through (Maharashtra, Madhya Pradesh, Rajasthan, Delhi) and loads only those partitions into memory for this query.

**Step 3 - Contraction Hierarchies Query**  
Navigation Service runs a bidirectional CH search:

**Forward search** from Bandra expands upward through increasingly important nodes:  
Local streets -> SV Road -> Bandra-Worli Sea Link -> Western Express Highway -> NH48

**Backward search** from Connaught Place expands upward through increasingly important nodes:  
Local streets -> Ring Road -> NH48

Both searches meet on NH48 somewhere in Rajasthan. The meeting point is found and the path is reconstructed by expanding all shortcut edges back into original road segments.

**Step 4 - Traffic Layer Applied**  
The CH query gives the geometrically optimal path. Traffic adjusts edge weights in real time. Navigation Service fetches current speeds for all road segments on the computed route from Redis:

MGET traffic:segment_1 traffic:segment_2 ... traffic:segment_N

Travel times are recomputed using current speeds. If the optimal geometric path is heavily congested, the top 3 alternative routes are evaluated and the truly fastest route by time is returned.

### Step 5 - ETA Calculation

ETA = SUM(segment_distance_km / current_speed_kmh) for all segments  
    + estimated delay at traffic signals (historical average per signal)  
    + time-of-day adjustment (6pm Friday is slower than 2am Sunday on the same route)

Historical speed patterns are stored per road segment per hour per day of week. A route computed at 5:30pm on Friday uses Friday evening historical speeds for segments the user will reach in 2 hours, not current speeds.

**Step 6 - Route Caching**  
Computed routes are cached in Redis:

Key: route:{origin_geohash_p6}:{dest_geohash_p6}:{time_bucket_5min}  
Value: { waypoints, segment_ids, base_eta, alternative_routes }  
TTL: 5 minutes

Routes stale quickly due to traffic changes. 5-minute TTL balances freshness with computation cost.

**Step 7 - Active Navigation and Re-routing**  
During navigation, the client sends location pings every 5 seconds. Navigation Service monitors:

- **Deviation detection:** user has left the planned route
- **Traffic change detection:** a segment on the route has become significantly more congested

Either condition triggers re-routing from the user's current position using the same CH query.

Bottlenecks in the Navigation Service

The CH query itself is fast (milliseconds on the preprocessed graph). The bottleneck is loading regional graph partitions into memory for very long routes that cross many partitions. This is mitigated by keeping all partitions pre-loaded on Navigation Service instances with sufficient RAM. A Navigation Service instance for South Asia keeps the entire South Asia graph in memory and never loads it on demand.

<<<SECTION 4>>>
## 6. Location Service and Traffic Pipeline

Location Ingestion

Every user with navigation or location sharing active sends a GPS ping every 10-20 seconds:

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

Location Service receives 5 million pings per second and immediately publishes to Kafka topic location.pings partitioned by user_id. The Location Service itself is stateless and horizontally scalable. Kafka absorbs the write burst and decouples ingestion from processing.

### Map Matching Service

Raw GPS coordinates cannot be attributed to road segments directly due to GPS error (5-10 meters) and ambiguity (multiple roads within error radius). The Map Matching Service snaps each GPS ping to the correct road segment using a Hidden Markov Model (HMM).

**The Problem:**  
A user sends ping at (19.0721, 72.8846) with heading 270 degrees (westbound). Three road segments are within 15 meters:

- Western Express Highway flyover (westbound)
- SV Road below the flyover (westbound)
- A service road alongside SV Road (eastbound only)

Which segment gets the 45 kmh speed update?

**HMM Map Matching:**  
The HMM scores each candidate segment using three signals simultaneously:

**Signal 1 - Proximity:** Closer segments score higher. GPS accuracy (8 meters reported) defines the probability distribution around the reported coordinate.

**Signal 2 - Heading alignment:** User heading (270 degrees, westbound) must match the segment direction. Eastbound-only segments are eliminated. Westbound segments score higher.

**Signal 3 - Transition probability:** Given the user was on segment X in the previous ping (15 seconds ago), what is the probability they are now on segment Y? The HMM uses road network topology to eliminate physically impossible transitions. A user cannot teleport from the flyover to a road 500 meters away in 15 seconds.

The highest-scoring segment wins. Low confidence matches (below 0.7 threshold) are discarded rather than corrupting traffic data.

### Map Matching Service Output:

```json
{
  "edge_id": "highway_segment_447",
  "speed_kmh": 45,
  "timestamp": 1726123456,
  "confidence": 0.94
}
```

Output published to Kafka topic location.matched.

### Traffic Aggregation with Apache Flink

The Traffic Service consumes from location.matched using Apache Flink for real-time stream processing. Rather than writing to Redis on every single ping (5 million Redis writes per second would be catastrophic), Flink aggregates using a sliding time window:

Window: 2-minute sliding window per road segment  
Aggregation: median speed of all matched pings on this segment in the window  
Update frequency: every 30 seconds

Median rather than average filters outliers. A stationary GPS ping (0 kmh from a user stopped at a red light) does not make a flowing highway appear congested when 50 other pings show 80 kmh.

### Congestion Level Computation:

def congestion_level(current_speed, free_flow_speed):  
    ratio = current_speed / free_flow_speed  
    if ratio > 0.8:  return 'free_flow'  
    if ratio > 0.6:  return 'light'  
    if ratio > 0.4:  return 'moderate'  
    if ratio > 0.2:  return 'heavy'  
    return 'standstill'

```python
{
  "edge_id": "highway_segment_447",
  "speed_kmh": 45,
  "timestamp": 1726123456,
  "confidence": 0.94
}
```

free_flow_speed is the historical average speed for that segment at the current time of day and day of week.

### Redis Update:

Key: traffic:{edge_id}  
Value: { current_speed_kmh: 45, free_flow_speed: 80, congestion_level: 'light', updated_at: timestamp }  
TTL: 5 minutes

If no pings arrive for a segment within 5 minutes, the Redis key expires and Navigation Service falls back to historical speed data for route calculations.

**Traffic Broadcast to Active Navigators:**  
When Flink detects significant congestion change on a segment (congestion level changes by one level), it publishes traffic.updated to Kafka. Navigation Service consumes this and pushes updates via WebSocket to all users whose active routes include that segment.

### Location Data Storage

Raw GPS pings are not stored permanently. Only aggregated traffic data (road segment speeds) is persisted in a time-series store:

### TrafficHistory Table (Cassandra)

TrafficHistory

```pgsql
edge_id           BIGINT, partition key
time_bucket       TIMESTAMP (rounded to 5 minutes), clustering key
avg_speed_kmh     FLOAT
congestion_level  TEXT
sample_count      INTEGER
```

Partitioning by edge_id and clustering by time_bucket makes time-range queries for historical speed patterns extremely fast. This data feeds the historical speed model used for ETA calculations.

### Bottlenecks in the Traffic Pipeline

The Map Matching Service is the primary bottleneck at 5 million pings per second. Each ping requires a PostGIS spatial query to find candidate road segments within 50 meters. This is mitigated by:

- Partitioning the Kafka location.pings topic by geographic region so Map Matching workers only handle pings from their assigned region
- Caching the road network graph in memory on Map Matching workers (same adjacency list as Navigation Service) to avoid database lookups for the HMM transition probabilities
- Discarding low-accuracy pings (accuracy_m > 50) before map matching to reduce volume

<<<SECTION 5>>>
## 7. Geocoding Service

Geocoding converts human-readable addresses to coordinates (forward geocoding) and coordinates to addresses (reverse geocoding).

**Forward geocoding:** "Connaught Place, Delhi" -> (28.6315, 77.2167)  
 **Reverse geocoding:** (28.6315, 77.2167) -> "Connaught Place, New Delhi, Delhi 110001"

Data Model

Places

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

Forward geocoding uses a combination of full-text search on name and address fields plus geospatial ranking (results near the user's current location rank higher). Reverse geocoding uses ST_DWithin to find the nearest address to a coordinate.

Hot geocoding queries (major cities, famous landmarks) are cached in Redis with long TTLs since these change rarely.

<<<SECTION 6>>>
## 8. User Service

Manages user profiles, saved places, search history, and navigation preferences.

Users

```pgsql
user_id           UUID, primary key
email             VARCHAR, unique
name              VARCHAR
home_location     GEOGRAPHY(POINT)
work_location     GEOGRAPHY(POINT)
preferred_routes  JSONB (avoid highways, avoid tolls, etc)
created_at        TIMESTAMP
```

### SavedPlaces Table:

SavedPlaces

```pgsql
user_id     UUID, foreign key -> Users
place_id    UUID, foreign key -> Places
label       VARCHAR (Home, Work, Favorite, etc)
saved_at    TIMESTAMP
```

User preferences (avoid highways, avoid tolls, prefer scenic routes) are applied as edge weight modifiers during the CH routing query. A toll road edge gets a significantly higher weight for users who prefer to avoid tolls.

## 9. Analytics Service

The Analytics Service processes aggregated location and routing data for business intelligence and map quality improvement:

- Popular routes and destination patterns inform infrastructure planning
- High congestion areas consistently identify road capacity issues
- Route deviation patterns (users frequently going off-route at a specific point) signal missing roads or incorrectly mapped one-way streets in the Map Data Store
- Search query patterns identify missing places in the geocoding database

Analytics data flows from Kafka through an Apache Spark batch pipeline to a data lake in S3. Standard analytics tools (BigQuery, Redshift) query the data lake for reporting.

<<<SECTION 7>>>
## 10. Full Data Flow Summary

Map Tile Request Flow:  
Client pans/zooms map -> calculates needed tile coordinates  
Client -> CDN: GET tiles/{zoom}/{x}/{y}.png  
    Cache hit (90%+): CDN edge serves tile under 10ms  
    Cache miss: CDN fetches from S3 origin, caches at edge, serves tile  
  
Map Data Update Flow:  
Ground truth operator updates road data -> Map Data Store (PostGIS)  
Map Data Store -> Kafka ([map.data](https://x.com//map.data).updated with changed bounding box)  
Map Rendering Pipeline:  
    -> Identify affected tiles at all zoom levels  
    -> Re-render affected tiles in parallel (thousands of workers)  
    -> Store updated tiles in S3  
    -> Purge CDN cache for affected tile URLs  
Users see updated map on next tile request  
  
Location Ping Flow:  
User device -> Location Service (5M pings/second)  
    -> Kafka (location.pings, partitioned by region)  
    -> Map Matching Service:  
        -> PostGIS: find candidate road segments within 50m  
        -> HMM: score candidates by proximity + heading + transition probability  
        -> Output: matched edge_id + speed  
    -> Kafka (location.matched)  
    -> Apache Flink:  
        -> 2-minute sliding window per edge_id  
        -> Compute median speed, congestion level  
        -> Every 30 seconds: Redis SET traffic:{edge_id} {speed, congestion}  
        -> On congestion change: Kafka (traffic.updated)  
    -> Navigation Service consumes traffic.updated  
        -> WebSocket push to active navigators on affected routes  
  
Route Calculation Flow:  
Client -> API Gateway -> Navigation Service  
    -> Geocoding Service: addresses to coordinates  
    -> Load regional graph partitions into memory  
    -> Bidirectional CH query on preprocessed graph  
    -> Redis MGET traffic:{edge_id} for all route segments (apply traffic weights)  
    -> Evaluate top 3 alternative routes  
    -> ETA calculation (segment times + time-of-day historical patterns)  
    -> Cache route: Redis route:{origin_hash}:{dest_hash}:{time_bucket} TTL 5min  
    -> Return route + ETA + alternatives to client  
  
Active Navigation Flow:  
User navigating -> device sends ping every 5 seconds to Navigation Service  
Navigation Service monitors:  
    -> Deviation: user off route -> trigger re-route from current position  
    -> Traffic change: traffic.updated event for segment on route  
        -> Recompute ETA with new traffic data  
        -> If faster alternative exists: push re-route suggestion via WebSocket

<<<SECTION 8>>>
## 11. Resilience and Fault Tolerance

**CDN absorbs 90%+ of tile traffic** making the Tile Service extremely resilient. S3 origin failure only affects the 10% cache miss traffic. CDN serves stale tiles for hours if S3 is temporarily unavailable, users see slightly outdated map data rather than a broken experience.

**Kafka durability** for location pings means no GPS data is lost even if Map Matching workers crash. Workers replay from Kafka offsets on recovery, catching up on missed pings.

**In-memory graph on Navigation Service instances** means routing continues even if the PostgreSQL road graph database is temporarily unavailable. Route calculations degrade to using cached historical traffic rather than real-time traffic but never fail completely.

**Redis TTL on traffic data (5 minutes)** means stale traffic data auto-expires. If the traffic pipeline lags, Navigation Service automatically falls back to historical speed models rather than showing incorrect real-time data.

**Flink stateful stream processing** maintains sliding window state across restarts using Flink's checkpointing mechanism. A Flink worker restart does not lose the aggregation window state.

**Geographic partitioning** of both the road graph and the Kafka location pipeline provides fault isolation. A regional infrastructure issue in Southeast Asia does not affect routing in Europe.

**Map Matching confidence threshold (0.7)** prevents corrupt GPS data from polluting traffic data. Low confidence matches are discarded, accepting slightly reduced traffic data coverage in exchange for higher accuracy.

**CH preprocessing is immutable** once computed. The preprocessed graph with shortcut edges is stored durably and only needs recomputation when the road network changes significantly (new highway built). Day-to-day traffic changes only affect edge weights, not graph structure.

<<<SECTION 9>>>
## 12. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, traffic type routing)

**Map Tile Storage** -> AWS S3 (50 PB tile storage, immutable objects, native CDN integration)

**Tile CDN** -> CloudFront / Akamai (Global edge caching, 90%+ hit rate, deterministic URL cache keys)

**Map Rendering Pipeline** -> Distributed rendering workers via Kafka (Parallel tile rendering on map data change, priority queue for high-zoom tiles)

**Map Data Store** -> PostgreSQL + PostGIS (Source of truth for all road and geographic data, GIST spatial index)

**Road Graph Storage** -> PostgreSQL + PostGIS + in-memory adjacency list on Navigation Service instances (CH preprocessed graph loaded into RAM for sub-millisecond traversal)

**Routing Algorithm** -> Contraction Hierarchies with bidirectional search (Preprocessed offline, query in milliseconds on contracted graph)

**Location Ingestion** -> Apache Kafka partitioned by region (5M pings/second, decoupled from processing)

**Map Matching** -> Hidden Markov Model on in-memory road graph (GPS coordinate to road segment attribution, confidence threshold filtering)

**Traffic Aggregation** -> Apache Flink with 2-minute sliding windows (Median speed per segment, 30-second update cadence)

**Traffic Store** -> Redis with 5-minute TTL (Current speed and congestion per road segment, MGET for batch route traffic lookup)

**Traffic History** -> Apache Cassandra (Time-series road segment speeds, partition by edge_id, cluster by time_bucket)

**Route Cache** -> Redis with 5-minute TTL (Cached routes keyed by origin/destination geohash + time bucket)

**Geocoding DB** -> PostgreSQL + PostGIS + full-text search index (Forward and reverse geocoding, spatial ranking)

**Active Navigation** -> WebSockets (Real-time route updates, traffic change pushes, re-routing triggers)

**Analytics Pipeline** -> Apache Kafka + Apache Spark + S3 data lake (Batch processing of location and routing patterns)

**User Service DB** -> PostgreSQL (User profiles, saved places, route preferences)

### That's all, folks, Cheers!!!
