# Data Ownership And Read Models

<<<SECTION 1>>>
Part 4 covered service communication. Part 5 covers handling data with no shared database, usually the hardest part of a microservices migration: Part 3's clean boundaries meet users who need data from several services at once.

## Database per service

Non-negotiable. Each service exclusively owns its data store; nobody else touches it directly. This enables independent deployment: a service can change its schema, switch database technology, or add an index without permission, as long as its API contract stays stable.

## Shared database

A common route to an accidental distributed monolith: one service's schema change can silently break another, deployments must be coordinated, and you pay network overhead with no independence. A shared database means a boundary was drawn in the wrong place.

<<<SECTION 2>>>
## API composition

Call each service and merge results where needed, usually at an API gateway or in the client. Simple, fine for low volume and complexity. It fails with many services per request or high volume: several network calls (serial or parallel) per question, and the response is only as fast and reliable as the slowest, least reliable service.

## Materialized views

Pre-compute cross-service data by listening to events from owning services instead of calling them on every read. Reads are fast (data already assembled locally), but **eventually consistent**: the view lags the source of truth by event delivery and processing time.

## Data duplication

Read models mean deliberate duplication. Each piece of data still has one source of truth, owned by one service, but others keep local copies of what they need, synced via events. Trading duplication for independence and read performance is core to microservices data.

## Eventual consistency

The default, and fine for most reads: an order status a second or two late rarely matters. Not acceptable for financial transactions, where brief errors (double spending, incorrect balances) are costly; keep that data path synchronous and consistent.

<<<SECTION 3>>>
## Read-your-writes

A jarring common bug: a user updates something and doesn't see it, because the next read hit a lagging replica or read model. Fix: route that user's reads to the primary source of truth for a short window after their write; everyone else reads the faster eventually consistent copy.

### CQRS

**Command Query Responsibility Segregation** fully separates write and read models. Justified when patterns differ dramatically, e.g. complex write validation but extremely fast, highly denormalized reads. It adds significant complexity: use it only when the gap requires it, not as a default.

<<<SECTION 4>>>
## Reference data

For data a service doesn't own (e.g. a customer's shipping address while processing an order), three options trade off freshness:
- **Snapshot at event time**: capture the data as of the event. Simple; can go stale.
- **Event-driven cache**: subscribe to changes and maintain a local copy. Fresher; more infrastructure.
- **Synchronous API call**: ask the owner every time. Always fresh; couples services at request time and adds latency.

Choose by how fresh that data must be.

## Search indexing

A derived read model in practice: an index fed by events from several services (e.g. product catalog and inventory) returns complete, current results without querying multiple services per search.

## Cache ownership

The data's owning service owns cache invalidation. Others may hold cached copies but never decide staleness; otherwise caches drift with nobody accountable.

## Reporting

Run analytics against a separate analytical store fed by events, never the operational databases. Those are tuned for live transactional load, and heavy analytical queries compete for resources and degrade performance for real users.

<<<SECTION 5>>>
## Schema migration

Schemas and consumers deploy independently, so changes must roll out gradually. **Expand-contract pattern**:
1. Add the new field or table alongside the old.
2. Migrate every consumer to the new version.
3. Once all have moved, remove the old one.

A direct breaking change assumes all consumers update in lockstep, which microservices are designed to avoid.
