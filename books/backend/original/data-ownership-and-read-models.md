# Data Ownership And Read Models

<<<SECTION 1>>>
Part 4 covered how services talk to each other. This part covers something harder: how services handle data when there's no shared database to fall back on. This is usually where microservices migrations get genuinely difficult, because it's where the clean service boundaries from Part 3 collide with the reality that users often need to see data from more than one service at once.

## Database per service

This is non-negotiable. Each service owns its data store exclusively, and no other service touches that store directly. This is what actually makes independent deployment possible, because a service can change its schema, switch database technology, or add an index without asking anyone else's permission, as long as it keeps its API contract stable.

## Shared database

The opposite of the above, and one of the most common ways teams accidentally build a distributed monolith. If two services share a database, a schema change in one can silently break the other, deployments have to be coordinated, and you've paid for network overhead without getting any of the independence you were trying to buy. If you find a shared database in your system, that's a boundary that was drawn in the wrong place.

<<<SECTION 2>>>
## API composition

The simplest way to combine data from multiple services: call each service and merge the results at the point where they're needed, usually at an API gateway or in the client itself. This is easy to reason about and fine for low volume, low complexity cases. It stops working well once you're composing data from many services in one request, or once request volume is high, because now you're making several network calls, in serial or parallel, just to answer one question, and the whole response is only as fast and as reliable as the slowest and least reliable service involved.

## Materialized views

A materialized view pre-computes cross-service data ahead of time by listening to events from the services that own that data, instead of calling them synchronously on every read. This gives you high read performance since the data is already assembled and sitting locally, at the cost of being eventually consistent, since the view lags slightly behind the source of truth by however long it takes the event to arrive and get processed.

## Data duplication

Once you accept materialized views and read models, you're accepting data duplication as a deliberate design choice, not an accident. There's still exactly one source of truth for any given piece of data, owned by one service, but other services are allowed to keep their own local copies of what they need, kept in sync through events. This trade-off, some duplicated data in exchange for independence and read performance, is core to how microservices data actually works.

## Eventual consistency

This is the default state of data in a microservices system, and it's acceptable for most reads. A user seeing their order status update a second or two late is rarely a real problem. It is not acceptable for financial transactions, where the cost of being briefly wrong, double spending, incorrect balances, is high enough that you need stronger guarantees, which usually means keeping that specific data path synchronous and consistent rather than eventually consistent.

<<<SECTION 3>>>
## Read-your-writes

A common and jarring bug is a user updating something and then immediately not seeing that update reflected back to them, because their next read hit a replica or a read model that hasn't caught up yet. The fix is to route the writing user's own reads to the primary source of truth for a short window right after their write, while everyone else can keep reading from the faster, eventually consistent copy.

### CQRS

Command Query Responsibility Segregation means separating your write model from your read model entirely, rather than using one model for both. This is justified when read and write patterns differ dramatically, for example a system with complex validation rules on write but a need for extremely fast, highly denormalized reads. It's a significant amount of added complexity, so it's worth reaching for only when the gap between the two patterns is large enough to actually need it, not as a default architecture.

<<<SECTION 4>>>
## Reference data

When a service needs data it doesn't own, like a customer's shipping address while processing an order, there are three main approaches, each with a different freshness tradeoff. Snapshot at event time means capturing the data as it was when the relevant event happened, which is simple but can go stale. An event-driven cache means subscribing to changes and keeping a local copy updated, which is fresher but adds infrastructure. A synchronous API call means asking the owning service directly every time, which is always fresh but couples the two services together at request time and adds latency. The right choice depends entirely on how fresh that particular piece of data actually needs to be.

## Search indexing

Search is a good example of a derived read model in practice. A search index is typically fed by events coming from multiple services, for example a product catalog service and an inventory service both feeding a single search index, so that search can return complete, up to date results without directly querying multiple services on every search request.

## Cache ownership

The service that owns the data also owns the invalidation logic for any cache of that data. Other services or layers may hold and use a cached copy, but they should never be responsible for deciding when it's stale. That responsibility has to sit with the source of truth, or you end up with caches that silently drift and nobody clearly accountable for fixing it.

## Reporting

Analytics and reporting queries should run against a separate analytical store, fed by events from the operational services, never against the operational databases directly. Operational databases are tuned for the transactional load of the live application. Heavy analytical queries running against them compete for the same resources and can degrade performance for real users, which is exactly what a good architecture should be protecting against.

<<<SECTION 5>>>
## Schema migration

Because a service's schema and its consumers deploy independently, schema changes need to be safe to roll out gradually rather than all at once. The expand-contract pattern handles this: first add the new field or table alongside the old one, then migrate every consumer over to use the new version, and only once every consumer has moved do you remove the old one. Skipping straight to a breaking change assumes every consumer updates in lockstep, which is exactly the assumption microservices are designed to avoid.

That's all for Part 5, folks...Cheers!!
