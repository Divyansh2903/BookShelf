# Design Airbnb

<<<SECTION 1>>>
## 1. Requirements

**Functional**
- Listing management (hosts create/update/delete listings with photos, descriptions)
- Search by location, dates, price, ratings, amenities
- Map view of properties
- Per-property availability and calendar
- Booking and reservations
- Payments (guest pays, host gets payout)
- Reviews (guests review properties, hosts review guests)
- Notifications (confirmations, check-in reminders, review prompts)
- Host and guest profiles

**Out of scope:** Airbnb Experiences, dynamic pricing ML, identity verification/background checks, Superhost program, dispute resolution.

**Non-functional**
- High availability for search and browsing
- Strong consistency for booking/availability: never double book overlapping dates
- Eventual consistency OK for reviews, recommendations, notifications
- Search under 200ms including geo-filtering and availability
- Exactly-once payment processing
- Atomic date range reservation: fully succeeds or fully fails

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 10M (lower than social platforms; high-intent users)
- **Active listings:** 7M globally
- **Searches/day:** 50M (multiple searches per booking)
- **Bookings/day:** ~500,000 (1% search-to-booking conversion)
- **Photos:** 20 per listing at 1 MB = 20 MB/property; 7M x 20 MB = ~140 TB total
- **Availability rows:** 7M x 365 days = ~2.5 billion
- **Peak concurrency:** popular properties in peak season can see hundreds of simultaneous booking attempts

The core challenge is **correctness under concurrency**, not storage or throughput. A double-booked Christmas week is catastrophic, and every booking/availability decision is driven by preventing it.

<<<SECTION 3>>>
## 3. API Gateway

Handles auth, rate limiting, and routing. Two user types share it, guests (search, book) and hosts (listings, calendars), and requests are routed to separate service clusters by operation type.

Photo uploads bypass the Gateway after auth via presigned S3 URLs for direct client-to-S3 upload; like Instagram uploads, large binaries must never pass through the API layer.

## 4. Host and Guest Profile Service

A dual-sided marketplace: hosts and guests are both first-class users with very different workflows and data.

**Users (PostgreSQL):** user_id (UUID PK), email (VARCHAR, unique), name (VARCHAR), profile_pic_url (TEXT), phone (VARCHAR), is_host (BOOLEAN), host_rating, guest_rating (FLOAT), host_review_count, guest_review_count (INTEGER), joined_at (TIMESTAMP).

One table covers both roles; is_host marks users with active listings. A user can be host and guest at once (many rent out their home while traveling). host_rating and guest_rating are denormalized, updated async by Kafka consumers on new reviews. Hosts care about guest ratings (trustworthy?), guests about host ratings (responsive?).

**HostPayouts (PostgreSQL):** payout_id (UUID PK), host_id (UUID FK -> Users), bank_account (VARCHAR, encrypted), routing_number (VARCHAR, encrypted), payout_currency (VARCHAR), created_at (TIMESTAMP).

Bank details are strongly consistent and encrypted at rest; they drive real money transfers and cannot be eventually consistent.

**Caching:** profiles are cached in Redis with a moderate TTL. Host profiles load on every listing page view, so hot hosts (superhosts with many listings) benefit most. Guest profiles load less often, during booking initiation for host review.

<<<SECTION 4>>>
## 5. Property Listing Service and Upload Pipeline

Manages a property's description, amenities, house rules, location, pricing, and photos.

**Photo upload flow** (same presigned URL pattern):
1. Host authenticates via the Gateway and requests presigned S3 URLs from the Listing Service.
2. Host uploads photos directly to S3.
3. S3 sends upload events to Kafka.
4. Photo Processing Worker generates variants: thumbnail (search results), medium (listing grid), full-res (listing gallery).
5. Variants stored at `media/{property_id}/{variant}/`.
6. A CDN in front of S3 serves photos globally.

### Data model (PostgreSQL)

**Properties:** property_id (UUID PK), host_id (UUID FK -> Users), title (VARCHAR), description (TEXT), property_type (ENUM 'entire_place', 'private_room', 'shared_room'), accommodation (ENUM 'apartment', 'house', 'villa', 'unique'), max_guests, bedrooms, bathrooms (INTEGER), base_price (DECIMAL(10,2)), currency (VARCHAR), latitude, longitude (FLOAT), geohash (VARCHAR, precision 6, ~1km cell), address (TEXT), city, country (VARCHAR), rating (FLOAT), review_count (INTEGER), is_active (BOOLEAN), created_at (TIMESTAMP).

geohash is computed from lat/long. Precision 6 gives ~1km x 1km cells, suitable for radius search; shared prefixes mean geographic closeness (same as Tinder).

**PropertyAmenities:** property_id (UUID FK -> Properties), amenity (ENUM 'wifi', 'pool', 'parking', 'kitchen', 'ac', 'pet_friendly', ...), PRIMARY KEY (property_id, amenity). One row per amenity rather than a JSON array, so filters like "pool AND parking" are plain SQL WHERE clauses on indexed columns.

**PropertyPhotos:** photo_id (UUID PK), property_id (UUID FK -> Properties), s3_url (TEXT), order_index (INTEGER), uploaded_at (TIMESTAMP).

### Search indexing

On create/update, the Listing Service publishes `property.updated` to Kafka; the Search Indexing Worker updates Elasticsearch with geohash, price, rating, amenities, and availability summary.

**Bottlenecks:** read-heavy (pages viewed far more than updated); Redis caches hot listing metadata. The main write concern is bulk updates by property management companies with hundreds of listings, handled by Gateway rate limiting.

<<<SECTION 5>>>
## 6. Availability Service

The most consistency-critical service: stores, checks, and reserves availability across date ranges with no possibility of double booking.

### Calendar table design

One record per property per date, the **calendar table pattern**.

**PropertyAvailability:** property_id (UUID FK -> Properties), date (DATE), status (ENUM 'available', 'booked', 'blocked'), price (DECIMAL(10,2)), booking_id (UUID, null if available or blocked), PRIMARY KEY (property_id, date).

- A 7-night stay Dec 20-26 creates 7 rows sharing one booking_id.
- `blocked`: dates the host blocks manually (personal use, maintenance).
- Per-date price enables dynamic pricing (weekends, local events) without changing base price.

**Availability check** for Dec 20-25 (5 nights):

```sql
SELECT COUNT(*) FROM PropertyAvailability
WHERE property_id = 'property_123'
AND date BETWEEN '2024-12-20' AND '2024-12-24'
AND status = 'available'
```

COUNT = 5 means fully available. The composite PK (property_id, date) makes this an index scan, very fast even over 2.5 billion rows.

### Preventing double booking: pessimistic locking

If 100 users see the same dates as available and all book, without concurrency control all 100 could succeed. The fix is **pessimistic locking** with PostgreSQL `SELECT FOR UPDATE`:

```pgsql
BEGIN;

SELECT COUNT(*) FROM PropertyAvailability
WHERE property_id = 'property_123'
AND date BETWEEN '2024-12-20' AND '2024-12-24'
AND status = 'available'
FOR UPDATE;

-- If COUNT = 5 (fully available), proceed:
UPDATE PropertyAvailability
SET status = 'booked', booking_id = 'booking_456'
WHERE property_id = 'property_123'
AND date BETWEEN '2024-12-20' AND '2024-12-24';

COMMIT;
```

`SELECT FOR UPDATE` row-locks all matching rows for the transaction; other transactions reading or updating them block until commit or rollback, so only one booking can succeed per date range per property.

Unlike Amazon's Redis distributed lock: availability lives in PostgreSQL and check-and-update must be atomic, so native transaction locking is the right tool.

### Two-phase booking with expiring reservations

To avoid holding locks while the user is on the payment screen:

**Phase 1 - Tentative reservation (10-minute hold):**
1. Lock the requested dates.
2. Check availability.
3. If available, set status `reserved` with `reserved_until` = now + 10 minutes.
4. Commit (release lock).
5. User goes to payment.

**Phase 2 - Confirmation:**
1. Payment Service charges the guest.
2. Success: `reserved` -> `booked`.
3. Failure or timeout: a background job resets expired `reserved` rows to `available`.

The lock isn't held while the user types card details, yet double booking is still prevented during payment.

**Updated PropertyAvailability:** property_id (UUID), date (DATE), status (ENUM 'available', 'booked', 'blocked', 'reserved'), price (DECIMAL(10,2)), booking_id (UUID), reserved_until (TIMESTAMP, null unless status = 'reserved'), PRIMARY KEY (property_id, date).

A **Reservation Expiry Worker** runs every minute:

```sql
UPDATE PropertyAvailability
SET status = 'available', booking_id = NULL, reserved_until = NULL
WHERE status = 'reserved'
AND reserved_until < NOW();
```

### Redis cache for availability

Search doesn't need exact PostgreSQL checks per result. A Redis bitmap gives a fast approximate signal:
- Key: `availability:{property_id}:{year_month}`
- Value: one bit per day (bit 0 = day 1, bit 30 = day 31); 1 = available, 0 = booked or blocked

A 31-bit bitmap per property per month fits in 4 bytes. A date-range check is a bitwise AND across the relevant month bitmaps, sub-millisecond. This is the search fast path; the authoritative locked check runs only on an actual booking attempt.

**Bottlenecks:** row locks on popular properties at peak (a Goa property in New Year's week may get hundreds of simultaneous attempts). Two-phase reservation keeps the lock to milliseconds (check + status update), not the payment duration. The bitmap fast path keeps search off PostgreSQL.

<<<SECTION 6>>>
## 7. Search Service

The most complex search across all nine designs in the series: geographic proximity (like Tinder), date availability, price and rating filters (like Amazon), and relevance ranking in one request.

### Storage Engine - Elasticsearch with Geospatial Support

Tinder used Redis GEO for proximity, but Airbnb must combine proximity with rich attribute filtering and ranking in one query. Elasticsearch's native `geo_distance` filter does this without a separate geo store.

**Property document:**

```json
{
  "property_id": "123",
  "title": "Cozy 1BHK in South Goa",
  "property_type": "entire_place",
  "accommodation": "apartment",
  "max_guests": 2,
  "bedrooms": 1,
  "bathrooms": 1,
  "base_price": 3500,
  "currency": "INR",
  "location": {
    "lat": 15.2993,
    "lon": 74.1240
  },
  "city": "Goa",
  "country": "India",
  "rating": 4.8,
  "review_count": 124,
  "amenities": ["wifi", "pool", "parking", "kitchen"],
  "host_id": "456",
  "is_active": true,
  "available_months": ["2024-12", "2025-01"]
}
```

`location` is a `geo_point`, enabling native radius filtering. `available_months` lists months with at least some availability, a coarse pre-filter before the precise date check.

### Search query flow

For "Goa, Dec 20-25, 2 guests, max 5000 INR per night":

**Step 1 - Elasticsearch query:**

```json
{
  "query": {
    "bool": {
      "filter": [
        { "geo_distance": { "distance": "50km", "location": { "lat": 15.2993, "lon": 74.1240 } } },
        { "term": { "available_months": "2024-12" } },
        { "range": { "base_price": { "lte": 5000 } } },
        { "term": { "is_active": true } },
        { "range": { "max_guests": { "gte": 2 } } }
      ]
    }
  },
  "sort": [
    { "rating": { "order": "desc" } },
    { "_geo_distance": { "location": { "lat": 15.2993, "lon": 74.1240 }, "order": "asc" } }
  ]
}
```

Returns candidate IDs matching coarse filters, sorted by rating then proximity.

**Step 2 - Redis bitmap filter:** the (say 500) candidates are checked against availability bitmaps for the exact dates, leaving only truly available properties without touching PostgreSQL.

**Step 3 - Hydration:** Redis MGET fetches full metadata (title, photos, price, rating); PostgreSQL on miss.

**Step 4 - Map data:** lat/long for all candidates so the client can render pins; same Elasticsearch geo query, returning coordinates instead of ranked results.

### Ranking signals

- Rating and review count (higher, more reviewed first)
- Proximity (closer wins at equal rating)
- Price competitiveness within a category
- Host response rate (faster ranks higher)
- Booking acceptance rate (frequent decliners rank lower)
- Superhost status (boost)

### Keeping Elasticsearch in sync

The Search Indexing Worker consumes `property.updated` and `property.created`. `available_months` is refreshed nightly by a worker scanning PropertyAvailability. Rating and review count sync periodically from the Reviews Service.

**Bottlenecks:** bitmap checks for 500 candidates per query are the main latency cost; MGET batches them into one round trip. Geo queries over 7M documents are fast with a properly configured `geo_point` field.

<<<SECTION 7>>>
## 8. Booking Service

Orchestrates reservation across Availability, Payment, and Notification services using the **Saga pattern**.

**State machine:** INITIATED -> RESERVED (availability held, awaiting payment) -> PAYMENT_PROCESSING -> CONFIRMED (paid, dates locked). Other states: CANCELLED_BY_GUEST, CANCELLED_BY_HOST, COMPLETED (stay finished, review prompt triggered), EXPIRED (timed out before payment).

### Booking saga

1. **Initiated:** guest clicks "Reserve"; booking created as INITIATED; `booking.initiated` to Kafka.
2. **Availability reservation:** Availability Service locks the dates, checks, and if available marks them reserved with a 10-minute TTL; publishes `availability.reserved`. If unavailable: `availability.failed` -> booking EXPIRED, guest notified.
3. **Payment:** Payment Service charges the guest. Success: `payment.completed`. Failure: `payment.failed`, triggering a **compensating transaction** (reserved dates reset to available), booking EXPIRED, guest notified, no charge.
4. **Confirmed:** booking -> CONFIRMED; dates reserved -> booked; `booking.confirmed` to Kafka.
5. **Notifications:** confirmation to guest and new-booking alert to host (email + push each).
6. **Host payout:** initiated 24 hours after check-in (Airbnb's standard), held to protect against last-minute host cancellations.

**Bookings (PostgreSQL):** booking_id (UUID PK), property_id (UUID FK -> Properties), guest_id, host_id (UUID FK -> Users), check_in, check_out (DATE), total_nights (INTEGER), total_price, service_fee, host_payout (DECIMAL(10,2)), status (ENUM 'initiated', 'reserved', 'confirmed', 'cancelled_guest', 'cancelled_host', 'completed', 'expired'), idempotency_key (VARCHAR, unique), created_at, updated_at (TIMESTAMP).

- **idempotency_key** stops duplicates from double-clicks or network retries: a repeat request for the same guest, property, and dates returns the first result.
- **host_payout** is separate from total_price because Airbnb charges a service fee to both sides: guest pays total_price, Airbnb keeps the fee, host gets host_payout.

**Bottlenecks:** the availability lock on popular properties. The 10-minute reservation TTL means locks last milliseconds, not minutes. The Saga ensures any failed step triggers compensating transactions, never leaving inconsistent state.

<<<SECTION 8>>>
## 9. Payment Service

Same pattern as Amazon's Payment Service, plus host payouts.

**Guest payment flow:**
1. Consume `availability.reserved` from Kafka.
2. Check the idempotency key in Redis to prevent double charging.
3. Call the external gateway (Razorpay, Stripe, PayPal by region).
4. Success: publish `payment.completed`, record in Payments.
5. Failure: publish `payment.failed`; the Saga compensating transaction releases the reservation.

### Host payout flow

Payment is held and released to the host 24 hours after check-in, protecting guests against property issues at check-in:
1. Guest checks in -> 24-hour timer starts.
2. No reported issues after 24 hours -> Payout Service initiates bank transfer to the host's account.
3. Issue reported within 24 hours -> payout held pending dispute resolution.

**Payments (PostgreSQL):** payment_id (UUID PK), booking_id (UUID FK -> Bookings), guest_id, host_id (UUID FK -> Users), gross_amount, service_fee, host_payout (DECIMAL(10,2)), currency, gateway, gateway_txn_id (VARCHAR), status (ENUM 'pending', 'completed', 'failed', 'refunded', 'payout_pending', 'payout_completed'), idempotency_key (VARCHAR, unique), payout_after (TIMESTAMP, check_in + 24 hours), created_at (TIMESTAMP).

**Bottlenecks:** gateway latency (500ms-2s). Payment is fully async via Kafka; guests see an immediate "processing" state instead of waiting synchronously.

<<<SECTION 9>>>
## 10. Reviews Service

A dual review system: after a stay, guest and host review each other. Neither review is published until both are submitted or 14 days pass, preventing retaliatory reviews.

**Reviews (PostgreSQL):** review_id (UUID PK), booking_id (UUID FK -> Bookings), reviewer_id, reviewee_id (UUID FK -> Users), property_id (UUID, null for host-to-guest reviews), reviewer_type (ENUM 'guest', 'host'), rating (INTEGER 1-5), content (TEXT), is_published (BOOLEAN), created_at (TIMESTAMP), UNIQUE (booking_id, reviewer_type).

is_published starts false. A background worker publishes both reviews together when both are in or after 14 days, whichever first, enforcing the blind policy. Property and host/guest ratings on Properties and Users are denormalized counters updated async by Kafka consumers on publication.

**Bottlenecks:** low volume (max one review per booking, 500,000/day); PostgreSQL handles it easily, and the 14-day delay removes real-time pressure.

<<<SECTION 10>>>
## 11. Notification Service

Same architecture as previous systems: Kafka fanout from upstream services, APNs (iOS), FCM (Android), email via SES.

Subscriptions:
- `booking.confirmed` -> confirmation to guest + new booking alert to host
- `booking.cancelled_guest` -> cancellation confirmation to guest + alert to host
- `booking.cancelled_host` -> cancellation alert to guest (with refund info)
- `payment.payout_completed` -> payout confirmation to host
- `booking.completed` -> review prompt to guest and host
- `review.published` -> "your review has been published" to both
- `availability.expiring` -> "complete your booking, hold expires in 2 minutes" urgency prompt to guest

**Bottlenecks:** volume is far lower than Twitter or Instagram since it's transactional (bookings), not social (likes, follows). No coalescing needed; every notification is distinct and important. Standard APNs/FCM handles it.

<<<SECTION 11>>>
## 12. Full Data Flow Summary

**Listing (host):**
1. Host -> Gateway (auth) -> Listing Service -> presigned S3 URLs; host uploads photos directly to S3.
2. S3 -> Kafka -> Photo Processing Worker -> S3 (thumbnail, medium, full).
3. Listing Service -> Properties table and PropertyAvailability (host's available dates) -> Kafka (`property.created`) -> Search Indexing Worker -> Elasticsearch.

**Search (guest):** "Goa Dec 20-25 2 guests" -> Search Service -> Elasticsearch geo_distance + price + amenity filters (coarse) -> Redis bitmap MGET (exact date check for all candidates) -> Redis MGET (hydrate metadata) -> CDN photo URLs -> map coordinates for map view.

**Booking (guest):**
1. Reserve -> Booking Service -> INITIATED -> Kafka (`booking.initiated`).
2. Availability Service: `SELECT FOR UPDATE` on dates -> if available, `UPDATE status = 'reserved', reserved_until = now + 10 mins` -> Kafka (`availability.reserved`).
3. Payment Service: Redis idempotency check -> payment gateway.
   - Success: Kafka (`payment.completed`) -> Availability `status = 'booked'`; booking CONFIRMED; notifications: confirmation to guest + alert to host.
   - Failure: Kafka (`payment.failed`) -> Availability `status = 'available'` (compensating transaction); booking EXPIRED; failure alert to guest.

**Reservation expiry:** worker every 60 seconds -> `SELECT * FROM PropertyAvailability WHERE status = 'reserved' AND reserved_until < NOW()` -> `UPDATE status = 'available', booking_id = NULL, reserved_until = NULL` -> Kafka (`reservation.expired`) -> guest notified.

**Host payout:** check-in starts a 24hr timer -> no dispute after 24 hours -> bank transfer -> `UPDATE Payments SET status = 'payout_completed'` -> Kafka (`payment.payout_completed`) -> host notified.

**Review:**
1. `booking.completed` -> review prompts to guest and host.
2. Each submission -> Reviews table (`is_published = false`).
3. Both submitted OR 14 days elapsed -> worker sets `is_published = true` -> Kafka (`review.published`), consumed by:
   - Rating update workers -> `Properties.rating`, `Users.host_rating` / `guest_rating`
   - Search Indexing Worker -> Elasticsearch rating field
   - Notification Service -> published confirmation to both

<<<SECTION 12>>>
## 13. Resilience and Fault Tolerance

- **Pessimistic locking** (`SELECT FOR UPDATE`) is the core correctness guarantee: row-level serialization makes double booking impossible regardless of concurrency.
- **Two-phase reservation with TTL:** locks last milliseconds, not minutes. Abandoned payments are released by the 10-minute TTL; the Expiry Worker is a safety net for anything the TTL misses.
- **Saga compensating transactions:** payment failure always releases the reservation; dates never stay reserved without a matching booking or payment.
- **Kafka durability:** no event lost if downstream services are down; every saga step can retry from Kafka offsets independently.
- **Idempotency keys** on bookings and payments prevent duplicate bookings and double charges under any retry or network failure.
- **Redis bitmap fast path:** search never holds PostgreSQL locks; the authoritative lock applies only to real booking attempts, leaving the DB free for concurrent bookings.
- **CDN caching:** photos rarely change, so edge hit rates are very high globally.
- **Blind review publication** is enforced in the DB via `is_published` and a background worker; even if the Notification Service fails, the worker publishes reviews on its next run.
- **Elasticsearch availability sync** is eventually consistent, acceptable for search: a property may show for a few minutes after being fully booked, but the Redis bitmap check and final PostgreSQL lock prevent any double booking.

<<<SECTION 13>>>
## 14. Technology Choices Summary

- **API Gateway:** Kong / AWS API Gateway (auth, rate limiting, host/guest routing)
- **Blob Storage:** AWS S3 (property photos, durable, CDN-native)
- **CDN:** CloudFront / Akamai (photo edge caching, high hit rate since photos rarely change)
- **Decoupling:** Apache Kafka (booking saga events, listing updates, review publication, payout triggers)
- **Search:** Elasticsearch with geo_point (geo-radius, date availability, price, rating, amenity filtering in one query)
- **Properties DB:** PostgreSQL sharded + replicas (listing metadata, strong consistency for pricing and host info)
- **Availability DB:** PostgreSQL with row-level locking (calendar table pattern, SELECT FOR UPDATE against double booking)
- **Bookings DB:** PostgreSQL (state machine, idempotency keys, saga orchestration)
- **Payments DB:** PostgreSQL (financial records, guest charges, host payouts, idempotency)
- **Reviews DB:** PostgreSQL (dual blind reviews, deferred publication)
- **Availability Fast Path:** Redis bitmaps (per-property per-month, bitwise AND for date ranges, search pre-filter)
- **Property Metadata Cache:** Redis MGET (batch hydration for search results and listing pages)
- **User Profile Cache:** Redis (host/guest profiles, subscription status, response rate signals)
- **Reservation Expiry:** background worker + PostgreSQL TTL field (auto-release of abandoned reservations)
- **Payout Scheduling:** Kafka delayed events + Payout Worker (24-hour hold after check-in)
- **Notification Delivery:** APNs + FCM + AWS SES (transactional notifications, no coalescing)
