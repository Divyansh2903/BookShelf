# Mental Model for Microservices

<<<SECTION 1>>>
## Microservices Part 1: What They Actually Are

A **microservice** is an independently deployable service that owns its own data, is aligned to a single business capability, and is owned end to end by one team. All four parts matter:

- **Independently deployable**: ship it without coordinating a release with other services.
- **Owns its data**: no other service reaches into its database directly.
- **Aligned to a business capability**: maps to something the business does (payments, inventory, notifications), not a technical layer.
- **Owned by one team**: one team is accountable for its full lifecycle, from code to on call.

Miss any one and you have a distributed monolith, not microservices.

<<<SECTION 2>>>
## Anti-Patterns in Microservices

Microservices are **not**:

- **Small services.** Size doesn't matter; a service can be a few hundred lines or tens of thousands. The boundary matters, not the line count.
- **Docker.** Containerization is a deployment mechanism. You can run a monolith in Docker and microservices on bare metal.
- **Separate repos.** Repo structure is an organizational choice. Microservices can live in a monorepo; a monolith can span ten repos.
- **One service per database table.** The most common anti-pattern. Splitting by table gives a distributed database with extra network hops. Split by capability, not by schema.

## The core promise

Done well, microservices give you:

- **Independent deployment**: teams ship on their own schedule, no global release train.
- **Independent scaling**: scale the service under load, not the whole system.
- **Independent ownership**: a team makes technology and design decisions within its boundary without sign-off from everyone else.

<<<SECTION 3>>>
## The core cost

Each benefit has a price:

- **Network latency**: a function call becomes a network call, which fails in ways local calls don't.
- **Partial failure**: one service can be down while the rest is fine; you must design for that rather than assume all-succeed or all-fail.
- **Data inconsistency**: no shared database means no free cross-service transactions, so you must design around eventual consistency.
- **Debugging complexity**: one request may hop across five services; tracing it needs distributed tracing, correlation IDs, and log aggregation instead of a single stack trace.
- **Operational overhead**: more deployments, monitoring, and infrastructure to run and pay for.

These aren't reasons to avoid microservices, but you need to know the price before paying it.

<<<SECTION 4>>>
## Conway's Law

**Conway's Law**: a system mirrors the communication structure of the organization that built it. Team boundaries will show up in service boundaries whether you plan it or not.

If three teams must constantly talk to ship anything, splitting their code into three services won't fix that; it moves the coordination problem into the network layer. So service boundaries are a people decision as much as a technical one: design teams intentionally and the architecture can follow.

## How to frame this in an interview

Don't answer "yes, always" or recite benefits. Say microservices are a design choice with trade-offs, not the default. Use them when the costs (latency, partial failure, operational overhead) are worth the benefits (independent deployment, scaling, ownership) for the specific problem. A small team on an early-stage product usually doesn't need them; a large org with multiple teams stepping on each other's deployments might.
