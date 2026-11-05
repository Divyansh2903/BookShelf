# Inter-Service Communication

<<<SECTION 1>>>
Once you have separate services (Part 3 covered boundaries), how they talk determines how resilient the system is under real failure.

## Synchronous versus asynchronous

First decision: does the caller need the response to continue?

- **Synchronous**: the caller genuinely can't proceed without an answer, e.g. checking a payment succeeded before showing an order confirmation.
- **Asynchronous**: the caller can move on and get the result later, e.g. sending a confirmation email after checkout.

Defaulting to synchronous everywhere is the most common mistake. It turns the service graph into a chain where the slowest link sets the speed and availability of the whole request.

## REST

The default for public APIs: simple, plain HTTP, universally understood, supported by every language and tool. For external clients or third parties, REST is almost always the right start.

## gRPC

Usually better for internal service-to-service calls with tight latency budgets. Binary protocol instead of JSON text, typed contracts defined up front via protobuf, faster serialization/deserialization. Trade-off: less human-readable and less friendly to browsers or curl, which is why it suits internal traffic rather than public APIs.

## GraphQL

Belongs at the edge, as an aggregation layer for clients needing flexible queries (typically mobile or web frontends combining data from several backend services in one request). Not a good fit internally: it adds complexity without solving a real problem, since internal services already know exactly what data shape they need.

## Message queues

A **message queue** delivers one message to one consumer. Use it for task distribution and load leveling, e.g. distributing image processing jobs across a worker pool, or absorbing a burst of writes so downstream systems process them at a steady rate.

<<<SECTION 2>>>
## Event streams

An **event stream** delivers one event to many consumers and typically retains a replayable history. Use it when multiple services independently care about the same occurrence, e.g. an "order placed" event that inventory, notification, and analytics services each react to in their own way.

The core difference is fan-out: a queue is one message picked up by one worker; a stream is one event observed by every interested party.

## Commands versus events

- A **command** tells a service to do something ("charge this payment"). It couples sender to receiver: the sender must know who handles it and what it expects back.
- An **event** states something already happened ("payment was charged"). It decouples them: the sender doesn't know or care who listens; anyone can subscribe.

Preferring events over commands where possible is one of the simplest ways to reduce coupling, since new consumers can be added without touching the producer.

<<<SECTION 3>>>
## Timeouts

Every call to another service needs a timeout, no exceptions. Without one, a call can hang indefinitely, holding a thread or connection open; that's how a slowdown in one service becomes an outage in every caller.

### Retries

- Retry only **idempotent** operations (same result however many times they run). Retrying a non-idempotent operation like "create an order" without an idempotency key can create duplicates.
- Use **backoff with jitter**: wait progressively longer between attempts and add randomness so many clients don't retry at the same moment and overwhelm the service.
- Cap at **two or three attempts**. Beyond that you mostly delay an inevitable failure while adding load to a struggling service.

<<<SECTION 4>>>
## Circuit breakers

A **circuit breaker** prevents cascading failure by tracking whether calls to a dependency succeed or fail, and stopping calls once failures cross a threshold. Three states:

- **Closed**: calls pass through normally.
- **Open**: calls fail immediately without attempting the network call, giving the dependency room to recover.
- **Half-Open**: a small number of test calls go through; success moves it back to Closed, failure back to Open.

## Bulkheads

A **bulkhead** isolates the resource pool for one dependency from that of another, like watertight compartments in a ship's hull. A slow dependency should exhaust only its own connection or thread pool, not the shared pool every other call depends on.

## Backpressure

**Backpressure** means rejecting excess load instead of absorbing it all and collapsing. Examples: **bounded queues** (a max size; new work rejected when full) and **rate limiting** (cap on requests accepted per second). Cleanly rejecting a request with a clear error beats accepting it and slowly falling over.

<<<SECTION 5>>>
## Contract versioning

Services deploy independently, so caller and callee rarely run the same contract version at the same time. Rule: **add fields, never remove them**. Old clients ignore new response fields; removing or renaming a field breaks every client still depending on it.

This backward compatibility is what makes independent deployment work in practice. Without it you're back to coordinating releases across teams, defeating the point of services.

## Correlation IDs

A **correlation ID** is a unique identifier attached to a request at the first entry point and passed along with every downstream call, so every log line, trace, and error across all involved services ties back to that one request.

Without it, debugging a multi-service failure means piecing together timestamps and guessing which logs belong together. With it, one query pulls every relevant log line.
