# Validation, Transformation, Controllers, Middlewares

<<<SECTION 1>>>
### Validation

The first line of defense: ensures incoming data is well-formed, complete, and in bounds before business logic runs. Two layers:

- **Schema validation:** structure and types (is it a string, a number in range, a syntactically valid email?). Declare schemas with Zod (TypeScript), Joi (Node.js), Pydantic (Python), or Jakarta Bean Validation (Java).
- **Business validation:** context-aware (username taken? enough balance?). Often needs a database lookup, so it belongs in the service layer, not the edge.

Don't mix them (no database calls in schema validators, no business rules across controllers). Schema validation is cheap and stateless; business validation is domain logic.

Fail loudly, early, and clearly: not a vague 400 Bad Request. Return all violations, not just the first, in a consistent structure.

<<<SECTION 2>>>
### Transformations

Transformations reshape input for the system and output for the client.

**Input side:**

- Trim whitespace from strings
- Normalize emails to lowercase
- Parse a date string into a Date object
- Convert a comma-separated string into an array

**Output side:**

- Strip internal fields (like passwordHash)
- Rename snake_case database columns to camelCase for JSON
- Flatten a nested database row into a simpler DTO
- Format timestamps as ISO 8601 strings

Make them explicit: returning a database entity directly is an implicit transformation that often leaks internals. Define **DTOs (Data Transfer Objects)** for inputs and outputs (formalized by class-transformer in NestJS or Django REST Framework serializers).

Clean flow: raw request -> validated & transformed DTO -> domain object -> transformed response DTO -> raw response.

<<<SECTION 3>>>
### Controllers

The HTTP layer's entry point. Narrow job: receive a request, call the right service method with the right arguments, map the result to an HTTP response. No business logic, database access, or decisions about what data means.

// Thin controller  
async createUser(req, res) {  
  const dto = await validate(CreateUserDto, req.body);  
  const user = await this.userService.create(dto);  
  res.status(201).json(toUserResponse(user));  
}

Fat controllers (importing repositories, conditional logic, orchestrating services directly) are a code smell: untestable and a single responsibility violation.

Controllers own HTTP concerns (status codes, headers, content negotiation). Services shouldn't know about HTTP; they could be called from a CLI command or job queue.

<<<SECTION 4>>>
### Services

Business logic lives here: what the system *does* (placing an order, processing a refund, account deactivation rules), not in controllers or repositories.

Responsibilities:

- Orchestrating multiple repository calls
- Enforcing business rules and invariants
- Triggering side effects (sending emails, publishing events)
- Managing transactions

// Service handles business logic  
async placeOrder(userId, items) {  
  const user = await this.userRepo.findById(userId);  
  if (!user.isActive) throw new ForbiddenError("Account suspended");  
  
  const order = Order.create(user, items);  
  await this.orderRepo.save(order);  
  await this.emailService.sendOrderConfirmation(order);  
  return order;  
}

Keep services stateless: they're usually singletons, so request-scoped data on them is a concurrency bug. With injected dependencies and no HTTP, they're easy to unit test in isolation.

<<<SECTION 5>>>
### Repositories

Repositories abstract persistence: domain objects in, domain objects out, database details hidden.

Business logic shouldn't care whether it's PostgreSQL, MongoDB, or a flat file; services writing raw SQL or ORM query builders are coupled to the database, making swaps and isolated testing painful. Domain-centric interface:

interface UserRepository {  
  findById(id: string): Promise<User | null>;  
  findByEmail(email: string): Promise<User | null>;  
  save(user: User): Promise<void>;  
  delete(id: string): Promise<void>;  
}

No business logic in repositories. getUsersWhoSignedUpInTheLastWeekAndHaveNotMadeAPurchase is a query, so it belongs in the repository; deciding *what to do* with those users belongs in the service.

Avoid making repositories too generic (a single find(criteria) method) or too specific (one method per screen). Aim for methods that map to domain operations.

**Middlewares**

Runs in the pipeline before (or after) the controller, handling cross-cutting concerns that apply to many routes:

- **Authentication**: verify the JWT or session token, attach the user to the request
- **Logging**: record method, path, duration, status code
- **Rate limiting**: track and throttle requests per client
- **CORS**: set headers for cross-origin requests
- **Request ID injection**: stamp each request with a unique ID for tracing
- **Body parsing**: parse JSON or form data before the controller

Middleware should be composable and deliberately, explicitly ordered: auth before authorization; logging probably wraps everything.

No business logic: middleware knows requests/responses, not your domain. An "is admin" check gating a resource-level decision is authorization, belonging in the service or a guard/policy layer. Middleware enriches the request; services decide what to do with it.

<<<SECTION 6>>>
### Request Context

Request context carries per-request state across the call stack without threading it through every function parameter.

Auth middleware identifies the user, the service needs it for permissions, the audit logger needs who did what. Rather than passing currentUser everywhere (messy, fragile), attach data to a context object scoped to one request:

// Middleware attaches it  
app.use((req, res, next) => {  
  const user = verifyToken(req.headers.authorization);  
  req.context = { userId: user.id, role: user.role, requestId: uuid() };  
  next();  
});  
  
// Service accesses it via injection  
async deletePost(postId) {  
  const { userId } = this.requestContext.get();  
  const post = await this.postRepo.findById(postId);  
  if (post.authorId !== userId) throw new ForbiddenError();  
  // ...  
}

Implementations: AsyncLocalStorage in Node.js (works safely across async boundaries without passing), a scoped REQUEST provider in NestJS, ThreadLocal in Java/Spring (for decades).

**Belongs in context:** authenticated user, request ID, tenant ID (multi-tenant apps), locale, trace context for distributed tracing.

**Doesn't belong:** anything derivable from the domain model or computable lazily. Don't stuff application state into it.

**How It All Fits Together**

The layered request lifecycle:

{{IMG:1}}

Request context flows vertically through all layers, carrying identity and tracing data. Transformations happen at the edges: input sanitized on the way in, response shaped on the way out. Each layer does only its own job.

Separated concerns make the system predictable: you know where to debug, where to add logic, and what to mock.
