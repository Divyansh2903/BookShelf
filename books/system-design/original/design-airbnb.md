# Design Airbnb

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

- Property listing management (hosts create, update, delete listings with photos and descriptions)
- Search for properties by location, date range, price, ratings, and amenities
- Geographic map view of properties
- Availability and calendar management per property
- Booking and reservation management
- Payment processing (guest pays, host receives payout)
- Reviews (guests review properties, hosts review guests)
- Notifications (booking confirmation, check-in reminders, review prompts)
- Profile management for both hosts and guests

### Out of Scope

- AirBnB Experiences
- Dynamic pricing ML engine
- Identity verification and background checks
- Superhost program
- Dispute resolution system

### Non-Functional Requirements

- High availability for search and property browsing
- Strong consistency for booking and availability. A property must never be double booked for overlapping dates
- Eventual consistency acceptable for reviews, recommendations, and notifications
- Low latency search under 200ms including geo-filtering and availability checking
- Exactly once payment processing
- Atomic date range reservation. Booking either fully succeeds or fully fails, no partial states

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 10 million (AirBnB is lower DAU than social platforms, high intent users)
- **Total active listings:** 7 million properties globally
- **Searches per day:** 50 million (users search multiple times before booking)
- **Bookings per day:** ~500,000 (1% conversion from search to booking)
- **Average photos per listing:** 20 photos at 1 MB each = 20 MB per property
- **Total photo storage:** 7M properties x 20 MB = ~140 TB total
- **Availability records:** 7M properties x 365 days = ~2.5 billion rows in the availability table
- **Peak concurrency:** flash booking scenarios (popular properties in peak season) can see hundreds of simultaneous booking attempts

The dominant systems challenge is not storage or throughput but **correctness under concurrency**. A property double-booked for Christmas week is a catastrophic failure. Every architectural decision in the booking and availability layer is driven by preventing this.

<<<SECTION 3>>>
## 3. API Gateway

All client requests enter through the API Gateway which handles authentication, rate limiting, and routing. AirBnB has two distinct user types hitting the same Gateway: guests (searching and booking) and hosts (managing listings and calendars). The Gateway routes requests to separate service clusters based on the operation type.

Media uploads (property photos) bypass the Gateway after authentication using presigned S3 URLs for direct client-to-S3 upload. A property listing photo is the same problem as an Instagram photo upload. Large binary payload that must never go through the API layer.

## 4. Host and Guest Profile Service

AirBnB is a dual-sided marketplace. Hosts and guests are both first-class users with completely different workflows and data requirements.

### Data Model

### Users Table (PostgreSQL)

Users  
user_id           UUID, primary key  
email             VARCHAR, unique  
name              VARCHAR  
profile_pic_url   TEXT  
phone             VARCHAR  
is_host           BOOLEAN  
host_rating       FLOAT  
guest_rating      FLOAT  
host_review_count INTEGER  
guest_review_count INTEGER  
joined_at         TIMESTAMP

A single Users table handles both hosts and guests. The is_host flag indicates whether the user has active listings. A user can be both a host and a guest simultaneously. Many AirBnB users rent out their own property while also traveling and booking others.

host_rating and guest_rating are denormalized counters updated asynchronously via Kafka consumers when new reviews are submitted. Hosts care about guest ratings (is this person trustworthy?) and guests care about host ratings (is this host responsive?).

### Host Payout Accounts Table (PostgreSQL)

HostPayouts  
payout_id         UUID, primary key  
host_id           UUID, foreign key -> Users  
bank_account      VARCHAR (encrypted)  
routing_number    VARCHAR (encrypted)  
payout_currency   VARCHAR  
created_at        TIMESTAMP

Host bank account details are strongly consistent and encrypted at rest. These are financial records tied to real money transfers and cannot be eventually consistent.

### Caching Strategy

User profiles are cached in Redis with a moderate TTL. Host profiles are fetched on every property listing page view, so hot hosts (superhosts with many listings) benefit significantly from caching. Guest profiles are fetched during booking initiation for host review, less frequently than host profiles.

<<<SECTION 4>>>
## 5. Property Listing Service and Upload Pipeline

The Property Listing Service manages everything about a property: its description, amenities, house rules, location, pricing, and photos.

Photo Upload Flow

Same presigned URL pattern as all previous designs:

1. Host authenticates via API Gateway and requests presigned S3 URLs from the Listing Service
1. Host uploads photos directly to S3
1. S3 triggers upload events to Kafka
1. Photo Processing Worker generates multiple resolution variants (thumbnail for search results, medium for listing grid, full resolution for listing page gallery)
1. All variants stored in S3 under media/{property_id}/{variant}/
1. CDN sits in front of S3 and serves property photos globally

Data Model

### Properties Table (PostgreSQL)

Properties  
property_id       UUID, primary key  
host_id           UUID, foreign key -> Users  
title             VARCHAR  
description       TEXT  
property_type     ENUM('entire_place', 'private_room', 'shared_room')  
accommodation     ENUM('apartment', 'house', 'villa', 'unique')  
max_guests        INTEGER  
bedrooms          INTEGER  
bathrooms         INTEGER  
base_price        DECIMAL(10,2)  
currency          VARCHAR  
latitude          FLOAT  
longitude         FLOAT  
geohash           VARCHAR (precision 6, ~1km cell)  
address           TEXT  
city              VARCHAR  
country           VARCHAR  
rating            FLOAT  
review_count      INTEGER  
is_active         BOOLEAN  
created_at        TIMESTAMP

geohash is a computed column derived from latitude and longitude. A precision-6 geohash gives cells of roughly 1km x 1km which is appropriate for property search radius queries. Properties with the same geohash prefix are geographically close (same as Tinder).

### PropertyAmenities Table (PostgreSQL)

PropertyAmenities  
property_id   UUID, foreign key -> Properties  
amenity       ENUM('wifi', 'pool', 'parking', 'kitchen', 'ac', 'pet_friendly', ...)  
PRIMARY KEY (property_id, amenity)

Amenities are stored as individual rows rather than a JSON array. This allows efficient filtering queries like "show me all properties with pool AND parking" using standard SQL WHERE clauses on indexed columns.

### PropertyPhotos Table (PostgreSQL)

PropertyPhotos  
photo_id      UUID, primary key  
property_id   UUID, foreign key -> Properties  
s3_url        TEXT  
order_index   INTEGER  
uploaded_at   TIMESTAMP

### Search Indexing

When a new property is listed or updated, the Listing Service publishes a property.updated event to Kafka. The Search Indexing Worker consumes this event and updates the Elasticsearch index. Property metadata including geohash, price, rating, amenities, and availability summary are all indexed in Elasticsearch for fast search queries.

Bottlenecks in the Listing Service

The Listing Service is read-heavy since property pages are viewed far more often than they are updated. Redis caches hot property metadata for popular listings. The main write concern is bulk listing updates by large property management companies managing hundreds of listings simultaneously, handled by rate limiting at the API Gateway level.

<<<SECTION 5>>>
## 6. Availability Service

The Availability Service is the most consistency-critical service in the entire system. It is responsible for storing, checking, and reserving property availability across date ranges without any possibility of double booking.

### Calendar Table Design

Availability is stored as a per-property per-date record. This is called the **calendar table pattern**:

PropertyAvailability

property_id   UUID, foreign key -> Properties  
date          DATE  
status        ENUM('available', 'booked', 'blocked')  
price         DECIMAL(10,2)  
booking_id    UUID (null if available or blocked)  
PRIMARY KEY (property_id, date)

Each row represents one property on one calendar date. A 7-night stay from Dec 20 to Dec 26 creates 7 rows (one per night) all pointing to the same booking_id.

blocked status is used when hosts manually block dates on their calendar (personal use, maintenance, etc).

price per date allows dynamic pricing: a property can charge more on weekends or during local events without changing the base price.

Availability Check Query

Checking whether a property is available for Dec 20-25 (5 nights):

```sql
SELECT COUNT(*) FROM PropertyAvailability
WHERE property_id = 'property_123'
AND date BETWEEN '2024-12-20' AND '2024-12-24'
AND status = 'available'
```

If COUNT equals 5 (the number of nights requested), the property is fully available for the requested dates.

The composite primary key on (property_id, date) makes this query an index scan rather than a full table scan, extremely fast even across 2.5 billion rows.

### Preventing Double Booking - Pessimistic Locking

The concurrency problem is the hardest part of this design. 100 users simultaneously check availability for the same property on the same dates, all see it as available, and all attempt to book. Without a concurrency control mechanism, all 100 bookings could succeed, massively overselling the property.

The solution is **pessimistic locking** using PostgreSQL's SELECT FOR UPDATE:

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

SELECT FOR UPDATE acquires a row-level lock on all matching availability rows for the duration of the transaction. Any other transaction attempting to read or update those same rows is blocked until the first transaction commits or rolls back. Only one booking can succeed for any given date range on any given property.

This is different from Amazon's Redis distributed lock. Because availability is stored in PostgreSQL and the check-and-update must be atomic, PostgreSQL's native transaction locking is the right tool here rather than a separate Redis lock.

Two-Phase Booking with Expiring Reservations

To avoid holding locks while the user is still on the payment screen, AirBnB uses a two-phase booking pattern:

### Phase 1 - Tentative Reservation (hold for 10 minutes)

1. Acquire PostgreSQL lock on the requested dates
1. Check availability
1. If available, set status to reserved with a reserved_until timestamp 10 minutes in the future
1. Release lock (transaction commits)
1. User proceeds to payment screen

### Phase 2 - Confirmation on Payment Success

1. Payment Service charges the guest
1. On payment success, update status from reserved to booked
1. On payment failure or timeout, a background job resets expired reserved rows back to available

This prevents the lock from being held for minutes while the user types in their credit card number, while still preventing double booking during the payment window.

### Updated PropertyAvailability Table:

PropertyAvailability  
  
property_id     UUID  
date            DATE  
status          ENUM('available', 'booked', 'blocked', 'reserved')  
price           DECIMAL(10,2)  
booking_id      UUID  
reserved_until  TIMESTAMP (null unless status = 'reserved')  
PRIMARY KEY (property_id, date)

A background **Reservation Expiry Worker** runs every minute and resets stale reservations:

```sql
UPDATE PropertyAvailability
SET status = 'available', booking_id = NULL, reserved_until = NULL
WHERE status = 'reserved'
AND reserved_until < NOW();
```

Redis Cache for Availability

For the search layer, exact per-date availability does not need to be checked in PostgreSQL for every search result. A Redis bitmap provides a fast approximate availability signal:

Key: availability:{property_id}:{year_month}  
Value: bitmap where each bit represents one day (bit 0 = day 1, bit 30 = day 31)  
       1 = available, 0 = booked or blocked

A 31-bit bitmap per property per month fits in 4 bytes. Checking availability for a date range is a bitwise AND operation across the relevant month bitmaps, sub-millisecond.

This Redis bitmap is the fast path for search filtering. The authoritative check with pessimistic locking only happens when a user actually attempts to book, not on every search query.

### Bottlenecks in the Availability Service

The PostgreSQL lock on availability rows is the primary bottleneck for popular properties during peak booking periods. A property in Goa during New Year's week might have hundreds of simultaneous booking attempts. The two-phase reservation pattern mitigates this by keeping the lock held only for milliseconds (the availability check and status update), not for the duration of payment processing. The Redis bitmap fast path ensures search queries never hit PostgreSQL directly.

<<<SECTION 6>>>
## 7. Search Service

AirBnB search is the most complex search query across all nine systems we have designed. A single search request combines geographic proximity (like Tinder), date range availability filtering, price and rating filtering (like Amazon), and relevance ranking.

Storage Engine - Elasticsearch with Geospatial Support

Elasticsearch handles the primary search layer. Unlike Tinder which used Redis GEO for proximity, AirBnB search requires combining proximity with rich attribute filtering and ranking in a single query. Elasticsearch's native geo_distance filter handles this without a separate geo store.

### Property document in Elasticsearch:

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

location is stored as an Elasticsearch geo_point type which enables native radius filtering. available_months is a coarse availability signal — a list of months in which the property has at least some availability. This is used as a pre-filter before the precise date range check.

### Search Query Flow

When a user searches "Goa, Dec 20-25, 2 guests, max 5000 INR per night":

### Step 1 - Elasticsearch Query

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

This returns a list of candidate property IDs matching the coarse filters, sorted by rating and proximity.

**Step 2 - Redis Bitmap Availability Filter**  
The candidate list from Elasticsearch may contain 500 properties. Before rendering, the Search Service checks the Redis availability bitmaps for each property to filter out any that are unavailable for the exact requested dates. This reduces the candidate list to truly available properties without hitting PostgreSQL.

**Step 3 - Property Metadata Hydration**  
The filtered candidate list is hydrated via Redis MGET to fetch full property metadata (title, photos, price, rating) for display. On cache miss, falls back to PostgreSQL.

**Step 4 - Map Data Generation**  
For the map view, the Search Service returns latitude and longitude coordinates for all candidate properties so the client can render pins on the map. The map view is driven by the same Elasticsearch geo query but returns coordinates rather than ranked results.

### Search Result Ranking

AirBnB search ranking combines multiple signals:

- **Rating and review count** (higher rated properties with more reviews rank higher)
- **Proximity to searched location** (closer properties rank higher for same rating)
- **Price competitiveness** (within a category, better value properties rank higher)
- **Response rate** (hosts who respond quickly rank higher)
- **Booking acceptance rate** (hosts who frequently decline rank lower)
- **Superhost status** (superhosts get a ranking boost)

### Keeping Elasticsearch in Sync

The Search Indexing Worker consumes from property.updated and property.created Kafka topics for listing changes. Availability summary (available_months) is updated nightly by a background worker that scans the PropertyAvailability table and updates Elasticsearch documents. Rating and review count updates are synced periodically from the Reviews Service.

### Bottlenecks in Search

The Redis bitmap availability check for 500 candidates per search query is the main latency concern. Using MGET to batch all bitmap reads into a single round trip mitigates this. Elasticsearch geo queries across 7 million property documents are fast given proper index configuration with a geo_point field type.

<<<SECTION 7>>>
## 8. Booking Service

The Booking Service orchestrates the full reservation flow, coordinating between the Availability Service, Payment Service, and Notification Service using the Saga pattern.

Booking State Machine

INITIATED -> RESERVED (availability held, awaiting payment)  
          -> PAYMENT_PROCESSING  
          -> CONFIRMED (payment successful, dates locked)  
          -> CANCELLED_BY_GUEST  
          -> CANCELLED_BY_HOST  
          -> COMPLETED (stay finished, review prompt triggered)  
          -> EXPIRED (reservation timed out before payment)

Full Booking Saga Flow

**Step 1 - Booking Initiated**  
Guest selects dates and clicks "Reserve". Booking Service creates a booking record in INITIATED state and publishes booking.initiated to Kafka.

**Step 2 - Availability Reservation**  
Availability Service acquires PostgreSQL row lock on the requested dates, checks availability, and if available sets status to reserved with a 10-minute TTL. Publishes availability.reserved to Kafka.

If unavailable: publishes availability.failed -> Booking Service marks booking EXPIRED, guest notified.

**Step 3 - Payment Processing**  
Payment Service charges the guest's payment method. On success, publishes payment.completed. On failure, publishes payment.failed:

- **Compensating transaction:** Availability Service resets reserved dates back to available
- Booking Service marks booking EXPIRED, guest notified, no charge made

**Step 4 - Booking Confirmed**  
Booking Service updates booking to CONFIRMED, Availability Service updates dates from reserved to booked. Publishes booking.confirmed to Kafka.

**Step 5 - Notifications**  
Notification Service sends booking confirmation to guest (email + push) and new booking alert to host (email + push).

**Step 6 - Host Payout**  
Payment Service initiates host payout 24 hours after check-in (AirBnB's standard payout timing). Payout is held until after check-in to protect against last-minute host cancellations.

Bookings Table (PostgreSQL)

Bookings  
booking_id        UUID, primary key  
property_id       UUID, foreign key -> Properties  
guest_id          UUID, foreign key -> Users  
host_id           UUID, foreign key -> Users  
check_in          DATE  
check_out         DATE  
total_nights      INTEGER  
total_price       DECIMAL(10,2)  
service_fee       DECIMAL(10,2)  
host_payout       DECIMAL(10,2)  
status            ENUM('initiated', 'reserved', 'confirmed', 'cancelled_guest',  
                       'cancelled_host', 'completed', 'expired')  
idempotency_key   VARCHAR, unique  
created_at        TIMESTAMP  
updated_at        TIMESTAMP

idempotency_key prevents duplicate bookings from network retries. If the same guest attempts to book the same property for the same dates twice (due to a double-click or network retry), the second request returns the result of the first without creating a duplicate booking.

host_payout is stored separately from total_price because AirBnB takes a service fee from both guest and host. The guest pays total_price, AirBnB keeps the service fee, and the host receives host_payout.

### Bottlenecks in the Booking Service

The PostgreSQL availability lock is the primary bottleneck for popular properties. The 10-minute reservation TTL means locks are held for milliseconds, not minutes. The Saga pattern ensures failures at any step trigger appropriate compensating transactions without leaving the system in an inconsistent state.

<<<SECTION 8>>>
## 9. Payment Service

Same architecture pattern as Amazon's Payment Service with AirBnB-specific additions for host payouts.

Guest Payment Flow

1. Payment Service receives availability.reserved event from Kafka
1. Checks idempotency key in Redis to prevent double charging
1. Calls external payment gateway (Razorpay, Stripe, PayPal depending on region)
1. On success: publishes payment.completed, records in Payments Table
1. On failure: publishes payment.failed, Saga compensating transaction releases reservation

### Host Payout Flow

Host payouts are not immediate. AirBnB holds the guest payment and releases it to the host 24 hours after guest check-in. This protects guests in case of property issues at check-in.

### Payout schedule:

1. Guest checks in -> 24-hour timer starts
1. After 24 hours with no reported issues -> Payout Service initiates bank transfer to host's registered account
1. If guest reports an issue within 24 hours -> Payout held pending dispute resolution

### Payments Table (PostgreSQL)

Payments  
payment_id        UUID, primary key  
booking_id        UUID, foreign key -> Bookings  
guest_id          UUID, foreign key -> Users  
host_id           UUID, foreign key -> Users  
gross_amount      DECIMAL(10,2)  
service_fee       DECIMAL(10,2)  
host_payout       DECIMAL(10,2)  
currency          VARCHAR  
gateway           VARCHAR  
gateway_txn_id    VARCHAR  
status            ENUM('pending', 'completed', 'failed', 'refunded', 'payout_pending', 'payout_completed')  
idempotency_key   VARCHAR, unique  
payout_after      TIMESTAMP (check_in + 24 hours)  
created_at        TIMESTAMP

Bottlenecks in the Payment Service

External payment gateway latency (500ms to 2 seconds) is the primary concern. This is handled by making payment processing fully asynchronous via Kafka. Guests see an immediate "processing" state rather than waiting synchronously for the gateway response.

<<<SECTION 9>>>
## 10. Reviews Service

AirBnB has a unique dual-review system. After a stay completes, both the guest and the host are prompted to review each other. Neither review is published until both parties have submitted, or until 14 days have passed. This prevents retaliatory reviews where one party reviews negatively in response to seeing the other's review.

### Data Model

### Reviews Table (PostgreSQL)

Reviews  
review_id         UUID, primary key  
booking_id        UUID, foreign key -> Bookings  
reviewer_id       UUID, foreign key -> Users  
reviewee_id       UUID, foreign key -> Users  
property_id       UUID (null for host-to-guest reviews)  
reviewer_type     ENUM('guest', 'host')  
rating            INTEGER (1-5)  
content           TEXT  
is_published      BOOLEAN  
created_at        TIMESTAMP  
UNIQUE (booking_id, reviewer_type)

is_published starts as false. A background worker publishes both reviews simultaneously once both are submitted or after 14 days whichever comes first. This enforces the blind review policy.

Property ratings and host/guest ratings on the Properties and Users tables are denormalized counters updated asynchronously via Kafka consumers when reviews are published.

### Bottlenecks in the Reviews Service

Reviews are low volume (one review per booking, 500,000 bookings per day = 500,000 reviews per day maximum). PostgreSQL handles this comfortably. The 14-day publication delay means there is no real-time pressure on the reviews pipeline.

<<<SECTION 10>>>
## 11. Notification Service

Same architecture as all previous systems. Kafka fanout from upstream services, APNs for iOS, FCM for Android, email via SES.

The Notification Service subscribes to:

- booking.confirmed -> booking confirmation to guest + new booking alert to host
- booking.cancelled_guest -> cancellation confirmation to guest + alert to host
- booking.cancelled_host -> host cancellation alert to guest (with refund info)
- payment.payout_completed -> payout confirmation to host
- booking.completed -> review prompt to both guest and host
- review.published -> "your review has been published" notification to both parties
- availability.expiring -> "complete your booking, hold expires in 2 minutes" urgency prompt to guest

Bottlenecks in the Notification Service

AirBnB notification volume is far lower than Twitter or Instagram since it is transactional (booking events) rather than social (likes, follows). No coalescing is needed since every notification is a distinct, important event. Standard APNs/FCM delivery handles the volume comfortably.

<<<SECTION 11>>>
## 12. Full Data Flow Summary

**Property Listing Flow (Host):**  
Host -> API Gateway (auth) -> Listing Service -> presigned S3 URLs  
Host -> S3 (direct photo upload)  
S3 -> Kafka -> Photo Processing Worker -> S3 (thumbnail, medium, full variants)  
Listing Service -> PostgreSQL Properties Table  
Listing Service -> PropertyAvailability Table (host sets available dates)  
Listing Service -> Kafka (property.created)  
    -> Search Indexing Worker -> Elasticsearch  
  
**Search Flow (Guest):**  
Guest searches "Goa Dec 20-25 2 guests" -> Search Service  
    -> Elasticsearch geo_distance + price + amenity filters (coarse pass)  
    -> Redis bitmap MGET (exact date range availability check for all candidates)  
    -> Redis MGET (hydrate property metadata for filtered results)  
    -> CDN (property photo URLs served directly)  
    -> Map coordinates returned for map view rendering  
  
**Booking Flow (Guest):**  
Guest clicks Reserve -> Booking Service -> booking INITIATED -> Kafka (booking.initiated)  
    -> Availability Service  
        -> PostgreSQL SELECT FOR UPDATE on requested dates  
        -> Dates available: UPDATE status = 'reserved', reserved_until = now + 10 mins  
        -> Kafka (availability.reserved)  
    -> Payment Service  
        -> Idempotency check in Redis  
        -> Call payment gateway  
        -> Success: Kafka (payment.completed)  
            -> Availability Service: UPDATE status = 'booked'  
            -> Booking Service: booking CONFIRMED  
            -> Notification Service: confirmation to guest + alert to host  
        -> Failure: Kafka (payment.failed)  
            -> Availability Service: UPDATE status = 'available' (compensating transaction)  
            -> Booking Service: booking EXPIRED  
            -> Notification Service: failure alert to guest  
  
**Reservation Expiry Flow:**  
Expiry Worker runs every 60 seconds  
    -> SELECT \* FROM PropertyAvailability WHERE status = 'reserved' AND reserved_until < NOW()  
    -> UPDATE status = 'available', booking_id = NULL, reserved_until = NULL  
    -> Kafka (reservation.expired) -> Notification Service -> guest notified  
  
**Host Payout Flow:**  
Guest checks in -> Payout Service starts 24hr timer  
After 24 hours with no dispute -> initiate bank transfer to host  
    -> UPDATE Payments SET status = 'payout_completed'  
    -> Kafka (payment.payout_completed) -> Notification Service -> host notified  
  
**Review Flow:**  
booking.completed -> Notification Service -> review prompts to both guest and host  
Guest submits review -> Reviews Table (is_published = false)  
Host submits review -> Reviews Table (is_published = false)  
Both submitted OR 14 days elapsed -> background worker sets is_published = true  
    -> Kafka (review.published)  
    -> Rating update workers -> UPDATE Properties.rating, [Users.host](https://x.com//Users.host)_rating / guest_rating  
    -> Search Indexing Worker -> UPDATE Elasticsearch document rating field  
    -> Notification Service -> published confirmation to both parties

<<<SECTION 12>>>
## 13. Resilience and Fault Tolerance

**PostgreSQL pessimistic locking** with SELECT FOR UPDATE is the primary correctness guarantee. It is impossible for two bookings to succeed for the same property on the same dates because the database enforces serialization at the row level. No amount of concurrent requests can bypass this guarantee.

**Two-phase reservation with TTL** ensures locks are held for milliseconds rather than minutes. If a guest abandons the payment screen, the 10-minute reservation TTL automatically releases the hold. The Expiry Worker as a safety net catches any reservations the TTL mechanism misses.

**Saga compensating transactions** ensure that payment failure always releases the availability reservation. The system never gets stuck with dates marked reserved but no corresponding booking or payment.

**Kafka durability** throughout the booking pipeline means no event is lost even if downstream services are temporarily unavailable. All saga steps can retry from Kafka offsets independently.

**Idempotency keys** on bookings and payments prevent duplicate bookings and double charges under any retry or network failure scenario.

**Redis bitmap fast path** for availability search means search queries never hold PostgreSQL locks. The authoritative lock only applies during actual booking attempts, keeping the database free for concurrent booking transactions.

**CDN caching** for property photos means images are served from edge nodes globally. Property photos change rarely, so cache hit rates are very high.

**Blind review publication** is enforced at the database level via the is_published flag and a background worker. Even if the Notification Service fails, reviews are eventually published by the worker on its next run.

**Elasticsearch availability sync** is eventually consistent but that is acceptable for search. A property might appear in search results for a few minutes after being fully booked. The Redis bitmap check and the final PostgreSQL lock during actual booking prevent any double booking despite this eventual consistency in search.

<<<SECTION 13>>>
## 14. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, host/guest traffic routing)

**Blob Storage** -> AWS S3 (Property photos, durable, CDN-native)

**CDN** -> CloudFront / Akamai (Edge caching for property photos, high cache hit rate since photos rarely change)

**Decoupling** -> Apache Kafka (Booking saga events, listing updates, review publication, payout triggers)

**Search Engine** -> Elasticsearch with geo_point (Combined geo-radius, date availability, price, rating, amenity filtering in single query)

**Properties DB** -> PostgreSQL sharded + replicas (Listing metadata, strong consistency for pricing and host info)

**Availability DB** -> PostgreSQL with row-level locking (Calendar table pattern, SELECT FOR UPDATE for double booking prevention)

**Bookings DB** -> PostgreSQL (Booking state machine, idempotency keys, saga orchestration)

**Payments DB** -> PostgreSQL (Financial records, guest charges, host payouts, idempotency)

**Reviews DB** -> PostgreSQL (Dual blind review system, deferred publication)

**Availability Fast Path** -> Redis bitmaps (Per-property per-month availability, bitwise AND for date range checks, search pre-filter)

**Property Metadata Cache** -> Redis MGET (Batch hydration of search results and listing pages)

**User Profile Cache** -> Redis (Host and guest profiles, subscription status, response rate signals)

**Reservation Expiry** -> Background worker + PostgreSQL TTL field (Auto-release of abandoned reservations)

**Payout Scheduling** -> Kafka delayed events + Payout Worker (24-hour hold after check-in before host payout)

**Notification Delivery** -> APNs + FCM + AWS SES (Transactional booking notifications, no coalescing needed)

That's all, folks....Cheers!
