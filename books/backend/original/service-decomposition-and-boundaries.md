# Service Decomposition And Boundaries

<<<SECTION 1>>>
Parts 1 and 2 gave you the definition and the spectrum. The hardest question is still open: where exactly do you draw the lines? This is the part most teams get wrong, and getting it wrong is expensive because boundaries are much harder to redraw once services are live in production.

## Start with business capability decomposition

Services should map to what the business does, not to technical layers and not to database tables.

A technical layer split looks like a "validation service" or a "database service." These aren't business capabilities, they're implementation details, and splitting along them just adds network hops to what should be a single operation.

A business capability split looks like "order management," "inventory," "payments," "notifications." Each one is something a person in the business would recognize and describe without mentioning any technology. If you can't explain a service's purpose to someone outside engineering, it's probably not a real capability boundary.

<<<SECTION 2>>>
## Bounded contexts

This idea comes from domain driven design, and it's probably the single most useful concept for finding good boundaries.

The same word often means different things in different parts of the business. "Customer" in the billing context means something with a payment method and an invoice history. "Customer" in the support context means something with a ticket history and a satisfaction score. Trying to force one shared "Customer" model across both contexts leads to a bloated model that's dragged in every direction by every team that touches it.

A bounded context says each of these gets its own model, its own definition of the word, scoped to where it's used. Services should align to bounded contexts, not to the nouns in your database schema.

## Aggregates

Inside a service, an aggregate is the consistency boundary. Everything inside an aggregate is updated in a single transaction. Everything outside it is updated separately, through its own transaction, coordinated asynchronously if needed.

For example, an order and its line items are typically one aggregate, they need to be consistent together. The order and the customer's loyalty points are usually not the same aggregate, that consistency can be eventual.

Get your aggregates wrong and you either end up with transactions that span services (which breaks independence) or with data that's inconsistent in ways your business can't tolerate.

## Cohesion

Group things that change together for the same reason. If two pieces of logic are almost always modified together, they belong in the same service. If they change for entirely different reasons, on different timelines, driven by different stakeholders, that's a signal they might belong in separate services.

Low cohesion inside a service looks like unrelated logic bolted together because it was convenient to deploy at the same time. That convenience disappears the moment the service grows past a small team.

## Coupling

Minimize dependencies between services, and pay close attention to what kind of dependency you're creating.

Contract coupling, where two services depend on a well defined API contract, is fine and expected. That's how independent services talk to each other.

Database coupling, where one service reaches into another's database directly, is the dependency to avoid at all costs. It silently breaks independent deployability, because now a schema change in one service can break another service that was never consulted.

## Ownership

One team, one service. Team boundaries should match service boundaries, not the other way around.

When two teams share ownership of a service, you get exactly the coordination overhead microservices were supposed to remove: shared release schedules, conflicting priorities, unclear on call responsibility. If a service has two owning teams, that's usually a sign it should either be split, or the teams should be merged.

<<<SECTION 3>>>
## Granularity

There's no universal right size, but a useful rule of thumb is 4 to 8 engineers per service and roughly 3 to 15 database tables. Small enough that one team can hold the whole thing in their heads and deploy it independently, large enough to actually be useful and not just a thin wrapper around a single database call.

Services smaller than this tend to turn into a distributed monolith by another name, because you end up with dozens of tiny services that all have to be coordinated together to do anything meaningful. Services larger than this start to lose the independence benefits that justified splitting in the first place.

## Workflow decomposition

A practical technique: trace real user workflows end to end. Follow what happens when a user places an order, or signs up, or checks out. The natural pause points and handoffs in that workflow, where one piece of logic finishes and hands off to another, are strong candidates for service boundaries.

This tends to produce better boundaries than staring at an entity relationship diagram, because it reflects how the system is actually used rather than how the data happens to be structured.

<<<SECTION 4>>>
## Read/write decomposition

Sometimes the read pattern and the write pattern for the same data are dramatically different. A product catalog might be written to rarely, by a small internal team, but read constantly, by millions of users, in a totally different shape than it was written.

When this gap is large enough, it's worth separating the read path from the write path, sometimes as different services, sometimes as the same service with a materialized read model kept in sync with the write model. This is a targeted decision, not a default, and it usually shows up after a service has been live long enough for the access patterns to become obvious.

That's all for Part 3, Folks....Cheers!
