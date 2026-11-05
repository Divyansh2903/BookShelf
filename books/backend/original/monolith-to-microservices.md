# Monolith To Microservices

<<<SECTION 1>>>
In Part 1 we defined what a microservice actually is and what it costs. This time we're zooming out to look at the full spectrum, from a plain monolith to true microservices, and figuring out where you actually belong on it.

## Traditional monolith

A single deployable unit with a shared database. Everything lives in one codebase, one build, one deploy.

This gets a bad reputation it doesn't fully deserve. For a small team, it's simple to operate, easy to reason about, and lets you move fast without any distributed systems tax. Most successful products started here, and plenty of successful products stay here.

## Modular monolith

Still one deployable unit, but with enforced internal boundaries. Modules talk to each other through defined interfaces instead of reaching into each other's internals or sharing tables freely.

This is the most underrated architecture in the industry. You get most of the organizational clarity of microservices, clean ownership lines, and explicit contracts between modules, without paying any of the network or operational costs. It's also the best stepping stone if you do eventually need to split into real services, because the boundaries are already drawn. You're just moving them across a network later.

### Distributed monolith

This is the trap. You've split your codebase into multiple deployable services, but they're still tightly coupled: shared database, synchronous call chains where one service can't function without three others being up, coordinated deployments because changing one breaks another.

You now pay every cost of a distributed system, network latency, partial failure, operational overhead, and get none of the benefits, no independent deployment, no independent scaling, no real team autonomy. This is worse than either a monolith or true microservices. It's the worst of both worlds, and it's where most failed microservices migrations end up.

## True microservices

Independent deployment, private databases per service, boundaries aligned to business capabilities, and clear team ownership. This is what Part 1 defined, and it's genuinely hard to get right. It's also not something you back into by accident. You have to design for it deliberately.

## When to stay a monolith

Monolith or modular monolith is the right call when:

- You have a small team where coordination overhead is low anyway.
- Your domain boundaries are still unclear, meaning you don't yet know where the real seams in your business logic are.
- Your system scales uniformly, so there's no single part of it that needs to scale independently of the rest.
- You need strong consistency, and distributed transactions would create more problems than they solve.

<<<SECTION 2>>>
## When to go microservices

Microservices start to make sense when:

- You have multiple teams that need to ship independently without blocking each other.
- Different parts of your system have different scaling profiles, for example a checkout service under heavy load while a reporting service sits idle.
- Your domain is stable enough that you actually know where the boundaries should be.
- You need fault isolation, so that one part of the system failing doesn't take everything else down with it.

Notice that team structure and organizational needs show up as much as technical needs here. That's Conway's Law again, and it doesn't go away just because you decided to draw more boxes.

## The migration path

If you do need to move, the path that works is monolith, to modular monolith, to incremental extraction.

Enforce boundaries inside the monolith first. Once a module has a clean interface and minimal hidden coupling to the rest of the system, pull it out into its own service. Repeat, one boundary at a time. This is slower than a big rewrite, and that's exactly why it works. It lets you validate each boundary under real production traffic before you're fully committed to it.

<<<SECTION 3>>>
## The Strangler Fig pattern

This is the standard technique for doing that extraction safely, named after the strangler fig vine that grows around a tree and gradually replaces it.

- Put a routing proxy in front of the functionality you're extracting.
- Build the new service and run it with shadow traffic, real requests mirrored to the new service so you can compare its output against the old code path without affecting real users.
- Once you trust the new service, do a canary rollout, sending it a small percentage of real traffic and increasing that percentage as confidence grows.
- Once the new service is handling all traffic reliably, retire the old code path.

At no point are you doing a hard cutover. That's the entire point.

## Decomposition anti-patterns

Watch for these while extracting services:

- Splitting by technical layer instead of business capability, for example a separate "database service" or "validation service." This creates chatty coupling between services for what should be a single operation.
- One service per table. Covered in Part 1, still one of the most common mistakes.
- Premature extraction, pulling a service out before you actually understand its boundary. You'll get the boundary wrong and pay to redraw it later, except now it's a network boundary instead of a code boundary.
- A god service, one service that ends up owning far more responsibility than it should because it was easier to bolt things onto it than define a new boundary.
- A shared database between services that are supposedly independent. If two services share a database, they are not independently deployable, no matter what your architecture diagram says.

That's all for Part2, Folks....Cheers!
