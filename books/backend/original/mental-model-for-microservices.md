# Mental Model for Microservices

<<<SECTION 1>>>
## Microservices Part 1: What They Actually Are

Everyone talks about microservices. Fewer people can define one precisely, and even fewer can explain what it costs you. Let's fix that.

## What a microservice actually is

A microservice is an independently deployable service that owns its own data and is aligned to a single business capability. It is owned end to end by one team.

That definition has four parts, and all four matter:

- **Independently deployable**: you can ship it without coordinating a release with other services.
- **Owns its data**: no other service reaches into its database directly.
- **Aligned to a business capability**: it maps to something the business actually does (payments, inventory, notifications), not a technical layer.
- **Owned by one team**: one team is accountable for its full lifecycle, from code to on call.

Miss any one of these and you don't have a microservice. You have a distributed monolith wearing a microservices costume.

<<<SECTION 2>>>
## Anti-Patterns in Microservices

This is where most teams get it wrong.

- Not small services. Size is not the point. A service can be a few hundred lines or tens of thousands. What matters is the boundary, not the line count.
- Not Docker. Containerization is a deployment mechanism. You can run a monolith in Docker and microservices on bare metal. They are unrelated concepts that got tangled together in tutorials.
- Not separate repos. Repo structure is an organizational choice. You can have microservices in a monorepo and a monolith split across ten repos.
- Not one service per database table. This is the most common anti pattern. Splitting by table gives you a distributed database with extra network hops, not a service architecture. Services split by capability, not by schema.

If your mental model of microservices is "small, containerized, in its own repo, one per table," it's time to rebuild that model from scratch.

## The core promise

Done well, microservices give you three things:

- Independent deployment: teams ship on their own schedule without a global release train.
- Independent scaling: you scale the service under load, not the entire system.
- Independent ownership: a team can make technology and design decisions within its own boundary without needing sign off from everyone else.

This is the pitch, and it's a real one. The problem is that people stop reading here.

<<<SECTION 3>>>
## The core cost

Every one of those benefits is paid for with real costs:

- Network latency: a function call becomes a network call, and network calls fail in ways local calls don't.
- Partial failure: one service can be down while the rest of the system is fine, and now you have to design for that instead of assuming everything succeeds or fails together.
- Data inconsistency: no shared database means no free transactions across services, so you have to reason about eventual consistency and design around it.
- Debugging complexity: a single user request may hop across five services, and tracing what happened means distributed tracing, correlation IDs, and log aggregation instead of a single stack trace.
- Operational overhead: more services means more deployments, more monitoring, more infrastructure to run and pay for.

None of this is a reason to avoid microservices. It's the price of admission, and you need to know the price before you decide to pay it.

<<<SECTION 4>>>
## Conway's Law

Conway's Law says that any system you design will mirror the communication structure of the organization that built it. In practice, this means your team boundaries will show up in your service boundaries whether you plan for it or not.

If you have three teams that constantly need to talk to each other to ship anything, splitting their code into three services won't fix that. It will just move the coordination problem into your network layer.

This is why service boundaries are a people decision as much as a technical one. Design your teams intentionally, and your architecture has a real shot at following.

## How to frame this in an interview

If an interviewer asks whether you'd use microservices, the wrong answer is "yes, always" or a rehearsed list of benefits.

The right answer is that microservices are a design choice with trade-offs, not the default answer. You bring them up when the costs (latency, partial failure, operational overhead) are worth the benefits (independent deployment, scaling, ownership) for the specific problem in front of you. A small team building an early stage product usually doesn't need them. A large org with multiple teams stepping on each other's deployments might.

Say that, and you've already shown more judgment than most candidates who jump straight to drawing boxes and arrows.

That's all for Part1,Folks...Cheers!!
