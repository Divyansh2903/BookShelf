# Design Amazon

<<<SECTION 1>>>
## High-Level Design: Amazon

## 1. Requirements

**Functional:** user and seller profile management; product catalog (browse, view details); product search; cart (add, remove, update quantity); order placement and tracking; payment processing; inventory management; warehouse and fulfillment pipeline; reviews and ratings; notifications (order confirmation, shipping updates, delivery).

**Out of scope:** ML recommendation pipeline; support chatbot; Prime/subscriptions; Ads and sponsored listings; returns and refunds; warehouse robotics and physical fulfillment internals.

**Non-functional:**
- High availability for catalog, search, and orders
- Strong consistency for price, inventory count, payment state
- Eventual consistency OK for descriptions, reviews, recommendations
- No overselling under any traffic, including flash sales
- Exactly-once payments: never double charge
- Search and catalog reads under 100ms
- Fulfillment handles partial failures via compensating transactions

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 50 million
- **Orders:** 2-3% conversion -> 1 to 1.5 million/day
- **Catalog:** 350 million products
- **Images:** 5 per product at 1 MB -> 5 MB/product; 350M × 5 MB -> ~1.75 PB (written once, rarely updated)
- **Demo videos:** ~10% of products, 50 MB each -> ~1.75 PB more
- **Metadata:** ~10 KB/product -> ~3.5 TB
- **Order data:** 1M orders × 10 KB -> ~10 GB/day (negligible)
- **Peak:** flash sales cause write spikes up to 100,000 requests/second on a single product

Storage is dominated by petabyte-scale media, written once. The hard systems problem is inventory consistency in flash sales, not storage. Unlike social platforms (hardest problem: read-time feed generation), Amazon's is write consistency during coordinated purchase spikes.

<<<SECTION 3>>>
## 3. API Gateway

Handles authentication, rate limiting, routing. It never carries binary media: seller image/video uploads go directly to S3 via presigned URLs after authentication.

Extra duty: **request classification**. Reads (browse, search, product pages) and writes (orders, inventory, payments) have very different scaling and consistency needs, so the Gateway routes them to separate clusters with separate scaling policies. A flash-sale write spike then can't degrade browsing for others.

## 4. User and Seller Profile Services

**User Profile Service:** customer name, shipping addresses, payment methods, order history, wishlist.

- **Users (PostgreSQL):** user_id UUID PK; email VARCHAR unique; name VARCHAR; phone VARCHAR; created_at TIMESTAMP.
- **Addresses (PostgreSQL):** address_id UUID PK; user_id UUID FK -> Users; line_1, line_2, city, state, country, pincode VARCHAR; is_default BOOLEAN.

Users can have multiple addresses; the default is flagged for fast checkout. Profiles are cached in Redis, since they're read on every order and checkout.

### Seller Profile Service

Business name, GST/tax info, bank account for payouts, seller ratings.

**Sellers (PostgreSQL):** seller_id UUID PK; business_name VARCHAR; email VARCHAR unique; phone VARCHAR; gstin VARCHAR; bank_account_id UUID; rating FLOAT; total_reviews INTEGER; created_at TIMESTAMP.

Seller profiles are strongly consistent (tied to financial transactions and legal compliance); no eventual consistency for bank or tax info. Seller ratings are denormalized counters updated asynchronously by Kafka consumers from the Reviews Service.

<<<SECTION 4>>>
## 5. Product Catalog Service and Upload Pipeline

The most read-heavy service: every browse, search, and product page view hits it. 350 million products × 50 million DAU browsing several products per session means enormous read load.

### Seller Upload Flow

1. Seller authenticates via API Gateway and gets presigned S3 URLs from the Catalog Service.
2. Seller uploads images and demo videos directly to S3.
3. S3 emits upload events to Kafka.
4. **Transcoding Service** processes them:
   - Images: thumbnail (search results), medium (product grid), full resolution (zoom); WebP compression.
   - Videos: 360p, 720p, 1080p variants; HLS segments for adaptive streaming; preview thumbnail.
5. Variants stored in S3 under media/{product_id}/{variant}/.
6. Transcoding Service publishes product.transcoded to Kafka.
7. Two independent consumers: **Metadata Worker** writes to the Products DB and fills the Redis Product Metadata Cache; **Search Indexing Worker** indexes into Elasticsearch.

### Data Model

**Products (PostgreSQL):** product_id UUID PK; seller_id UUID FK -> Sellers; name VARCHAR; description TEXT; category, subcategory, brand VARCHAR; price DECIMAL(10,2); mrp DECIMAL(10,2); media_urls JSONB (array of S3/CDN URLs per variant); attributes JSONB (color, size, weight, dimensions etc); rating FLOAT; review_count INTEGER; is_active BOOLEAN; created_at, updated_at TIMESTAMP.

**Price** lives on Products and is strongly consistent. A seller price update triggers an immediate PostgreSQL write, Redis cache invalidation, and an Elasticsearch reindex event via Kafka. The stale window is minimized because wrong prices are a legal and trust risk.

**attributes** is JSONB because attributes vary by category (laptop: RAM, processor, screen size; shirt: color, size, fabric). JSONB gives a flexible schema without per-type tables.

### Product Page Read Path

Five fetches run in parallel (**scatter-gather**); the page renders once all complete:

1. Metadata (name, description, price, attributes) -> Redis, PostgreSQL on miss
2. Media URLs -> served by CDN, no backend
3. Inventory count -> Inventory Service (Redis real-time count)
4. Seller info (name, rating) -> Seller Profile Service (Redis cache)
5. Top reviews -> Reviews Service (PostgreSQL, cached in Redis)

### Caching Strategy

Traffic follows an extreme power law: the top 1% of products drive ~90% of traffic. Hot products (bestsellers, trending, flash sale items) are cached aggressively in Redis with longer TTLs; cold niche products are served from PostgreSQL without caching overhead.

For the most viral flash-sale products, multi-layer caching:
- **L1** -> local in-memory cache per app server (Caffeine LRU)
- **L2** -> Redis
- **L3** -> PostgreSQL

**Bottlenecks:** Transcoding is the bottleneck for new listings with media; handled with horizontally scaled worker pools. On reads, Redis memory can't hold 350 million products, so selective hot-product caching (not full-catalog) is essential.

<<<SECTION 5>>>
## 6. Search Service

The most commercially critical service: users who can't find a product can't buy it, so latency and relevance drive revenue.

**Elasticsearch** handles full-text search, faceted filtering, and relevance ranking across 350 million product documents.

### Product document:

{
  "product_id": "123",
  "name": "Sony WH-1000XM5 Wireless Headphones",
  "description": "Industry leading noise cancellation...",
  "category": "Electronics",
  "subcategory": "Headphones",
  "brand": "Sony",
  "price": 29990,
  "rating": 4.5,
  "review_count": 12000,
  "prime_eligible": true,
  "in_stock": true,
  "seller_id": "456",
  "attributes": {
    "color": "Black",
    "connectivity": "Bluetooth",
    "battery_life": "30 hours"
  }
}

**Ranking signals:**
- Text match score: query vs. name, description, brand
- Sales velocity: products selling well for this query rank higher
- Rating and review count: higher and more rank higher
- Price competitiveness within a category
- Prime eligibility: boost for Prime users
- In-stock status: out-of-stock deprioritized

**Autocomplete:** typing "son" shows "sony headphones", "sony tv", "sony camera", via a Redis Sorted Set (Key: autocomplete:son; Member: "sony headphones"; Score: search frequency). ZREVRANGE autocomplete:son 0 4 returns the top 5 instantly. A background worker updates the set by periodically analyzing search query logs.

**Faceted filtering:** price range, brand, rating, Prime eligibility, and category-specific attributes (TV screen size, shoe size), applied as Elasticsearch post-query filters on indexed fields. A composite index on (category, price, rating, in_stock) keeps filtered queries fast across 350 million documents.

**Keeping Elasticsearch in sync:** the Search Indexing Worker consumes product.transcoded and product.updated topics. Price changes sync immediately (stale search prices create trust issues); rating and review count updates are batched periodically.

**Bottlenecks:** 350 million documents need a large cluster with lots of memory for index caching. Hot queries ("iphone", "laptop", "headphones") are cached in Redis with short TTLs. Autocomplete is served entirely from Redis, never Elasticsearch.

<<<SECTION 6>>>
## 7. Cart Service

Carts are temporary, frequently updated, and must be fast.

**Storage: Redis primary, PostgreSQL backup.** Cart operations (add, remove, update quantity, view) are frequent and latency-sensitive; a slow cart ruins shopping.

Key: cart:{user_id}; Value: Hash { product_id: quantity, ... }; TTL: 30 days (persists across sessions).

- Add item: HSET cart:user_123 product_456 2
- Remove item: HDEL cart:user_123 product_456
- View cart: HGETALL cart:user_123
- Update quantity: HSET cart:user_123 product_456 3

### All O(1) operations. The cart read for checkout is a single HGETALL call.

Carts are also persisted asynchronously to PostgreSQL via a Kafka consumer. If Redis fails, carts are rebuilt from PostgreSQL next session; losing the last few additions is acceptable for ephemeral carts.

**Checkout validation** of every item:
1. Fetch current price from Catalog Service and compare with the cart price; if changed, notify the user before proceeding.
2. Check availability with Inventory Service; if any item is out of stock, notify the user before proceeding.

Validation happens at checkout, not add-to-cart, because prices and stock change constantly in between.

**Bottlenecks:** Redis handles cart ops trivially. Checkout validation is the bottleneck: parallel Catalog and Inventory calls per item (20+ items means 20 parallel inventory checks). Mitigated by running all checks simultaneously (scatter-gather) and enforcing a reasonable cart size limit.

<<<SECTION 7>>>
## 8. Inventory Service

The most consistency-critical service. Overselling is a severe operational failure; underselling (blocking valid purchases on stale counts) costs revenue.

**Storage: Redis + PostgreSQL.** Counts live in Redis for fast real-time reads/writes; PostgreSQL is the source of truth, updated asynchronously.

- Key: inventory:{product_id}; Value: available_count (integer)
- Multi-seller/multi-warehouse products, tracked per seller per warehouse: Key: inventory:{product_id}:{seller_id}:{warehouse_id}; Value: available_count

### Reservation Flow

On order placement, inventory is reserved (not decremented) until payment confirms:

1. **Reserve:** DECRBY inventory:product_id 1 under a distributed lock
2. Record reservation in the **Reservations Table** with a TTL (15 minutes)
3. Payment succeeds -> reservation becomes a confirmed sale; inventory permanently decremented in PostgreSQL
4. Payment fails -> reservation released: INCRBY inventory:product_id 1
5. User abandons checkout -> TTL expires, inventory auto-released

This two-phase reserve-then-confirm prevents overselling without permanently decrementing until payment is guaranteed.

### Distributed Lock for Inventory

SET lock:inventory:product_id <lock_id> NX EX 5

NX = set only if not exists (atomic acquisition). EX 5 = expires after 5 seconds (prevents deadlock if the holder crashes). Only one instance holds the lock; it's released right after the reservation is recorded.

### Flash Sale Queue-Based Load Leveling

At 100,000 requests/second on one product, requests don't compete for the lock; they go into a Kafka topic, flash_sale_orders:{product_id}. A single **Inventory Worker** processes them sequentially, checking and decrementing one at a time. Users get an immediate "your order is being processed" response; success or failure arrives asynchronously via the Notification Service. Lock contention is eliminated.

**Reservations (PostgreSQL):** reservation_id UUID PK; order_id UUID FK -> Orders; product_id UUID FK -> Products; seller_id UUID FK -> Sellers; quantity INTEGER; status ENUM('reserved', 'confirmed', 'released'); expires_at TIMESTAMP; created_at TIMESTAMP.

**Bottlenecks:** outside flash sales, the lock is the bottleneck for high-demand products, but Redis acquire/release takes microseconds, so normal throughput is very high. Flash sales use the Kafka queue pattern.

<<<SECTION 8>>>
## 9. Order Service and Saga Pattern

The Order Service orchestrates purchases with the **Saga pattern**. An order spans multiple independent services that can each fail; failures at any step trigger compensating transactions that undo completed steps, keeping the system consistent.

### Full Saga Flow

1. **Order created:** user clicks Place Order; Order Service creates the order as PENDING and publishes order.created.
2. **Inventory reservation:** Inventory Service consumes order.created and reserves stock.
   - Success -> inventory.reserved
   - Failure -> inventory.failed -> order marked FAILED, user notified
3. **Payment:** Payment Service consumes inventory.reserved and charges the user.
   - Success -> payment.completed
   - Failure -> payment.failed -> **compensating transaction:** Inventory Service releases the reservation -> order marked FAILED, user notified, no charge
4. **Order confirmed:** Order Service consumes payment.completed, marks CONFIRMED, publishes order.confirmed.
5. **Warehouse notified:** Warehouse Service consumes order.confirmed, creates a pick-and-pack job, publishes warehouse.notified.
6. **User notified:** Notification Service consumes order.confirmed and warehouse.notified; sends confirmation email and push.
7. **Shipping updates:** warehouse publishes order.shipped and order.out_for_delivery; Notification Service sends an update at each.

**Orders (PostgreSQL):** order_id UUID PK; user_id UUID FK -> Users; status ENUM('pending', 'confirmed', 'shipped', 'delivered', 'failed', 'cancelled'); total_amount DECIMAL(10,2); shipping_address JSONB; placed_at, updated_at TIMESTAMP.

**OrderItems (PostgreSQL):** order_item_id UUID PK; order_id UUID FK -> Orders; product_id UUID FK -> Products; seller_id UUID FK -> Sellers; quantity INTEGER; unit_price DECIMAL(10,2).

unit_price is stored at order time, not referenced from Products, so order history reflects what the user actually paid even if the price changes.

**Bottlenecks:** the Order Service is stateless and horizontally scalable; the bottleneck is Saga orchestration at high volume. Kafka provides durability and decoupling, so each step retries independently without restarting the flow. Idempotency keys on all Kafka consumers prevent duplicate processing on retries.

<<<SECTION 9>>>
## 10. Payment Service

The most financially critical service: double charging is a severe trust failure, a missed payment is lost revenue. Both must be prevented.

**Idempotency keys:** each payment request carries a unique key from the Order Service (typically the order_id). A repeated key (e.g. network retry) returns the first attempt's result without charging again. Keys are stored in Redis with a 24-hour TTL.

**Gateway integration** (Razorpay, Stripe, bank networks):
1. Receive inventory.reserved from Kafka
2. Call the gateway with amount, payment method, and idempotency key
3. Gateway returns success or failure
4. Record result in the Payments Table
5. Publish payment.completed or payment.failed to Kafka

**Payments (PostgreSQL):** payment_id UUID PK; order_id UUID FK -> Orders; user_id UUID FK -> Users; amount DECIMAL(10,2); currency VARCHAR; gateway VARCHAR (razorpay, stripe etc); gateway_txn_id VARCHAR; status ENUM('pending', 'processing', 'completed', 'failed', 'refunded'); idempotency_key VARCHAR unique; created_at, updated_at TIMESTAMP.

**Bottlenecks:** the external gateway is the latency source (500ms to 2 seconds per call). Payment processing is fully asynchronous via Kafka, so users never wait on the gateway during checkout.

<<<SECTION 10>>>
## 11. Reviews and Ratings Service

Reviews are eventually consistent and write-once (only after a confirmed purchase).

**Reviews (PostgreSQL):** review_id UUID PK; product_id UUID FK -> Products; user_id UUID FK -> Users; order_id UUID FK -> Orders; rating INTEGER (1-5); title VARCHAR; content TEXT; created_at TIMESTAMP; UNIQUE (product_id, user_id).

The UNIQUE constraint allows one review per user per product; the order_id foreign key restricts reviews to verified purchasers.

Product rating and review_count on Products are denormalized counters updated asynchronously by Kafka consumers on each new review. Hot product reviews are cached in Redis; the Search Indexing Worker periodically syncs ratings to Elasticsearch.

<<<SECTION 11>>>
## 12. Notification Service

Same architecture as Instagram and Twitter: Kafka fanout from all services, APNs (iOS), FCM (Android), email via SES (Simple Email Service).

Subscribed events:
- order.confirmed -> confirmation email + push
- warehouse.notified -> "your order is being prepared"
- order.shipped -> shipping confirmation with tracking number
- order.out_for_delivery -> "arriving today"
- order.delivered -> delivery confirmation + review prompt
- payment.failed -> failure notice with retry instructions
- inventory.failed -> out of stock notice

Unlike social platforms, where coalescing matters (500 likes into one notification), Amazon notifications are transactional and delivered individually, one per order lifecycle event.

<<<SECTION 12>>>
## 13. Full Data Flow Summary

**Product listing (seller):**
- Seller -> API Gateway (auth) -> Catalog Service -> presigned S3 URLs
- Seller -> S3 (direct upload of images and videos)
- S3 -> Kafka -> Transcoding Service -> S3 (all variants)
- Transcoding Service -> Kafka (product.transcoded) -> Metadata Worker -> Products DB + Redis Cache; Search Worker -> Elasticsearch

**Product page read:** Client -> API Gateway -> Catalog Service, in parallel: Redis (metadata cache); Inventory Service -> Redis (count); Seller Service -> Redis (seller info); Reviews Service -> Redis (top reviews); CDN (media). Scatter-gather assembles the page.

**Search:** Client -> Search Service -> Redis (autocomplete sorted set for prefix) -> Redis (hot query cache) -> Elasticsearch (on miss, full search with facets) -> Redis MGET (hydrate result metadata).

**Cart:** Client -> Cart Service -> Redis HSET/HDEL/HGETALL cart:{user_id} -> Kafka -> PostgreSQL (async persistence). Checkout -> Cart Service -> Inventory Service (parallel stock checks) and Catalog Service (parallel price validation).

**Order and Saga:** client places order -> Order Service -> PENDING -> Kafka (order.created)
- Inventory Service reserves stock -> Kafka (inventory.reserved / inventory.failed)
- Payment Service charges -> Kafka (payment.completed / payment.failed); on failure Inventory Service releases the reservation (compensating transaction)
- Order Service: CONFIRMED -> Kafka (order.confirmed)
- Warehouse Service: pick and pack -> Kafka (warehouse.notified)
- Notification Service: confirmation -> APNs / FCM / SES

**Flash sale:** 100,000 users hit buy at once -> Order Service -> Kafka flash_sale_orders:{product_id} -> Inventory Worker processes sequentially -> no lock contention; users notified asynchronously.

**Payment:** Payment Service <- Kafka (inventory.reserved) -> check idempotency key in Redis -> call gateway (Razorpay / Stripe) -> write Payments Table (PostgreSQL) -> Kafka (payment.completed / payment.failed).

<<<SECTION 13>>>
## 14. Resilience and Fault Tolerance

- **Saga compensating transactions:** no partial order state is permanent. Payment failure always releases the reservation; inventory failure always prevents payment. The system never sticks in an inconsistent state as long as Kafka is durable.
- **Kafka durability:** no order event is lost if downstream services are down; each Saga step retries from its Kafka offset without restarting the flow.
- **Idempotency keys:** prevent double charging under any retry or network failure; one order_id can never yield two successful charges.
- **Two-phase inventory reservation:** reserve at order placement, confirm only after payment; abandoned reservations expire via TTL. Prevents overselling.
- **Distributed lock with TTL:** prevents races in concurrent purchases; the 5-second TTL guarantees release if the holder crashes, preventing deadlocks.
- **Kafka queue-based load leveling:** eliminates flash-sale lock contention; the Inventory Worker processes at a sustainable rate regardless of the spike.
- **Multi-layer caching (L1/L2/L3):** removes the read-side hot key problem in flash sales; the most popular metadata is served from app-server local memory.
- **Redis cart persistence to PostgreSQL:** carts survive Redis failure; at most a few recent additions are lost.
- **CDN caching:** all media served from global edge nodes, no origin involvement on hits.
- **PostgreSQL read replicas** for all services: no single point of failure for reads.

<<<SECTION 14>>>
## 15. Technology Choices Summary

- **API Gateway** -> Kong / AWS API Gateway (auth, rate limiting, read/write traffic separation)
- **Blob Storage** -> AWS S3 (product images and videos, durable, CDN-native)
- **CDN** -> CloudFront / Akamai (edge caching for media, high hit rate)
- **Transcoding** -> horizontally scaled worker pool via Kafka (image variants, HLS video chunking)
- **Decoupling** -> Apache Kafka (Saga orchestration, inventory events, search indexing, notifications)
- **Search Engine** -> Elasticsearch (full-text, faceted filtering, ranking across 350M products)
- **Autocomplete** -> Redis Sorted Sets (prefix suggestions, sub-millisecond reads)
- **Product Catalog DB** -> PostgreSQL sharded + replicas (structured metadata, strong price consistency)
- **Orders / Payments DB** -> PostgreSQL (ACID, financial records, order state machine)
- **Inventory Store** -> Redis + PostgreSQL (real-time counts in Redis, source of truth in PostgreSQL)
- **Distributed Lock** -> Redis SETNX with TTL (inventory reservation, prevents overselling)
- **Flash Sale Queue** -> Apache Kafka (queue-based load leveling, no lock contention)
- **Cart Store** -> Redis Hash + PostgreSQL backup (sub-millisecond ops, async persistence)
- **Product Metadata Cache** -> Redis + L1 local in-memory (multi-layer hot key mitigation)
- **Idempotency Store** -> Redis with TTL (no double charging on retries)
- **Notification Delivery** -> APNs + FCM + AWS SES (push and transactional email)
- **Reviews DB** -> PostgreSQL (verified purchase enforcement, UNIQUE per user per product)
