# Design Amazon

<<<SECTION 1>>>
## High-Level Design: Amazon

## 1. Requirements

Functional Requirements

- User profile and seller profile management
- Product catalog (browse and view product details)
- Search for products
- Cart management (add, remove, update quantity)
- Order placement and order tracking
- Payment processing
- Inventory management
- Warehouse and fulfillment pipeline
- Product reviews and ratings
- Notifications (order confirmation, shipping updates, delivery)

Out of Scope

- ML recommendation pipeline
- Customer support chatbot
- Amazon Prime / subscription management
- Amazon Ads and sponsored listings
- Returns and refunds flow
- Warehouse robotics and physical fulfillment internals

Non-Functional Requirements

- High availability across catalog, search, and order services
- Strong consistency for price, inventory count, and payment state
- Eventual consistency acceptable for product descriptions, reviews, and recommendations
- No overselling under any traffic condition including flash sales
- Exactly once payment processing, a user must never be double charged
- Low latency product search and catalog reads under 100ms
- Order fulfillment pipeline must handle partial failures gracefully via compensating transactions

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 50 million
- **Orders per day:** 2-3% conversion rate -> 1 to 1.5 million orders per day
- **Products in catalog:** 350 million
- **Average product images:** 5 images per product at 1 MB each -> 5 MB per product
- **Total image storage:** 350M x 5 MB -> ~1.75 PB total (written once, updated rarely)
- **Demo videos:** ~10% of products have demo videos at 50 MB each -> ~1.75 PB additional
- **Product metadata:** ~10 KB per product -> 350M x 10 KB -> ~3.5 TB for metadata
- **Daily order data:** 1M orders x 10 KB per order record -> ~10 GB per day (negligible)
- **Peak traffic:** flash sales create extreme write spikes on inventory, up to 100,000 requests per second on a single product

The dominant storage concern is product media at petabyte scale, written once and rarely updated. The dominant systems challenge is inventory consistency under flash sale conditions, not raw storage volume. Unlike social platforms where the hardest problem is feed generation at read time, Amazon's hardest problem is write consistency during coordinated purchase spikes.

<<<SECTION 3>>>
## 3. API Gateway

All client requests enter through the API Gateway which handles authentication, rate limiting, and routing. The same constraint as every previous design applies: the API Gateway is never in the path of binary media payloads. Product image and video uploads by sellers bypass the Gateway after authentication using presigned S3 URLs for direct client-to-S3 upload.

Amazon's API Gateway has an additional responsibility compared to social platforms: **request classification**. Read requests (browsing, searching, viewing product pages) and write requests (placing orders, updating inventory, processing payments) have completely different scaling and consistency requirements. The Gateway routes them to separate service clusters with separate scaling policies, ensuring that a flash sale write spike does not degrade browsing performance for other users.

## 4. User and Seller Profile Services

User Profile Service

Manages customer data including name, shipping addresses, payment methods, order history, and wishlist.

**Users Table (PostgreSQL)**  
Users  
user_id           UUID, primary key  
email             VARCHAR, unique  
name              VARCHAR  
phone             VARCHAR  
created_at        TIMESTAMP

**Addresses Table (PostgreSQL)**  
Addresses  
address_id    UUID, primary key  
user_id       UUID, foreign key -> Users  
line_1        VARCHAR  
line_2        VARCHAR  
city          VARCHAR  
state         VARCHAR  
country       VARCHAR  
pincode       VARCHAR  
is_default    BOOLEAN

Users can have multiple shipping addresses. The default address is flagged for fast checkout. User profiles are cached in Redis since they are read on every order placement and cart checkout.

### Seller Profile Service

Manages seller data including business name, GST and tax information, bank account details for payouts, and seller ratings.

### Sellers Table (PostgreSQL)

Sellers  
seller_id         UUID, primary key  
business_name     VARCHAR  
email             VARCHAR, unique  
phone             VARCHAR  
gstin             VARCHAR  
bank_account_id   UUID  
rating            FLOAT  
total_reviews     INTEGER  
created_at        TIMESTAMP

Seller profiles are strongly consistent since they are tied to financial transactions and legal compliance. No eventual consistency is acceptable for seller bank account or tax information. Seller ratings are denormalized counters updated asynchronously via Kafka consumers from the Reviews Service.

<<<SECTION 4>>>
## 5. Product Catalog Service and Upload Pipeline

The Product Catalog Service is the most read-heavy service in the system. Every browse, search, and product page view hits this service. At 350 million products with 50 million DAU browsing multiple products per session, the read load is enormous.

### Seller Upload Flow

When a seller lists a new product:

1. Seller authenticates via API Gateway and requests presigned S3 URLs from the Catalog Service
1. Seller uploads product images and demo videos directly to S3
1. S3 emits upload events to Kafka
1. **Transcoding Service** picks up the events and processes:Images: generates thumbnail (for search results), medium (for product grid), and full resolution (for product page zoom) variants, applies WebP compression  
Videos: generates multiple quality variants (360p, 720p, 1080p), chunks into HLS segments for adaptive streaming, generates a preview thumbnail
1. All variants stored in S3 under media/{product_id}/{variant}/
1. Transcoding Service publishes product.transcoded event to Kafka
1. Two consumers pick up the event independently:**Metadata Worker** writes product metadata to the Products DB and populates the Product Metadata Cache in Redis  
**Search Indexing Worker** indexes the product into Elasticsearch

### Data Model

### Products Table (PostgreSQL)

Products  
product_id          UUID, primary key  
seller_id           UUID, foreign key -> Sellers  
name                VARCHAR  
description         TEXT  
category            VARCHAR  
subcategory         VARCHAR  
brand               VARCHAR  
price               DECIMAL(10,2)  
mrp                 DECIMAL(10,2)  
media_urls          JSONB (array of S3/CDN URLs per variant)  
attributes          JSONB (color, size, weight, dimensions etc)  
rating              FLOAT  
review_count        INTEGER  
is_active           BOOLEAN  
created_at          TIMESTAMP  
updated_at          TIMESTAMP

Price is stored directly on the Products table and is strongly consistent. A seller updating price triggers an immediate write to PostgreSQL, a cache invalidation in Redis, and a reindex event to Elasticsearch via Kafka. The stale price window is kept as small as possible since showing wrong prices is a legal and trust risk.

attributes is stored as JSONB because product attributes vary wildly by category. A laptop has RAM, processor, and screen size. A shirt has color, size, and fabric. JSONB allows flexible schema per category without requiring separate tables per product type.

Product Page Read Path

When a user opens a product page, the following data is assembled:

1. **Product metadata** (name, description, price, attributes) -> Redis cache first, PostgreSQL on miss
1. **Media URLs** (images and video) -> CDN serves directly, no backend involved
1. **Inventory count** -> Inventory Service (Redis for real-time count)
1. **Seller info** (business name, rating) -> Seller Profile Service (Redis cache)
1. **Reviews** (top rated reviews) -> Reviews Service (PostgreSQL, cached in Redis)

All five fetches happen in parallel. The product page assembles and renders once all parallel fetches complete. This is the **scatter-gather** pattern.

### Caching Strategy

Amazon's product catalog follows an extreme power law distribution. The top 1% of products drive roughly 90% of traffic. Hot products (bestsellers, trending items, products in flash sales) are cached aggressively in Redis with longer TTLs. Cold products (niche listings with rare traffic) are served directly from PostgreSQL with no caching overhead.

Multi-layer caching applies for the most viral products during flash sales:

- **L1** -> Local in-memory cache on each application server (Caffeine LRU)
- **L2** -> Redis
- **L3** -> PostgreSQL

### Bottlenecks in the Catalog Service

The Transcoding Service is the bottleneck for new product listings with media. Horizontally scaled worker pools handle this. The read path bottleneck is Redis memory for 350 million products, which is why selective caching of hot products rather than full catalog caching is essential.

<<<SECTION 5>>>
## 6. Search Service

Amazon search is the most commercially critical service in the system. A user who cannot find a product cannot buy it. Search latency and relevance directly drive revenue.

### Storage Engine - Elasticsearch

Elasticsearch handles full-text search, faceted filtering, and relevance ranking across 350 million product documents.

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

### Ranking Signals

Amazon search ranking combines multiple signals beyond text relevance:

- **Text match score** -> how well the query matches product name, description, brand
- **Sales velocity** -> products that sell well for this query rank higher
- **Rating and review count** -> higher rated products with more reviews rank higher
- **Price competitiveness** -> within a category, competitively priced products rank higher
- **Prime eligibility** -> Prime eligible products get a ranking boost for Prime users
- **In stock status** -> out of stock products are deprioritized

### Autocomplete

When a user types "son" in the search box, autocomplete shows "sony headphones", "sony tv", "sony camera". This is powered by a Redis Sorted Set:

Key: autocomplete:son  
Member: "sony headphones"  
Score: search frequency (how often users searched this term)

ZREVRANGE autocomplete:son 0 4 returns the top 5 autocomplete suggestions instantly. The Sorted Set is updated by a background worker that analyzes search query logs periodically.

### Faceted Filtering

Amazon search supports filtering by price range, brand, rating, Prime eligibility, and category-specific attributes (screen size for TVs, shoe size for footwear). These filters are applied as Elasticsearch post-query filters on indexed fields. The composite index in Elasticsearch on (category, price, rating, in_stock) makes filtered queries fast even across 350 million documents.

### Keeping Elasticsearch in Sync

The Search Indexing Worker consumes from the product.transcoded and product.updated Kafka topics. Price changes are synced to Elasticsearch immediately since stale prices in search results create trust issues. Rating and review count updates are batched and synced periodically.

### Bottlenecks in Search

Elasticsearch performance at 350 million documents requires a large cluster with significant memory for index caching. Hot search queries ("iphone", "laptop", "headphones") are cached in Redis with short TTLs. Autocomplete is served entirely from Redis with no Elasticsearch involvement.

<<<SECTION 6>>>
## 7. Cart Service

The Cart Service manages the items a user has added to their cart before checkout. Carts are temporary, frequently updated, and must be fast to read and write.

### Storage - Redis Primary, PostgreSQL Backup

Cart data is stored primarily in Redis since cart operations (add item, remove item, update quantity, view cart) are extremely frequent and latency-sensitive. A slow cart ruins the shopping experience.

Key: cart:{user_id}  
Value: Hash { product_id: quantity, product_id: quantity, ... }  
TTL: 30 days (cart persists across sessions)

Redis Hash operations:

- Add item: HSET cart:user_123 product_456 2
- Remove item: HDEL cart:user_123 product_456
- View cart: HGETALL cart:user_123
- Update quantity: HSET cart:user_123 product_456 3

### All O(1) operations. The cart read for checkout is a single HGETALL call.

Cart data is also asynchronously persisted to PostgreSQL via a Kafka consumer. If Redis goes down, carts are rebuilt from PostgreSQL on next session. The user may lose the most recent few additions made before the Redis failure, which is acceptable given the ephemeral nature of carts.

### Price and Inventory Validation at Checkout

When a user proceeds to checkout, the Cart Service validates every item in the cart:

1. Fetch current price from Catalog Service -> compare against price stored in cart. If price changed, notify user before proceeding.
1. Check inventory availability from Inventory Service for each item. If any item is out of stock, notify user before proceeding.

This validation happens at checkout time, not at add-to-cart time, since prices and inventory change constantly between when a user adds an item and when they actually buy it.

### Bottlenecks in the Cart Service

Redis handles cart operations trivially at Amazon's scale. The checkout validation step is the bottleneck since it requires parallel calls to Catalog Service and Inventory Service for every item in the cart. Large carts with 20+ items require 20 parallel inventory checks. This is mitigated by parallelizing all checks simultaneously using the scatter-gather pattern and enforcing a reasonable cart size limit.

<<<SECTION 7>>>
## 8. Inventory Service

The Inventory Service is the most consistency-critical service in the system. Overselling inventory is a severe operational failure. Underselling (blocking valid purchases due to stale counts) directly costs revenue.

### Storage - Redis + PostgreSQL

Inventory counts are stored in Redis for fast real-time reads and writes. PostgreSQL is the source of truth, updated asynchronously.

Key: inventory:{product_id}  
Value: available_count (integer)

For products sold by multiple sellers or across multiple warehouses, inventory is tracked per seller per warehouse:

Key: inventory:{product_id}:{seller_id}:{warehouse_id}  
Value: available_count

### Reservation Flow

When a user places an order, inventory is reserved (not decremented) until payment confirms:

1. **Reserve:** DECRBY inventory:product_id 1 with a distributed lock
1. Record reservation in **Reservations Table** with a TTL (15 minutes)
1. If payment succeeds -> reservation converts to a confirmed sale, inventory permanently decremented in PostgreSQL
1. If payment fails -> reservation is released, INCRBY inventory:product_id 1
1. If user abandons checkout -> reservation TTL expires, inventory auto-released

This two-phase reserve-then-confirm pattern prevents overselling while not permanently decrementing inventory until payment is guaranteed.

### Distributed Lock for Inventory

SET lock:inventory:product_id <lock_id> NX EX 5

NX means set only if not exists (atomic acquisition). EX 5 means lock expires after 5 seconds (prevents deadlocks if the holder crashes). Only one service instance can hold the lock at a time. The lock is released immediately after the reservation is recorded.

### Flash Sale Queue-Based Load Leveling

During a flash sale, 100,000 requests per second hit a single product's inventory. Rather than all requests competing for the distributed lock simultaneously, they are pushed into a Kafka topic:

flash_sale_orders:{product_id}

A single **Inventory Worker** processes orders sequentially from this topic, checking and decrementing inventory one at a time. Users receive an immediate "your order is being processed" response. Success or failure is communicated asynchronously via the Notification Service. This eliminates lock contention entirely during flash sales.

### Reservations Table (PostgreSQL)

**Reservations**  
  
reservation_id    UUID, primary key  
order_id          UUID, foreign key -> Orders  
product_id        UUID, foreign key -> Products  
seller_id         UUID, foreign key -> Sellers  
quantity          INTEGER  
status            ENUM('reserved', 'confirmed', 'released')  
expires_at        TIMESTAMP  
created_at        TIMESTAMP

### Bottlenecks in the Inventory Service

The distributed lock is the bottleneck for high-demand products outside of flash sales. Lock acquisition and release happen in microseconds in Redis, so in practice the throughput is very high for normal traffic. Flash sale scenarios are handled by the Kafka queue pattern which eliminates lock contention entirely.

<<<SECTION 8>>>
## 9. Order Service and Saga Pattern

The Order Service orchestrates the entire purchase flow using the **Saga pattern** for distributed transactions. Placing an order involves multiple independent services, each of which can fail. The Saga pattern ensures that failures at any step trigger compensating transactions to undo completed steps, leaving the system in a consistent state.

### Full Saga Flow

**Step 1 (Order Created) -** User clicks Place Order. Order Service creates an order record in PENDING state and publishes order.created to Kafka.

**Step 2 (Inventory Reservation)-** Inventory Service consumes order.created, attempts to reserve stock.

- Success -> publishes inventory.reserved
- Failure -> publishes inventory.failed -> Order Service marks order FAILED, user notified

**Step 3 (Payment Processing)-** Payment Service consumes inventory.reserved, charges the user's payment method.

- Success -> publishes payment.completed
- Failure -> publishes payment.failed-> **Compensating transaction:** Inventory Service releases reservation -> Order Service marks order FAILED, user notified, no charge made

**Step 4 (Order Confirmed) -** Order Service consumes payment.completed, marks order CONFIRMED, publishes order.confirmed.

**Step 5 (Warehouse Notified)-** Warehouse Service consumes order.confirmed, creates a pick-and-pack job, publishes warehouse.notified.

**Step 6 (User Notified) -** Notification Service consumes order.confirmed and warehouse.notified, sends order confirmation email and push notification.

**Step 7 (Shipping Updates)-** As the warehouse processes the order, it publishes order.shipped and order.out_for_delivery events. Notification Service sends updates at each step.

### Orders Table (PostgreSQL)

Orders  
order_id          UUID, primary key  
user_id           UUID, foreign key -> Users  
status            ENUM('pending', 'confirmed', 'shipped', 'delivered', 'failed', 'cancelled')  
total_amount      DECIMAL(10,2)  
shipping_address  JSONB  
placed_at         TIMESTAMP  
updated_at        TIMESTAMP

### OrderItems Table (PostgreSQL)

OrderItems  
order_item_id   UUID, primary key  
order_id        UUID, foreign key -> Orders  
product_id      UUID, foreign key -> Products  
seller_id       UUID, foreign key -> Sellers  
quantity        INTEGER  
unit_price      DECIMAL(10,2)

Unit price is stored at order time, not referenced from the Products table. This ensures the order history always reflects what the user actually paid, even if the product price changes later.

### Bottlenecks in the Order Service

The Order Service itself is stateless and horizontally scalable. The bottleneck is the Saga orchestration under high order volume. Kafka provides the durability and decoupling that makes the Saga pattern resilient. Each step can retry independently without restarting the entire flow. Idempotency keys on all Kafka consumers prevent duplicate processing if a consumer retries a message.

<<<SECTION 9>>>
## 10. Payment Service

The Payment Service is the most financially critical service in the system. Double charging a user is a severe trust failure. Missing a payment is a revenue loss. Both must be prevented.

### Idempotency Keys

Every payment request includes a unique idempotency key generated by the Order Service (typically the order_id). If the Payment Service receives the same idempotency key twice (due to network retry), it returns the result of the first attempt without charging the user again. Idempotency keys are stored in Redis with a TTL of 24 hours.

### Payment Gateway Integration

The Payment Service integrates with external payment gateways (Razorpay, Stripe, bank networks). The flow is:

1. Payment Service receives inventory.reserved event from Kafka
1. Calls external payment gateway with amount, user payment method, and idempotency key
1. Gateway responds with success or failure
1. Payment Service records the result in the Payments Table
1. Publishes payment.completed or payment.failed to Kafka

Payments Table (PostgreSQL)

Payments  
payment_id        UUID, primary key  
order_id          UUID, foreign key -> Orders  
user_id           UUID, foreign key -> Users  
amount            DECIMAL(10,2)  
currency          VARCHAR  
gateway           VARCHAR (razorpay, stripe etc)  
gateway_txn_id    VARCHAR  
status            ENUM('pending', 'processing', 'completed', 'failed', 'refunded')  
idempotency_key   VARCHAR, unique  
created_at        TIMESTAMP  
updated_at        TIMESTAMP

Bottlenecks in the Payment Service

The external payment gateway is the bottleneck and latency source. Gateway calls typically take 500ms to 2 seconds. This is handled by making payment processing fully asynchronous via Kafka. Users never wait for the gateway synchronously during checkout.

<<<SECTION 10>>>
## 11. Reviews and Ratings Service

Reviews are eventually consistent and write-once (a user can review a product only after a confirmed purchase).

### Reviews Table (PostgreSQL)

Reviews  
review_id     UUID, primary key  
product_id    UUID, foreign key -> Products  
user_id       UUID, foreign key -> Users  
order_id      UUID, foreign key -> Orders  
rating        INTEGER (1-5)  
title         VARCHAR  
content       TEXT  
created_at    TIMESTAMP  
UNIQUE (product_id, user_id)

The UNIQUE constraint on (product_id, user_id) ensures a user can only review a product once. The order_id foreign key ensures only verified purchasers can leave reviews.

Product rating and review count on the Products table are denormalized counters updated asynchronously via Kafka consumers whenever a new review is submitted. Hot product reviews are cached in Redis. The Search Indexing Worker periodically syncs updated ratings to Elasticsearch.

<<<SECTION 11>>>
## 12. Notification Service

Same architecture as Instagram and Twitter. Kafka fanout from all services, APNs for iOS, FCM for Android, email via SES (Simple Email Service).

The Notification Service subscribes to:

- order.confirmed -> order confirmation email + push notification
- warehouse.notified -> "your order is being prepared" notification
- order.shipped -> shipping confirmation with tracking number
- order.out_for_delivery -> "arriving today" notification
- order.delivered -> delivery confirmation + review prompt
- payment.failed -> payment failure notification with retry instructions
- inventory.failed -> out of stock notification

Unlike social platforms where notification coalescing is critical (batching 500 likes into one notification), Amazon notifications are transactional and must be delivered individually. Each event in the order lifecycle deserves its own notification.

<<<SECTION 12>>>
## 13. Full Data Flow Summary

Product Listing Flow (Seller):  
Seller -> API Gateway (auth) -> Catalog Service -> presigned S3 URLs  
Seller -> S3 (direct upload of images and videos)  
S3 -> Kafka -> Transcoding Service -> S3 (all variants)  
Transcoding Service -> Kafka (product.transcoded)  
    -> Metadata Worker      -> Products DB + Redis Cache  
    -> Search Worker        -> Elasticsearch  
  
Product Page Read Flow:  
Client -> API Gateway -> Catalog Service  
    -> Redis (product metadata cache) \[parallel\]  
    -> Inventory Service -> Redis (inventory count) \[parallel\]  
    -> Seller Service -> Redis (seller info cache) \[parallel\]  
    -> Reviews Service -> Redis (top reviews cache) \[parallel\]  
    -> CDN (media URLs served directly) \[parallel\]  
-> Scatter-gather assembles full product page  
  
Search Flow:  
Client -> Search Service  
    -> Redis (autocomplete sorted set for prefix)  
    -> Redis (hot query cache)  
    -> Elasticsearch (cache miss, full search with facets)  
    -> Redis MGET (hydrate product metadata for results)  
  
Cart Flow:  
Client -> Cart Service  
    -> Redis HSET/HDEL/HGETALL cart:{user_id}  
    -> Kafka -> PostgreSQL (async cart persistence)  
Checkout -> Cart Service  
    -> Inventory Service (parallel stock checks for all items)  
    -> Catalog Service (parallel price validation for all items)  
  
Order and Saga Flow:  
Client places order -> Order Service -> order PENDING -> Kafka (order.created)  
    -> Inventory Service: reserve stock -> Kafka (inventory.reserved / inventory.failed)  
    -> Payment Service: charge user -> Kafka (payment.completed / payment.failed)  
        -> On failure: Inventory Service releases reservation (compensating transaction)  
    -> Order Service: order CONFIRMED -> Kafka (order.confirmed)  
    -> Warehouse Service: pick and pack job -> Kafka (warehouse.notified)  
    -> Notification Service: order confirmation -> APNs / FCM / SES  
  
Flash Sale Flow:  
100,000 users hit buy simultaneously  
-> Order Service -> Kafka topic flash_sale_orders:{product_id}  
-> Inventory Worker processes sequentially, one at a time  
-> No lock contention, users notified asynchronously of success or failure  
  
Payment Flow:  
Payment Service <- Kafka (inventory.reserved)  
    -> Check idempotency key in Redis  
    -> Call payment gateway (Razorpay / Stripe)  
    -> Write to Payments Table (PostgreSQL)  
    -> Kafka (payment.completed / payment.failed)

<<<SECTION 13>>>
## 14. Resilience and Fault Tolerance

**Saga compensating transactions** ensure no partial order state is ever permanent. Payment failure always releases inventory reservation. Inventory failure always prevents payment from being attempted. The system never gets stuck in an inconsistent state as long as Kafka is durable.

**Kafka durability** throughout the order pipeline means no order event is ever lost even if downstream services are temporarily unavailable. Every step in the Saga can retry independently from its Kafka offset without restarting the entire flow.

**Idempotency keys** for payments prevent double charging under any retry or network failure scenario. The same order_id can never result in two successful payment charges.

**Two-phase inventory reservation** prevents overselling. Inventory is reserved at order placement and only confirmed after payment succeeds. Abandoned reservations auto-expire via TTL.

**Distributed lock with TTL** on inventory prevents race conditions during concurrent purchases. The 5-second TTL ensures the lock is always released even if the lock holder crashes, preventing deadlocks.

**Queue-based load leveling via Kafka** for flash sales eliminates lock contention entirely. The Inventory Worker processes purchases sequentially from the queue at a sustainable rate regardless of the incoming request spike.

**Multi-layer caching (L1/L2/L3)** for hot products eliminates the hot key problem during flash sales on the read side. Product metadata is served from app server local memory for the most popular items.

**Redis cart persistence to PostgreSQL** ensures cart data survives Redis failures. Users may lose a few recent additions but never lose their entire cart.

**CDN caching** for all product media means images and videos are served from edge nodes globally with no origin involvement for cache hits.

**Read replicas on PostgreSQL** for all services ensure no single point of failure for reads across the entire system.

<<<SECTION 14>>>
## 15. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, read/write traffic separation)

**Blob Storage** -> AWS S3 (Product images and videos, durable, CDN-native)

**CDN** -> CloudFront / Akamai (Edge caching for product media, high cache hit rate)

**Transcoding** -> Horizontally scaled worker pool via Kafka (Image variants, HLS video chunking)

**Decoupling** -> Apache Kafka (Order Saga orchestration, inventory events, search indexing, notifications)

**Search Engine** -> Elasticsearch (Full-text search, faceted filtering, ranking across 350M products)

**Autocomplete** -> Redis Sorted Sets (Prefix-based query suggestions, sub-millisecond reads)

**Product Catalog DB** -> PostgreSQL sharded + replicas (Structured product metadata, strong consistency for price)

**Orders / Payments DB** -> PostgreSQL (ACID compliance, financial record keeping, order state machine)

**Inventory Store** -> Redis + PostgreSQL (Real-time counts in Redis, source of truth in PostgreSQL)

**Distributed Lock** -> Redis SETNX with TTL (Inventory reservation, prevents overselling)

**Flash Sale Queue** -> Apache Kafka (Queue-based load leveling, eliminates lock contention)

**Cart Store** -> Redis Hash + PostgreSQL backup (Sub-millisecond cart operations, async persistence)

**Product Metadata Cache** -> Redis + L1 local in-memory (Multi-layer hot key mitigation for flash sales)

**Idempotency Store** -> Redis with TTL (Prevents double charging on payment retries)

**Notification Delivery** -> APNs + FCM + AWS SES (Push notifications and transactional emails)

**Reviews DB** -> PostgreSQL (Verified purchase enforcement, UNIQUE constraint per user per product)

That's all, folks..Cheers!
