# System Design Of A Proximity Service

<<<SECTION 1>>>
## 1. Requirements

**Functional:**
- Search businesses within a radius (lat, long, radius up to 20 km)
- Rank results by distance
- Business CRUD (add, edit, delete listings)
- Detail page (name, address, category, rating, photos, hours)
- Category filtering (restaurants, cafes, ATMs, pharmacies)

**Out of scope:** real-time location tracking (Uber driver movement), routing and navigation (Google Maps directions), reviews and ratings, ads and sponsored listings, personalization and recommendations.

**Non-functional:**
- Search latency under 100ms
- High availability; search never goes down
- Read/write ratio ~50:1, optimized for reads
- Location accuracy within a few hundred meters
- Cache hit rate above 80% for common searches
- Eventual consistency OK for new listings (appear within seconds)
- Strong consistency for deletions (removed immediately)

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 100M, 5 searches/user/day
- **Search QPS:** 100M x 5 / 86,400 = ~5000
- **Businesses:** ~200M globally
- **Write QPS:** 5% of 200M update regularly = 10M/day / 86,400 = ~100
- **Read/write:** 5000:100 = 50:1
- **Business table:** 200M x 200 bytes = ~40 GB core data
- **PostGIS spatial index:** ~10-20 GB more
- **Total in memory:** ~60 GB, fits in a modern DB server's buffer pool

The system is overwhelmingly read-heavy. The spatial index fits in memory, so PostGIS radius queries never touch disk on the hot path, and geohash-bucketed result caching limits PostGIS load to cache misses.

## 3. API Design

**Search API**

`GET /v1/search?lat=19.0760&long=72.8777&radius=5&category=restaurant&limit=20`

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

**Business CRUD APIs**

- `POST /v1/businesses` (create listing)
- `GET /v1/businesses/{id}` (details)
- `PUT /v1/businesses/{id}` (update)
- `DELETE /v1/businesses/{id}` (delete)

<<<SECTION 3>>>
## 4. High Level Services

The service is a lean platform component, not a full product; three services cover it:

- **Search Service:** takes lat, long, radius, category; orchestrates search, handles caching, computes distances, returns ranked results.
- **Location Service:** pure geospatial queries against PostGIS; only returns business IDs within a radius. Knows nothing of caching or ranking.
- **Business Service:** CRUD for owners, metadata in PostgreSQL, triggers cache invalidation on updates.

## 5. Geospatial Storage - PostGIS

**Why PostGIS over other approaches:**
- **Geohashing** converts coordinates to a string prefix. Fast for cache keys and CDN patterns, but rectangular cells, not true circles, cause inaccuracy at cell boundaries.
- **Redis GEO** is in-memory and very fast but expensive at 200M businesses and lacks persistence guarantees. It suited Tinder, where users move constantly; businesses rarely move, so persistence and accuracy matter more.
- **Quadtree** partitions space dynamically by data density; great for uneven data but complex to implement and maintain.
- **PostGIS** is a PostgreSQL spatial extension with native geographic types and an R-tree spatial index. It supports true circle radius queries via ST_DWithin, is accurate, persistent, and scales horizontally via read replicas.

For static businesses, PostGIS wins on accuracy, simplicity, and operational familiarity.

**Businesses table (PostgreSQL with PostGIS)**

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

The location column is a PostGIS GEOGRAPHY type with a spatial index:

```pgsql
CREATE INDEX idx_businesses_location ON Businesses USING GIST(location);
```

GIST is an R-tree index; PostGIS uses it to narrow candidates before computing exact distances, keeping radius queries fast over 200M rows.

The geohash column (precision 6, ~1 km x 1 km) is computed and used as the search-result cache key, indexed separately: `CREATE INDEX idx_businesses_geohash ON Businesses(geohash);`

```pgsql
CREATE INDEX idx_businesses_location ON Businesses USING GIST(location);
```

**PostGIS radius query**

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

ST_DWithin uses the GIST index to find candidates, filtering most of the 200M rows; ST_Distance then computes exact distance per candidate.

**Scaling PostGIS:** all 5000 read QPS go to PostgreSQL read replicas; 100 write QPS to the primary. Each replica's spatial index fits in memory, so hot-path queries never touch disk. At extreme scale, shard geographically (Asia, Europe, Americas), since proximity queries are always regional, never cross-continental.

<<<SECTION 4>>>
## 6. Caching Strategy

The 50:1 ratio makes caching essential. Two cache layers serve different parts of the search.

### Level 1 - Search Result Cache (Geohash-Bucketed)

Raw lat/long can't be cache keys: two users at slightly different spots in the same neighborhood would produce different keys and both miss. Instead, bucket by **geohash at precision 6** (~1.2 km x 0.6 km cell). Users in the same cell share cached results, greatly raising hit rate in dense urban areas.

- Key: `search:{geohash_p6}:{radius_km}:{category}`
- Value: Redis SET of business_ids
- TTL: 10 minutes

Example: `search:te7u3x:5:restaurant` → `{biz_123, biz_456, biz_789, biz_101, ...}`, TTL 10 minutes.

A SET (not a list) allows surgical add/remove of individual IDs during invalidation without invalidating the whole key.

### Level 2 - Business Object Cache

Search returns IDs; details are hydrated from:

- Key: `business:{business_id}`
- Value: `{ name, address, category, rating, hours, photo_url, lat, long }`
- TTL: 24 hours

All 20 objects come in a single round trip: `MGET business:biz_123 business:biz_456 business:biz_789 ...`. Any miss falls back to PostgreSQL and writes back to Redis.

### Cache Key Design for Multiple Radii

5 km and 10 km searches from the same cell differ, so radius (and category) are in the key; each combination gets its own entry:

- `search:te7u3x:5:restaurant` (5 km)
- `search:te7u3x:10:restaurant` (10 km)
- `search:te7u3x:20:restaurant` (20 km)
- `search:te7u3x:5:cafe` (different category)

<<<SECTION 5>>>
## 7. Full Search Flow

Example: "coffee shops near Bandra, Mumbai, within 5 km".

**1. Request received** via API Gateway at the Search Service: `GET /v1/search?lat=19.0544&long=72.8375&radius=5&category=cafe&limit=20`

**2. Compute geohash cache key** (precision 6): `geohash(19.0544, 72.8375, precision=6) -> "te7u3x"` → key `search:te7u3x:5:cafe`

**3. Redis check:** `SMEMBERS search:te7u3x:5:cafe`. Hit: returns a SET of IDs, skip to step 5. Miss: step 4.

**4. PostGIS query (miss only).** Search Service calls Location Service with coordinates, radius, category; it queries a read replica:

```pgsql
SELECT business_id, lat, long
FROM Businesses
WHERE ST_DWithin(location::geography, ST_MakePoint(72.8375, 19.0544)::geography, 5000)
AND category = 'cafe'
AND is_active = true
LIMIT 50;
```

Results are cached: `SADD search:te7u3x:5:cafe biz_123 biz_456 biz_789 ...` then `EXPIRE search:te7u3x:5:cafe 600`.

**5. Hydration:** `MGET business:biz_123 business:biz_456 business:biz_789 ...`; individual misses are fetched from PostgreSQL and populated into Redis.

**6. Distance and ranking.** Compute Haversine distance from the user to each business (coordinates come from the object cache):

```python
def haversine(user_lat, user_long, biz_lat, biz_long):
    R = 6371
    dlat = radians(biz_lat - user_lat)
    dlong = radians(biz_long - user_long)
    a = sin(dlat/2)**2 + cos(radians(user_lat)) * cos(radians(biz_lat)) * sin(dlong/2)**2
    return R * 2 * asin(sqrt(a))
```

Sort ascending, return top 20. This happens in the application layer because distance depends on each user's exact coordinates; even users in the same cell get different distances, so cached results can't be pre-sorted in Redis or PostGIS.

**7. Response:** ranked businesses with name, address, category, distance, rating, photo URL.

**Latency:**
- Cache hit: ~5ms (SMEMBERS + MGET)
- Cache miss + PostGIS: ~30-50ms (spatial query on read replica)
- Distance sort: ~1ms
- End-to-end: under 100ms on both paths

<<<SECTION 6>>>
## 8. Business Service - Write Flow

**New listing:**
1. Validate input (valid coordinates, required fields, category in allowed enum).
2. Compute `geohash(lat, long, precision=6)`.
3. INSERT into PostgreSQL:

```pgsql
INSERT INTO Businesses (business_id, name, address, category, lat, long,
       location, geohash, rating, is_active, created_at)
   VALUES (gen_random_uuid(), 'Cafe Madras', '12 SV Road...', 'restaurant',
       19.0544, 72.8375, ST_MakePoint(72.8375, 19.0544)::geography,
       'te7u3x', 0.0, true, NOW());
```

4. Publish business.created to Kafka.
5. Cache Update Worker: `SET business:{business_id} {full business object}` with 24-hour TTL; `SADD search:{geohash}:*:{category} business_id` (only for existing cache keys).
6. Searchable within seconds.

Database first, then cache, so a business never appears in search before its record exists.

**Non-location update** (name, hours, photos):
1. UPDATE PostgreSQL.
2. Publish business.updated to Kafka.
3. Cache Invalidation Worker: `DEL business:{business_id}`. Search result keys are NOT invalidated (the ID stays valid); the object cache repopulates on next fetch.

### Business Location Update (Address Change)

1. Compute old geohash (from the DB record) and new geohash (from new coordinates).
2. UPDATE with new lat, long, location, geohash.
3. Publish business.location_updated with both geohashes.
4. Cache Invalidation Worker: scan keys matching `search:{old_geohash}:*`; `SREM search:{old_geohash}:{radius}:{category} business_id` for each; `DEL business:{business_id}`; `SADD search:{new_geohash}:{radius}:{category} business_id` for each existing new-cell key. Object cache repopulates on next fetch.

Surgical SREM of individual IDs, instead of deleting whole keys, prevents cache stampedes on high-traffic cells.

### Business Deletion

1. `UPDATE Businesses SET is_active = false` (soft delete).
2. Publish business.deleted to Kafka.
3. Cache Invalidation Worker: scan `search:{geohash}:*`, SREM the ID from all matching keys; `DEL business:{business_id}`.
4. The business disappears from results immediately (next query gets the cleaned set).

Soft delete preserves the record for audit and allows recovery from accidental deletion. A background job hard-deletes after 30 days.

<<<SECTION 7>>>
## 9. Data Model Summary

### Businesses Table (PostgreSQL + PostGIS)

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

```pgsql
photo_id        UUID, primary key
business_id     UUID, foreign key -> Businesses
s3_url          TEXT
order_index     INTEGER
uploaded_at     TIMESTAMP
```

Photos live in S3, served via CDN. Photo URLs are in the business object cache, so search needs no separate photo fetch.

<<<SECTION 8>>>
## 10. Full Data Flow Summary

**Search (cache hit), ~5ms:** Client → API Gateway → Search Service → geohash (precision 6) → `SMEMBERS search:{geohash}:{radius}:{category}` (hit) → `MGET business:biz_1 business:biz_2 ...` → Haversine in app layer → sort ascending, return top 20.

**Search (cache miss), ~30-50ms:** Client → API Gateway → Search Service → geohash → SMEMBERS (miss) → Location Service → PostGIS ST_DWithin on read replica → `SADD search:{geohash}:{radius}:{category} {business_ids}` → MGET → distance sort → top 20.

**New listing:** Owner → API Gateway → Business Service → validate → geohash → INSERT into PostgreSQL → Kafka (business.created) → Cache Update Worker: `SET business:{business_id} {object}` TTL 24h; `SADD search:{geohash}:*:{category} business_id` (existing keys only) → searchable within seconds.

**Location update:** Owner → API Gateway → Business Service → fetch old geohash → compute new geohash → UPDATE (lat, long, location, geohash) → Kafka (business.location_updated, old + new geohash) → Cache Invalidation Worker: SREM from all `search:{old_geohash}:*` keys (surgical); `DEL business:{business_id}`; SADD to all `search:{new_geohash}:*` keys (existing only).

**Deletion:** Owner → API Gateway → Business Service → `UPDATE is_active = false` → Kafka (business.deleted) → Cache Invalidation Worker: SREM from all `search:{geohash}:*` keys; `DEL business:{business_id}` → disappears from results immediately.

<<<SECTION 9>>>
## 11. Resilience and Fault Tolerance

- **PostGIS read replicas:** search survives primary failure; all 5000 read QPS hit replicas. Primary failure affects only writes (100 QPS), which queue in Kafka until the primary recovers or a replica is promoted.
- **Redis caching:** most searches never reach PostGIS. A PostGIS slowdown hurts only misses; hits (80%+ of traffic) are unaffected.
- **Kafka durability:** cache invalidation/update events are never lost if the worker crashes; workers replay from offsets.
- **Soft delete:** accidental deletions are recoverable; hard deletes only after a 30-day grace period via a background job.
- **Surgical SREM invalidation:** prevents stampedes on hot cells; removing one business doesn't invalidate hundreds of others in the cell.
- **Geographic sharding** (Asia, Europe, Americas): a database issue in one region doesn't affect others.
- **10-minute cache TTL:** stale results (new businesses not yet cached) self-correct within 10 minutes without explicit invalidation.

<<<SECTION 10>>>
## 12. Technology Choices Summary

- **API Gateway:** Kong / AWS API Gateway (auth, rate limiting, routing)
- **Geospatial DB:** PostgreSQL + PostGIS (R-tree GIST index, ST_DWithin true-circle radius queries, 200M rows in memory)
- **Search Result Cache:** Redis SET per geohash cell (SMEMBERS retrieval, SADD/SREM surgical invalidation without stampede)
- **Business Object Cache:** Redis MGET (batch hydration in one round trip)
- **Distance Ranking:** app-layer Haversine (per-user, can't be pre-sorted; microsecond in-memory sort of 20-50 results)
- **Geohash Cache Key:** precision 6 (1.2km x 0.6km cells; much higher hit rate than raw coordinates)
- **Photo Storage:** S3 + CDN (edge-served; high hit rate since photos rarely change)
- **Write Decoupling:** Kafka (create/update/delete events, invalidation workers, reliable delivery)
- **Database Scaling:** PostgreSQL read replicas (5000 read QPS on replicas, 100 write QPS on primary)
- **Geographic Sharding:** regional PostgreSQL clusters (Asia, Europe, Americas; fault isolation)
