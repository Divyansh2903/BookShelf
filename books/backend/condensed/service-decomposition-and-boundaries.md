# Service Decomposition And Boundaries

<<<SECTION 1>>>
After the definition (Part 1) and the spectrum (Part 2), the hard question is where to draw the lines. Boundaries are much harder to redraw once services are live in production, so mistakes are expensive.

## Start with business capability decomposition

Services should map to what the business does, not to technical layers or database tables.

- **Technical layer split** (bad): a "validation service" or "database service". These are implementation details; splitting along them adds network hops to what should be one operation.
- **Business capability split** (good): "order management", "inventory", "payments", "notifications". Anyone in the business would recognize these without mentioning technology. If you can't explain a service's purpose to someone outside engineering, it's probably not a real capability boundary.

<<<SECTION 2>>>
## Bounded contexts

From domain-driven design; the most useful concept for finding boundaries. The same word means different things in different parts of the business: a billing "Customer" has a payment method and invoice history; a support "Customer" has a ticket history and satisfaction score. One shared "Customer" model becomes bloated and pulled in every direction by every team.

A **bounded context** gives each its own model and definition, scoped to where it's used. Align services to bounded contexts, not to nouns in your database schema.

## Aggregates

An **aggregate** is the consistency boundary inside a service. Everything inside it is updated in one transaction; everything outside is updated through its own transaction, coordinated asynchronously if needed.

Example: an order and its line items are one aggregate (must be consistent together). The order and the customer's loyalty points usually aren't; that consistency can be eventual.

Wrong aggregates lead either to transactions spanning services (breaks independence) or to inconsistency the business can't tolerate.

## Cohesion

Group things that change together for the same reason. Logic almost always modified together belongs in one service. Logic changing for different reasons, on different timelines, driven by different stakeholders may belong in separate services.

Low cohesion is unrelated logic bolted together because it was convenient to deploy together; that convenience disappears once the service outgrows a small team.

## Coupling

Minimize dependencies between services and watch their kind:

- **Contract coupling** (depending on a well-defined API contract) is fine and expected.
- **Database coupling** (reaching into another service's database) must be avoided at all costs. It silently breaks independent deployability: a schema change in one service can break another that was never consulted.

## Ownership

One team, one service. Team boundaries should match service boundaries, not the other way around. Shared ownership brings back the coordination overhead microservices should remove: shared release schedules, conflicting priorities, unclear on-call responsibility. A service with two owning teams should usually be split, or the teams merged.

<<<SECTION 3>>>
## Granularity

No universal right size, but a rule of thumb: **4 to 8 engineers per service** and roughly **3 to 15 database tables**. Small enough for one team to hold in their heads and deploy independently; large enough to be useful, not a thin wrapper around one database call.

Smaller services become a distributed monolith: dozens of tiny services that must be coordinated to do anything meaningful. Larger ones lose the independence benefits that justified splitting.

## Workflow decomposition

Trace real user workflows end to end (placing an order, signing up, checking out). The natural pause points and handoffs, where one piece of logic finishes and hands off to another, are strong boundary candidates. This beats staring at an entity relationship diagram because it reflects how the system is used, not how the data is structured.

<<<SECTION 4>>>
## Read/write decomposition

Sometimes read and write patterns for the same data differ dramatically. A product catalog may be written rarely by a small internal team but read constantly by millions of users, in a different shape than it was written.

When the gap is large enough, separate the read path from the write path: either as different services, or as one service with a materialized read model kept in sync with the write model. This is a targeted decision, not a default, and usually comes after a service has been live long enough for access patterns to become obvious.
