# Inter-Service Communication

<<<SECTION 1>>>
Part 3 covered where to draw service boundaries. Now that you have separate services, they need to talk to each other, and how they talk determines how resilient your system actually is under real failure conditions. This is where a lot of the theoretical cleanliness from earlier parts meets the messiness of production.

## Synchronous versus asynchronous

The first decision for any interaction is whether the caller needs the response to continue.

Use synchronous calls when the calling code genuinely cannot proceed without an answer, for example checking whether a payment succeeded before showing an order confirmation. Use asynchronous calls when the caller can move on and let the result arrive later, for example sending a confirmation email after checkout.

Defaulting to synchronous everywhere is the most common mistake here. It quietly turns your service graph into a chain where the slowest link determines the speed and availability of the whole request.

## REST

REST is the default for public APIs. It's simple, works over plain HTTP, is universally understood, and every language and tool supports it without friction. If you're exposing an API to external clients or third parties, REST is almost always the right starting point.

## gRPC

For internal service to service calls with tight latency budgets, gRPC is usually the better choice. It uses a binary protocol instead of JSON over text, has typed contracts defined up front through protobuf, and is faster to serialize and deserialize. The tradeoff is that it's less human readable and less friendly to tools like a browser or curl, which is exactly why it fits internal traffic better than public APIs.

## GraphQL

GraphQL belongs at the edge, as an aggregation layer for clients that need flexible queries, typically mobile or web frontends pulling together data from several backend services in one request. It is not a good fit for service to service communication internally. Using it there adds complexity without solving a problem you actually have, since your internal services already know exactly what shape of data they need from each other.

## Message queues

A message queue delivers one message to one consumer. This is the right tool for task distribution and load leveling, for example distributing image processing jobs across a pool of workers, or absorbing a burst of writes so downstream systems can process them at a steady rate instead of being overwhelmed.

<<<SECTION 2>>>
## Event streams

An event stream delivers one event to many consumers, and typically retains a history of events that can be replayed. This is the right tool when multiple services independently care about the same thing happening, for example an "order placed" event that the inventory service, the notification service, and the analytics service all need to react to, each in its own way.

The core difference from a queue is fan out. A queue is one message picked up by one worker. A stream is one event observed by every interested party.

## Commands versus events

A command tells another service to do something specific, for example "charge this payment." Commands couple the sender to the receiver, because the sender has to know exactly who should handle it and what it expects back.

An event states that something already happened, for example "payment was charged." Events decouple the sender from the receiver, because the sender doesn't need to know or care who's listening. Anyone interested can subscribe.

Preferring events over commands where possible is one of the simplest ways to reduce coupling between services, because it means new consumers can be added later without ever touching the service that produced the event.

<<<SECTION 3>>>
## Timeouts

Every call to another service needs a timeout, with no exceptions. A call without a timeout can hang indefinitely, holding a thread or connection open while it waits, and that's how a slowdown in one service quietly becomes an outage in every service calling it.

### Retries

Retries should only be applied to idempotent operations, meaning operations that produce the same result no matter how many times they're run. Retrying a non idempotent operation, like "create an order," without an idempotency key can create duplicates.

When you do retry, use backoff with jitter, meaning you wait progressively longer between attempts and add some randomness so that many clients don't all retry at exactly the same moment and overwhelm the service they're trying to reach. Cap retries at two or three attempts. Beyond that, you're usually just delaying an inevitable failure while adding load to an already struggling service.

<<<SECTION 4>>>
## Circuit breakers

A circuit breaker prevents cascading failure by tracking whether calls to a dependency are succeeding or failing, and stopping calls entirely once failures cross a threshold.

It has three states. Closed means calls pass through normally. Open means calls fail immediately without even attempting the network call, giving the struggling dependency room to recover. Half-Open means the breaker allows a small number of test calls through to check whether the dependency has recovered, and moves back to Closed if they succeed or back to Open if they don't.

## Bulkheads

A bulkhead isolates the resource pool used for one dependency from the resource pool used for another, the same idea as watertight compartments in a ship's hull. If one dependency is slow, it should only exhaust its own connection pool or thread pool, not the shared pool that every other call in your service depends on.

## Backpressure

Backpressure means rejecting excess load instead of trying to absorb all of it and collapsing. This looks like bounded queues, where a queue has a maximum size and rejects new work once it's full, and rate limiting, where a service caps how many requests it accepts per second. Rejecting a request cleanly with a clear error is a far better outcome than accepting it and slowly falling over.

<<<SECTION 5>>>
## Contract versioning

Services deploy independently, which means the caller and the callee are rarely running the exact same version of a contract at the exact same time. The rule that makes this work is to add fields, never remove them. Adding a new field to a response is safe because old clients simply ignore it. Removing or renaming a field breaks every client still depending on it.

This backward compatibility is what actually enables independent deployment in practice. Without it, you're back to coordinating releases across teams, which defeats the entire point of splitting into services in the first place.

## Correlation IDs

A single user request can hop across many services before it's fully handled. A correlation ID is a unique identifier attached to the request at the very first entry point and passed along with every downstream call, so that every log line, every trace, and every error across every service involved can be tied back to that one original request.

Without this, debugging a multi-service failure means manually piecing together timestamps and guessing which log entries belong together. With it, you can pull every relevant log line with a single query.

That's all for part 4, folks...Cheers!!
