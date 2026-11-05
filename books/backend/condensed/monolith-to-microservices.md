# Monolith To Microservices

<<<SECTION 1>>>
Part 1 defined a microservice and its costs. This part maps the spectrum from monolith to true microservices.

## Traditional monolith

One deployable unit, one shared database, one codebase, build, and deploy.

Underrated: for a small team it is simple to operate, easy to reason about, and fast, with no distributed systems tax. Most successful products started here; many stay.

## Modular monolith

One deployable unit with enforced internal boundaries: modules talk through defined interfaces, not each other's internals or shared tables.

The most underrated architecture. It gives most of the organizational clarity of microservices (clean ownership, explicit contracts) with no network or operational cost, and is the best stepping stone to services: boundaries are already drawn, you just move them across a network later.

### Distributed monolith

The trap: multiple deployable services that are still tightly coupled (shared database, synchronous call chains where one service needs three others up, coordinated deployments because changing one breaks another).

You pay every distributed cost (latency, partial failure, ops overhead) and get no benefit (independent deployment, independent scaling, team autonomy). Worse than either alternative, and where most failed migrations end up.

## True microservices

Independent deployment, a private database per service, boundaries aligned to business capabilities, clear team ownership. Hard to get right, and only reached by deliberate design.

## When to stay a monolith

Monolith or modular monolith fits when:
- The team is small, so coordination overhead is low.
- Domain boundaries (the real seams in the business logic) are still unclear.
- The system scales uniformly.
- You need strong consistency, and distributed transactions would cause more problems than they solve.

<<<SECTION 2>>>
## When to go microservices

Microservices fit when:
- Multiple teams must ship independently without blocking each other.
- Parts have different scaling profiles (e.g. checkout under heavy load, reporting idle).
- The domain is stable enough to know the boundaries.
- You need fault isolation, so one failure doesn't take everything down.

Organizational needs matter as much as technical ones: **Conway's Law** doesn't go away because you drew more boxes.

## The migration path

Monolith → modular monolith → incremental extraction.

Enforce boundaries inside the monolith first. When a module has a clean interface and minimal hidden coupling, extract it. Repeat one boundary at a time. Slower than a big rewrite, which is why it works: each boundary is validated under real production traffic before full commitment.

<<<SECTION 3>>>
## The Strangler Fig pattern

The standard safe-extraction technique, named after the vine that grows around a tree and gradually replaces it.

1. Put a routing proxy in front of the functionality being extracted.
2. Build the new service and run **shadow traffic**: real requests mirrored to it, comparing output with the old path without affecting users.
3. **Canary rollout**: send a small percentage of real traffic, increasing it as confidence grows.
4. Once it reliably handles all traffic, retire the old path.

No hard cutover at any point.

## Decomposition anti-patterns

- **Splitting by technical layer** (a "database service", "validation service") instead of business capability, causing chatty coupling for what should be one operation.
- **One service per table** (see Part 1), still very common.
- **Premature extraction** before the boundary is understood: you'll redraw it later, now as a network boundary instead of a code boundary.
- **God service**: one service owning far too much because bolting things on was easier than defining a boundary.
- **Shared database** between "independent" services: they are not independently deployable, whatever the diagram says.
