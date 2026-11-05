# System Design Of A Proximity Service

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

- Search for businesses within a given radius (lat, long, radius up to 20 km)
- Return results ranked by distance
- Business CRUD operations (add, edit, delete listings)
- Business detail page (name, address, category, rating, photos, hours)
- Support category filtering (restaurants, cafes, ATMs, pharmacies)

### Out of Scope

- Real-time location tracking (Uber driver movement)
- Routing and navigation (Google Maps directions)
- Reviews and ratings
- Ads and sponsored listings
- Personalization and recommendations

### Non-Functional Requirements

- Low latency search under 100ms
- High availability, search must never go down
- Read/write ratio of approximately 50:1, heavily optimized for reads
- Location accuracy within a few hundred meters
- Cache hit rate above 80% for common search patterns
- Eventual consistency acceptable for new business listings (appears within seconds)
- Strong consistency required for business deletions (removed immediately from results)

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 100 million
- **Searches per user per day:** 5
- **Total search QPS:** 100M x 5 / 86,400 = ~5000 QPS
- **Total businesses globally:** ~200 million
- **Write QPS:** 5% of 200M businesses update regularly = 10M updates/day / 86,400 = ~100 QPS
- **Read/write ratio:** 5000:100 = 50:1
- **Business table size:** 200M rows x 200 bytes per row = ~40 GB for core data
- **PostGIS spatial index size:** ~10-20 GB additional
- **Total in memory:** ~60 GB, fits comfortably in a modern database server buffer pool

The system is overwhelmingly read-heavy. The spatial index for 200 million businesses fits in memory, meaning PostGIS radius queries never touch disk on the hot path. Caching geohash-bucketed search results further reduces PostGIS load to cache misses only.

## 3. API Design

Search API

GET /v1/search?lat=19.0760&long=72.8777&radius=5&category=restaurant&limit=20  
  
Response:

```
{
  "businesses": [
    {
      "business_id": "biz_123",
      "name": "Cafe Madras",
      "address": "12 SV Road, Bandra, Mumbai",
      "category": "restaurant",
      "distance_km": 0.8,
      "rating": 4.3,
      "photo_url": "https://cdn.proximity.com/..."
    }
  ],
  "total": 47,
  "returned": 20
}
```

Business CRUD APIs

POST   /v1/businesses              (create new listing)  
GET    /v1/businesses/{id}         (get business details)  
PUT    /v1/businesses/{id}         (update business)  
DELETE /v1/businesses/{id}         (delete business)

<<<SECTION 3>>>
## 4. High Level Services

The proximity service is intentionally lean. It is a platform component, not a full product, and three services cover the full design:

**Search Service** takes lat, long, radius, and category from the client, orchestrates the full search flow, handles caching, computes distances, and returns ranked results.

**Location Service** handles pure geospatial queries against PostGIS. Its only job is to return business IDs within a given radius. It knows nothing about caching or ranking.

**Business Service** handles CRUD operations for business owners, manages business metadata in PostgreSQL, and triggers cache invalidation on updates.

## 5. Geospatial Storage - PostGIS

Why PostGIS Over Other Approaches

Several geospatial techniques exist for proximity queries:

**Geohashing** converts coordinates to a string prefix. Fast for cache keys and CDN patterns but uses rectangular cells rather than true circles, causing inaccuracy at cell boundaries.

**Redis GEO** is in-memory and extremely fast but expensive at 200 million business scale and lacks persistence guarantees. Redis GEO was the right choice for Tinder because users move constantly and location updates are extremely frequent. Businesses rarely move so persistence and accuracy matter more.

**Quadtree** dynamically partitions space based on data density, great for unevenly distributed data but complex to implement and maintain.

**PostGIS** is a spatial extension for PostgreSQL that adds native geographic data types and an R-tree spatial index. It supports true circle radius queries via ST_DWithin, is accurate, persistent, and horizontally scalable via PostgreSQL read replicas.

For a proximity service finding static businesses, PostGIS wins on accuracy, simplicity, and operational familiarity.

Businesses Table (PostgreSQL with PostGIS)

Businesses

```pgsql
business_id     UUID, primary key
name            VARCHAR
address         TEXT
category        VARCHAR (restaurant, cafe, atm, pharmacy, etc)
lat             FLOAT
long            FLOAT
location        GEOGRAPHY(POINT, 4326) (PostGIS geometry column)
geohash         VARCHAR(6) (precision 6, ~1km x 1km cell, computed from lat/long)
rating          FLOAT
is_active       BOOLEAN
created_at      TIMESTAMP
updated_at      TIMESTAMP
```

The location column stores coordinates as a PostGIS GEOGRAPHY type. A spatial index is created on this column:

```pgsql
CREATE INDEX idx_businesses_location ON Businesses USING GIST(location);
```

The GIST index is an R-tree spatial index. PostGIS uses it to efficiently narrow down candidates before computing exact distances, making radius queries fast even across 200 million rows.

The geohash column (precision 6, roughly 1 km x 1 km cells) is a computed column used as the cache key for search results. It is indexed separately for fast cache key lookups:

CREATE INDEX idx_businesses_geohash ON Businesses(geohash);

```pgsql
CREATE INDEX idx_businesses_location ON Businesses USING GIST(location);
```

PostGIS Radius Query

```pgsql
SELECT
    business_id,
    name,
    address,
    category,
    rating,
    lat,
    long,
    ST_Distance(
        location::geography,
        ST_MakePoint(72.8777, 19.0760)::geography
    ) AS distance_meters
FROM Businesses
WHERE
    ST_DWithin(
        location::geography,
        ST_MakePoint(72.8777, 19.0760)::geography,
        5000  -- 5 km in meters
    )
    AND category = 'restaurant'
    AND is_active = true
ORDER BY distance_meters ASC
LIMIT 50;
```

ST_DWithin uses the GIST spatial index to find candidates efficiently. ST_Distance computes the exact distance for each candidate. The combination is fast -- the spatial index filters most of the 200 million rows before exact distance is computed.

Scaling PostGIS

PostGIS reads are served by PostgreSQL read replicas. All 5000 read QPS go to read replicas. Write QPS (100) go to the primary. The spatial index on each read replica fits in memory, so hot path queries never touch disk.

For extreme scale, the Businesses table can be sharded geographically -- a shard for Asia, Europe, Americas -- since proximity queries are always regional and never cross-continental.

<<<SECTION 4>>>
## 6. Caching Strategy

The 50:1 read/write ratio makes caching essential. Two cache layers handle different parts of the search flow.

### Level 1 - Search Result Cache (Geohash-Bucketed)

Raw lat/long coordinates cannot be used as cache keys -- two users searching from slightly different positions within the same neighborhood would produce different cache keys and both miss the cache. The solution is to bucket searches by **geohash at precision 6**.

A precision-6 geohash cell is roughly 1.2 km x 0.6 km. Two users within the same cell get the same cached search results. This dramatically increases cache hit rate for dense urban areas where many users search the same neighborhoods.

Key: search:{geohash_p6}:{radius_km}:{category}  
Value: Redis SET of business_ids  
TTL: 10 minutes

Example:

Key: search:te7u3x:5:restaurant  
Value: {biz_123, biz_456, biz_789, biz_101, ...}  
TTL: 10 minutes

The value is a Redis SET rather than a plain list because surgical addition and removal of individual business IDs is needed for cache invalidation without invalidating the entire key.

### Level 2 - Business Object Cache

Search results return business IDs. Full business details are hydrated from a separate business object cache:

Key: business:{business_id}  
Value: { name, address, category, rating, hours, photo_url, lat, long }  
TTL: 24 hours

When a search returns 20 business IDs, all 20 business objects are fetched in a single Redis MGET call:

MGET business:biz_123 business:biz_456 business:biz_789 ...

Single round trip, all 20 records fetched simultaneously. On cache miss for any business, falls back to PostgreSQL and writes back to Redis.

### Cache Key Design for Multiple Radii

A search for 5 km and a search for 10 km from the same geohash cell produce different result sets. The radius is included in the cache key:

search:te7u3x:5:restaurant    (5 km search)  
search:te7u3x:10:restaurant   (10 km search)  
search:te7u3x:20:restaurant   (20 km search)  
search:te7u3x:5:cafe          (different category)

Each combination gets its own cache entry.

<<<SECTION 5>>>
## 7. Full Search Flow

When a user searches "coffee shops near Bandra, Mumbai, within 5 km":

### Step 1 - Request received

GET /v1/search?lat=19.0544&long=72.8375&radius=5&category=cafe&limit=20

Search Service receives the request via API Gateway.

**Step 2 - Compute geohash cache key**  
Search Service computes the precision-6 geohash from the user's coordinates:

geohash(19.0544, 72.8375, precision=6) -> "te7u3x"

Cache key: search:te7u3x:5:cafe

### Step 3 - Redis cache check

SMEMBERS search:te7u3x:5:cafe

**Cache hit:** Redis returns a SET of business IDs. Skip to Step 5.

**Cache miss:** proceed to Step 4.

**Step 4 - PostGIS query (cache miss only)**  
Search Service calls Location Service with coordinates, radius, and category.

Location Service runs PostGIS query against a read replica:

```pgsql
SELECT business_id, lat, long
FROM Businesses
WHERE ST_DWithin(location::geography, ST_MakePoint(72.8375, 19.0544)::geography, 5000)
AND category = 'cafe'
AND is_active = true
LIMIT 50;
```

Results written to Redis:

SADD search:te7u3x:5:cafe biz_123 biz_456 biz_789 ...  
EXPIRE search:te7u3x:5:cafe 600

**Step 5 - Business object hydration**  
Fetch full business details for all returned business IDs via Redis MGET:

MGET business:biz_123 business:biz_456 business:biz_789 ...

On cache miss for any individual business, fetch from PostgreSQL and populate Redis.

**Step 6 - Distance computation and ranking**  
For each business, compute Haversine distance between user coordinates and business coordinates (available from the business object cache):

```python
def haversine(user_lat, user_long, biz_lat, biz_long):
    R = 6371
    dlat = radians(biz_lat - user_lat)
    dlong = radians(biz_long - user_long)
    a = sin(dlat/2)**2 + cos(radians(user_lat)) * cos(radians(biz_lat)) * sin(dlong/2)**2
    return R * 2 * asin(sqrt(a))
```

Sort results by distance ascending. Return top 20.

Distance is computed in the application layer because it is relative to each user's exact coordinates. Even two users in the same geohash cell are at slightly different positions, producing different distances to the same business. Pre-sorting in Redis or PostGIS is not possible for cached results.

**Step 7 - Response**  
Return ranked list of businesses with name, address, category, distance, rating, and photo URL.

Total latency breakdown:

- Redis cache hit: ~5ms (SMEMBERS + MGET)
- Redis cache miss + PostGIS: ~30-50ms (PostGIS spatial query on read replica)
- Application layer distance sort: ~1ms
- Total end-to-end: under 100ms for both cache hit and miss paths

<<<SECTION 6>>>
## 8. Business Service - Write Flow

New Business Listing

When a business owner submits a new listing:

1. Business Service validates input (valid coordinates, required fields, category within allowed enum)
1. Compute geohash from lat/long: geohash(lat, long, precision=6)
1. INSERT into Businesses table in PostgreSQL:

```pgsql
INSERT INTO Businesses (business_id, name, address, category, lat, long,
       location, geohash, rating, is_active, created_at)
   VALUES (gen_random_uuid(), 'Cafe Madras', '12 SV Road...', 'restaurant',
       19.0544, 72.8375, ST_MakePoint(72.8375, 19.0544)::geography,
       'te7u3x', 0.0, true, NOW());
```

1. Publish business.created event to Kafka
1. Cache Update Worker consumes event:SET business:{business_id} {full business object} with 24-hour TTL  
SADD search:{geohash}:\*:{category} business_id (only for cache keys that already exist)
1. Business is searchable within seconds

Database first, then cache update. This prevents the broken experience of a business appearing in search results before its database record exists.

Business Update (Non-Location Change)

When a business updates name, hours, or photos but not coordinates:

1. UPDATE Businesses table in PostgreSQL
1. Publish business.updated event to Kafka
1. Cache Invalidation Worker:DEL business:{business_id} (invalidate business object cache)  
Search result cache keys are NOT invalidated (business ID remains valid in search results)  
Business object cache repopulated on next fetch

### Business Location Update (Address Change)

When a business moves to a new address with new coordinates:

1. Compute old geohash (from existing database record) and new geohash (from new coordinates)
1. UPDATE Businesses table with new lat, long, location, geohash
1. Publish business.location_updated event to Kafka with both old and new geohash
1. Cache Invalidation Worker:Scan Redis keys matching search:{old_geohash}:\*  
SREM search:{old_geohash}:{radius}:{category} business_id for each matching key  
DEL business:{business_id} (invalidate business object cache)  
SADD search:{new_geohash}:{radius}:{category} business_id for each matching new geohash cache key that already exists  
Business object cache repopulated on next fetch

Surgical SREM on individual business IDs rather than deleting entire cache keys prevents cache stampedes on high-traffic geohash cells.

### Business Deletion

When a business is deleted:

1. UPDATE Businesses SET is_active = false (soft delete)
1. Publish business.deleted event to Kafka
1. Cache Invalidation Worker:Scan Redis keys matching search:{geohash}:\*  
SREM the business ID from all matching search cache keys  
DEL business:{business_id} (delete business object cache)
1. Business disappears from search results immediately (next search query gets SADD-cleaned set)

Soft delete rather than hard delete preserves the record for audit purposes and makes recovery possible if a business is accidentally deleted. Hard delete happens in a background cleanup job after 30 days.

<<<SECTION 7>>>
## 9. Data Model Summary

### Businesses Table (PostgreSQL + PostGIS)

Businesses

```pgsql
business_id     UUID, primary key
name            VARCHAR
address         TEXT
category        VARCHAR
lat             FLOAT
long            FLOAT
location        GEOGRAPHY(POINT, 4326) [GIST spatial index]
geohash         VARCHAR(6) [B-tree index]
rating          FLOAT
phone           VARCHAR
website         VARCHAR
hours           JSONB (opening hours per day)
is_active       BOOLEAN
created_at      TIMESTAMP
updated_at      TIMESTAMP
```

### BusinessPhotos Table (PostgreSQL)

BusinessPhotos

```pgsql
photo_id        UUID, primary key
business_id     UUID, foreign key -> Businesses
s3_url          TEXT
order_index     INTEGER
uploaded_at     TIMESTAMP
```

Photos stored in S3 and served via CDN. Photo URLs included in the business object cache so no separate photo fetch is needed at search time.

<<<SECTION 8>>>
## 10. Full Data Flow Summary

Search Flow (Cache Hit):  
Client -> API Gateway -> Search Service  
    -> Compute geohash from lat/long (precision 6)  
    -> Redis SMEMBERS search:{geohash}:{radius}:{category} (cache hit)  
    -> Redis MGET business:biz_1 business:biz_2 ... (hydrate objects)  
    -> Application layer Haversine distance computation  
    -> Sort by distance ascending, return top 20  
    -> Total latency: ~5ms  
  
Search Flow (Cache Miss):  
Client -> API Gateway -> Search Service  
    -> Compute geohash from lat/long  
    -> Redis SMEMBERS (cache miss)  
    -> Location Service -> PostGIS ST_DWithin query on read replica  
    -> Redis SADD search:{geohash}:{radius}:{category} {business_ids} (populate cache)  
    -> Redis MGET (hydrate business objects)  
    -> Application layer distance sort  
    -> Return top 20  
    -> Total latency: ~30-50ms  
  
New Business Listing Flow:  
Business owner -> API Gateway -> Business Service  
    -> Validate input  
    -> Compute geohash  
    -> INSERT into PostgreSQL Businesses table  
    -> Kafka (business.created)  
    -> Cache Update Worker:  
        -> SET business:{business_id} {object} TTL 24h  
        -> SADD search:{geohash}:\*:{category} business_id (existing keys only)  
    -> Business searchable within seconds  
  
Business Location Update Flow:  
Business owner -> API Gateway -> Business Service  
    -> Fetch old geohash from PostgreSQL  
    -> Compute new geohash from new coordinates  
    -> UPDATE PostgreSQL (new lat, long, location, geohash)  
    -> Kafka (business.location_updated with old + new geohash)  
    -> Cache Invalidation Worker:  
        -> SREM from all search:{old_geohash}:\* keys (surgical removal)  
        -> DEL business:{business_id}  
        -> SADD to all search:{new_geohash}:\* keys (existing keys only)  
  
Business Deletion Flow:  
Business owner -> API Gateway -> Business Service  
    -> UPDATE is_active = false  
    -> Kafka (business.deleted)  
    -> Cache Invalidation Worker:  
        -> SREM from all search:{geohash}:\* keys  
        -> DEL business:{business_id}  
    -> Business disappears from search results immediately

<<<SECTION 9>>>
## 11. Resilience and Fault Tolerance

**PostGIS read replicas** ensure search queries continue even if the primary database fails. All 5000 read QPS go to replicas. Primary failure only affects write operations (100 QPS) which queue in Kafka until the primary recovers or a replica is promoted.

**Redis caching** means the vast majority of search queries never reach PostGIS. A PostGIS slowdown degrades cache miss performance but cache hit performance (80%+ of traffic) is unaffected.

**Kafka durability** for all business write events means cache invalidation and update operations are never lost even if the Cache Invalidation Worker crashes. Workers replay from Kafka offsets on recovery.

**Soft delete** for business deletions means accidental deletions are recoverable. Hard deletes happen only after a 30-day grace period via a background cleanup job.

**Surgical cache invalidation with SREM** prevents cache stampedes on high-traffic geohash cells. Removing one business from a cached result set does not invalidate results for hundreds of other businesses in the same cell.

**Geographic database sharding** (Asia, Europe, Americas shards) provides fault isolation across regions. A database issue in one region does not affect proximity searches in other regions.

**Short PostGIS query TTL on cache (10 minutes)** means stale search results (newly added businesses not yet in cache) self-correct within 10 minutes at most without any explicit invalidation needed.

<<<SECTION 10>>>
## 12. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, routing)

**Geospatial DB** -> PostgreSQL + PostGIS extension (R-tree GIST spatial index, ST_DWithin for true circle radius queries, 200M business rows fitting in memory)

**Search Result Cache** -> Redis SET per geohash cell (SMEMBERS for fast retrieval, SADD/SREM for surgical invalidation without stampede)

**Business Object Cache** -> Redis MGET (Batch hydration of full business details in single round trip)

**Distance Ranking** -> Application layer Haversine computation (Per-user distance, cannot be pre-sorted, microsecond in-memory sort on 20-50 results)

**Geohash Cache Key** -> Precision-6 geohash (1.2km x 0.6km cells, dramatically increases cache hit rate vs raw coordinates)

**Photo Storage** -> AWS S3 + CDN (Business photos served from edge nodes, high cache hit rate since photos change rarely)

**Write Decoupling** -> Apache Kafka (Business create/update/delete events, cache invalidation workers, reliable delivery)

**Database Scaling** -> PostgreSQL read replicas (5000 read QPS distributed across replicas, writes to primary at 100 QPS)

**Geographic Sharding** -> Regional PostgreSQL clusters (Asia, Europe, Americas, fault isolation across regions)

That's all, folks..Cheers!!
