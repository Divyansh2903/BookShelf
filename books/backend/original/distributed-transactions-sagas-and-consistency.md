# Distributed Transactions, Sagas, and Consistency

<<<SECTION 1>>>
Part 5 covered how services own and share data day to day. This part covers the harder case: what happens when a single business operation needs to update data across multiple services, and there's no shared database transaction to fall back on.

## Why ACID is not enough

A traditional database transaction gives you atomicity, consistency, isolation, and durability, all within a single database. The moment your data is split across multiple service databases, that guarantee stops at the service boundary. A single transaction simply cannot span multiple service databases, because there's no single database engine coordinating the commit across all of them. Any approach to distributed data has to work around this fact, not pretend it doesn't exist.

## Two-phase commit

The most direct attempt to recreate ACID across services is two-phase commit, where a coordinator asks every participant to prepare a transaction, waits for all of them to confirm they can commit, and only then tells everyone to actually commit.

This does guarantee atomicity, but it comes at a real cost. Every participant has to hold locks and resources open while waiting on every other participant, which creates blocking. If the coordinator or any participant is slow or down, everyone waits, which creates latency and availability problems. In a microservices system where services deploy and scale independently, this kind of tight coupling defeats much of the point of splitting them apart in the first place. It's rarely the right tool here.

<<<SECTION 2>>>
## Saga pattern

The pattern that actually fits microservices is the saga: a sequence of local transactions, each one committed independently within its own service, with a defined compensating action for each step in case something later in the sequence fails.

Instead of one big transaction that either fully commits or fully rolls back, you have a chain of small transactions that each commit on their own, and a plan for undoing the effect of earlier steps if a later step can't complete. This trades strict atomicity for something that actually works across independent services.

## Compensating transactions

A compensating transaction is a new transaction that semantically reverses the effect of a previously committed step. This is not a rollback, because the original step already committed and is visible to the rest of the system. Instead, you issue a new action that cancels it out, for example if a payment was charged and a later step fails, the compensation is "refund the payment," not "pretend the charge never happened."

This distinction matters because other parts of the system may have already reacted to that committed step before the compensation runs, and your design needs to account for that possibility.

## Orchestration

One way to run a saga is orchestration, where a central coordinator explicitly tells each service what to do next and tracks the state of the whole workflow. This makes complex workflows easier to understand and debug, because the entire sequence of steps lives in one place rather than being scattered across services. The tradeoff is that the orchestrator becomes a central point that every participating service is now coupled to.

## Choreography

The alternative is choreography, where there's no central coordinator and instead each service reacts to events published by other services, deciding on its own what to do next. This keeps services more loosely coupled since no single service knows about the entire workflow. It works well for simple flows with few steps, but it gets hard to reason about as the number of steps grows, because there's no single place to look to understand what the full sequence actually is.

<<<SECTION 3>>>
## Transactional outbox

A common problem when publishing events from a saga step: you commit a database change and publish an event as two separate actions, and if the process crashes between them, you can end up with a committed change and no event, or an event with no committed change.

The transactional outbox pattern fixes this by writing the event to an outbox table in the same database transaction as the business data change, so both succeed or fail together. A separate relay process then reads from the outbox table and publishes the events afterward, so the write and the publish are decoupled in time but not in correctness.

## Inbox pattern

On the consuming side, the same kind of problem exists in reverse. The inbox pattern has the consumer track the IDs of events it has already processed, so that if the same event is delivered more than once, the consumer can recognize the duplicate and skip reprocessing it instead of applying the same change twice.

## Idempotency keys

A related but distinct tool is the idempotency key, a unique key generated per operation, usually by the caller, and sent along with the request. If the server receives a request with a key it has already seen, it returns the previously stored result of that operation instead of executing it again. This is what makes it safe to retry operations like "charge this payment" without risking duplicate side effects.

## At-least-once delivery

Most messaging systems default to at-least-once delivery, meaning a message might be delivered more than once but is guaranteed to be delivered at least once. Combine this with idempotent consumers, using the inbox pattern or idempotency keys, and you effectively get exactly-once behavior at the application level, even though the underlying delivery guarantee is weaker than that on its own.

## Dead-letter queues

When a message fails processing repeatedly, even after retries, it needs somewhere to go rather than being retried forever or silently dropped. A dead-letter queue is that holding area, a place where failed messages land so they can be inspected, fixed, and replayed manually, without blocking the rest of the queue behind them.

## Exponential backoff with jitter

When retrying a failed call, retrying immediately and repeatedly can create a retry storm, where a large number of clients all hammer a struggling service at once and make its recovery harder. Exponential backoff increases the delay between each retry attempt, and jitter adds randomization to that delay so that many clients don't end up retrying in lockstep. Together they spread retries out over time instead of concentrating them right when the dependency is least able to handle them.

## Partial failure

Not every failure in a saga should be handled the same way. Transient errors, like a brief network blip, are worth retrying. Permanent errors, like a validation failure that will never succeed no matter how many times you try it, need a compensating action instead. And if the compensation itself fails, that needs to escalate rather than fail silently, because at that point you likely have inconsistent state that a human needs to look at.

## State machines

A saga is really a state machine: a defined set of valid states, and a defined set of valid transitions between them. Explicitly modeling this, rather than tracking progress with loose flags and conditionals, makes it possible to reject invalid transitions outright, for example refusing to ship an order that was never marked as paid, instead of discovering the inconsistency later.

<<<SECTION 4>>>
## Human intervention

Not every failure can or should be resolved automatically. Some situations, especially ones involving money or irreversible external side effects, genuinely need a person to look at the situation and decide what to do. Designing tooling for this, dashboards showing stuck sagas, clear context on what state something is in and what's already been tried, is as much a part of the system as the automated retry and compensation logic. Treating human intervention as an afterthought is how stuck sagas end up sitting unresolved for days.

That's all, folks..Cheers!!
