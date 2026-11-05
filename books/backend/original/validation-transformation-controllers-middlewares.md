# Validation, Transformation, Controllers, Middlewares

<<<SECTION 1>>>
We're going to discuss some important core building blocks of any backend system here

### Validation

Validation is your first line of defense. It ensures that data entering your system is well-formed, complete, and within acceptable bounds before any business logic touches it.

There are two broad layers where validation lives:

**Schema validation:** It checks structure-related stuff and types. Is this field a string? Is this number within range? Is this email address syntactically valid? Libraries like Zod (TypeScript), Joi (Node.js), Pydantic (Python), or Jakarta Bean Validation (Java) let you declare a schema and validate against it declaratively.

**Business validation:**  It is context-aware. Is this username already taken? Does this user have sufficient balance for this transaction? This kind of validation often requires a database lookup and belongs deeper in your service layer, not at the edge.

A common mistake is mixing the two. Stuffing a database call inside a schema validator or sprinkling business rules across controllers. Keep them separate. Schema validation should be cheap and stateless; business validation is a deliberate part of your domain logic.

Validation should fail loudly, early, and with clear error messages. Returning a vague 400 Bad Request without telling the client what failed wastes everyone's time. Collect all violations, not just the first one, and return them in a consistent structure.

<<<SECTION 2>>>
### Transformations

Raw input data is rarely in the shape your system wants, and raw output data is rarely in the shape the client wants. Transformations bridge those gaps.

On the **input side**, you might need to:

- Trim whitespace from strings
- Normalize emails to lowercase
- Parse a date string into a proper Date object
- Convert a comma-separated string into an array

On the **output side**, you might need to:

- Strip internal fields (like passwordHash) before sending to the client
- Rename snake_case database columns to camelCase for a JSON response
- Flatten a nested database row into a simpler DTO
- Format timestamps into ISO 8601 strings

The key insight is that transformations should be explicit, not accidental. When you just pass your database entity directly to the response, you're making an implicit transformation, and often leaking internal details. Define clear **DTOs (Data Transfer Objects)** for inputs and outputs. Libraries like class-transformer in NestJS or serializers in Django REST Framework formalize this.

A clean separation looks like: raw request -> validated & transformed DTO -> domain object -> transformed response DTO -> raw response.

<<<SECTION 3>>>
### Controllers

Controllers are the entry point of your application's HTTP layer. Their job is narrow: receive a request, delegate to a service, return a response. That's it.

A controller should not contain business logic. It should not talk to a database. It should not make decisions about what data means. It orchestrates i.e. it calls the right service method, passes in the right arguments, and maps the result to an HTTP response.

// Thin controller  
async createUser(req, res) {  
  const dto = await validate(CreateUserDto, req.body);  
  const user = await this.userService.create(dto);  
  res.status(201).json(toUserResponse(user));  
}

Fat controllers are a code smell. When your controller starts importing repositories, doing conditional logic, or orchestrating multiple services directly, it becomes impossible to test and violates the single responsibility principle.

Controllers also handle HTTP-level concerns: status codes, headers, content negotiation. The service shouldn't know or care that it's being called over HTTP. It could just as well be called from a CLI command or a job queue.

<<<SECTION 4>>>
### Services

Services are where your business logic lives. This is the heart of your application. The layer that encodes what your system actually *does*.

A service method answers questions like: "What happens when a user places an order?", "How do we process a refund?", "What are the rules around account deactivation?" The answers live here (not in controllers, not in repositories).

Services are responsible for:

- Orchestrating multiple repository calls
- Enforcing business rules and invariants
- Triggering side effects (sending emails, publishing events)
- Managing transactions

// Service handles business logic  
async placeOrder(userId, items) {  
  const user = await this.userRepo.findById(userId);  
  if (!user.isActive) throw new ForbiddenError("Account suspended");  
  
  const order = Order.create(user, items);  
  await [this.orderRepo.save](https://x.com//this.orderRepo.save)(order);  
  await this.emailService.sendOrderConfirmation(order);  
  return order;  
}

Services should be stateless. Don't store request-scoped data on a service instance. Services are typically singletons, and state on a singleton is a concurrency bug waiting to happen.

Test your services in isolation. Since they receive their dependencies via injection and don't deal with HTTP, unit testing them is clean and fast.

<<<SECTION 5>>>
### Repositories

Repositories abstract the persistence layer. Their contract is simple: they take domain objects in, return domain objects out, and hide all database implementation details in between.

Why this matters: your business logic shouldn't care whether you're using PostgreSQL, MongoDB, or a flat file. If your service is writing raw SQL or chaining ORM-specific query builders, it's coupled to the database. Swapping the database or even just testing in isolation becomes painful.

A repository's interface is domain-centric:

interface UserRepository {  
  findById(id: string): Promise<User | null>;  
  findByEmail(email: string): Promise<User | null>;  
  save(user: User): Promise<void>;  
  delete(id: string): Promise<void>;  
}

The implementation deals with the ORM or raw SQL. The rest of your app talks to the interface.

Repositories should not contain business logic. getUsersWhoSignedUpInTheLastWeekAndHaveNotMadeAPurchase is a query, not a business rule. It belongs in the repository. But deciding *what to do* with those users belongs in the service.

A common footgun: making repositories too generic (a single find(criteria) method) or too specific (one method per use case screen). Aim for methods that map naturally to domain operations.

Middlewares

Middleware sits in the request pipeline and runs before (or after) your controller. It's the right place for cross-cutting concerns. It's the logic that applies to many routes without belonging to any one of them.

Common middleware responsibilities:

- **Authentication**: Verify the JWT or session token, attach the user to the request
- **Logging**: Record request method, path, duration, status code
- **Rate limiting**: Track and throttle requests per client
- **CORS**: Set the right headers for cross-origin requests
- **Request ID injection**: Stamp every request with a unique ID for tracing
- **Body parsing**: Parse JSON or form data before it reaches a controller

Middleware should be composable and ordered deliberately. Auth middleware must run before authorization middleware. Logging middleware probably wants to wrap everything. The order matters and should be explicit.

Don't put business logic in middleware. Middleware doesn't know about your domain, it knows about requests and responses. If you find yourself checking "is this user an admin" in middleware to gate a resource-level decision, you've gone too far. That's authorization logic and it belongs in the service or a dedicated guard/policy layer.  
  
Try this trick (personal): middleware modifies or enriches the request/response pipeline. Services decide what to do with the enriched request.

<<<SECTION 6>>>
### Request Context

Request context is the mechanism for carrying per-request state across your entire call stack without threading it through every function parameter.

Consider: your auth middleware identifies the calling user. Your service needs to know who the calling user is to enforce permissions. Your audit logger needs to know who did what. Without request context, you'd have to pass currentUser as a parameter to every function in the chain.....messy and fragile.

Instead, you attach data to a context object that's scoped to the lifetime of a single request:

// Middleware attaches it  
app.use((req, res, next) => {  
  const user = verifyToken(req.headers.authorization);  
  req.context = { userId: [user.id](https://x.com//user.id), role: user.role, requestId: uuid() };  
  next();  
});  
  
// Service accesses it via injection  
async deletePost(postId) {  
  const { userId } = this.requestContext.get();  
  const post = await this.postRepo.findById(postId);  
  if (post.authorId !== userId) throw new ForbiddenError();  
  // ...  
}

In Node.js, AsyncLocalStorage makes this work safely across async boundaries without any passing. In frameworks like NestJS, a scoped REQUEST provider handles it. In Java/Spring, ThreadLocal has done this job for decades.

What belongs in request context: the authenticated user, the request ID, the tenant ID (in multi-tenant apps), the locale, and the trace context for distributed tracing.

What doesn't belong: anything that could be derived from your domain model or computed lazily. Don't stuff application state into the request context.

How It All Fits Together

The request lifecycle, cleanly layered (I tried :p) :

{{IMG:1}}

Request context flows vertically through all layers, carrying identity and tracing data. Transformations happen at the edges, input sanitized on the way in, response shaped on the way out. Each layer knows its job and only its job.

When these concerns are clearly separated, the system becomes predictable. You know where to look when something breaks. You know where to add logic when requirements change. You know what to mock when writing tests.

That's all, folks, Cheers!
