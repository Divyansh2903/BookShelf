# Rest API Design

<<<SECTION 1>>>
## The Complete Guide to REST API Design

REST APIs power nearly every modern web application, from the button that loads your Instagram feed to the checkout flow on an e-commerce site. Yet despite being everywhere, they're surprisingly easy to design badly. This article walks through everything (I tried) you need to know to design REST APIs that are clean, scalable, and a joy to work with.

## Where REST Came From

The web in the 1990s was growing faster than anyone had anticipated, and the infrastructure holding it together was starting to buckle under the pressure. In 2000, a computer scientist named Roy Fielding proposed a solution: a set of architectural principles he called **REST** (short for **Representational State Transfer)**.

The name sounds dense, but it breaks down simply. A resource (say, a user profile or a product listing) can be represented in different formats depending on who's asking, JSON for a mobile app, HTML for a browser. The state refers to the current snapshot of that resource. And transfer is just the act of moving that representation between a client and a server over HTTP.

<<<SECTION 2>>>
## The Six Constraints That Make an API Truly RESTful

Fielding didn't just give REST a name, he gave it rules. A system claiming to be RESTful should satisfy six architectural constraints:

**1. Client-Server Separation:** The client and server are independent. The client owns the user interface; the server owns the data and business logic. Neither should need to know how the other works internally.

**2. Uniform Interface:** All interactions between components follow a consistent, standardized contract. This predictability is what makes REST APIs easy to consume by any client, anywhere.

**3. Layered Architecture:** The system can be composed of layers like load balancers, caches, proxies, sitting between the client and server. Each layer only knows about the one directly next to it, which improves both security and horizontal scalability.

**4. Cacheability:** Every response must explicitly declare whether it can be cached. Proper caching dramatically reduces unnecessary server load and speeds up the client experience.

**5. Statelessness:** This is arguably the most important constraint. The server holds zero memory of previous requests. Every single request from a client must carry all the context needed to process it - authentication token, user ID, everything. This is what allows REST systems to scale horizontally with ease.

**6. Code on Demand** (Optional) *-* Servers can extend client behavior by sending executable code. JavaScript being the most obvious example. This constraint is optional and rarely discussed in practical API design.

<<<SECTION 3>>>
## Designing Clean, Readable URLs

A well-designed URL should read almost like a sentence. Before writing a single line of code, think carefully about your route structure.

A standard API URL looks like this:

[https://api.example.com/v1/users](https://api.example.com/v1/users)

Each piece matters:

- https : Always use a secure scheme.
- api. : A dedicated subdomain keeps your API separate from your main web app.
- v1 : Version your API from day one. When you ship breaking changes, you bump to v2 without breaking existing clients.
- users : The resource name, always a **plural noun**.

**Always use plural nouns.** Even when fetching a single item, the resource itself is still part of a collection. /users/123 is correct; /user/123 is not.

**Use hyphens, not underscores.** URLs should be lowercase, with hyphens separating words. /blog-posts, not /blog_posts or /blogPosts.

**Express hierarchy through nesting.** A route like /organizations/42/projects clearly communicates "the projects belonging to organization 42." Nesting should reflect actual ownership relationships in your data model, but avoid going more than two or three levels deep, it gets unwieldy fast.

<<<SECTION 4>>>
## HTTP Methods and the Concept of Idempotency

Choosing the right HTTP method is about more than convention, it's about communicating intent. A key concept here is **idempotency**: an operation is idempotent if performing it once or a hundred times produces the exact same server state.

Method   Purpose  Idempotent?       
GET - Retrieve a resource - Yes     
POST - Create a new resource  - No     
PUT - Replace a resource entirely - Yes     
PATCH - Update specific fields - Yes     
DELETE -  Remove a resource - Yes

**POST is the only non-idempotent method.** Send the same POST request ten times, and you'll create ten separate records with ten different IDs. This is why payment systems need to implement idempotency keys, to prevent duplicate charges from accidental retries.

**PATCH vs. PUT** is a common source of confusion. Use PATCH when a client wants to update one or two fields (changing a user's email, for instance). Use PUT when a client is sending a complete replacement of the entire resource. In practice, PATCH is far more common in modern APIs.

<<<SECTION 5>>>
## When Standard CRUD Isn't Enough

CRUD covers most operations, but not all. What about "cloning" a project? Or "archiving" an organization, which might trigger a whole cascade of background jobs : notifying members, cleaning up billing, locking data?

These actions don't map cleanly onto a simple update. REST handles this by appending a **verb at the end of a specific resource route**, always as a POST request:

POST /projects/123/clone  
POST /organizations/5/archive  
POST /invoices/88/send

This pattern keeps the intent readable while staying consistent with REST conventions. The resource is identified first, the action follows.

## Building List Endpoints That Don't Break Under Load

A GET endpoint that returns a list of items sounds simple, until your database has 500,000 records and a client requests all of them at once. Any production-grade list API needs three things:

**Pagination:** Never return unbounded lists. Break results into pages and include metadata alongside the data:

{  
  "data": \[...\],  
  "total": 4823,  
  "page": 2,  
  "totalPages": 193  
}

The total field is especially useful for frontend engineers rendering "Page 2 of 193" or progress indicators.

**Sorting:** Let clients control the order via query parameters:

GET /articles?sortBy=publishedAt&sortOrder=descending

Always define sensible server-side defaults. created_at descending is a safe choice for most resources.

**Filtering:** Clients should be able to narrow results without fetching everything:

GET /users?status=active&role=admin

Combine all three and a single endpoint becomes remarkably powerful:

GET /orders?status=pending&sortBy=createdAt&sortOrder=ascending&page=1&limit=20

<<<SECTION 6>>>
## Using Status Codes Correctly

HTTP status codes are part of your API's contract. Misusing them forces clients to parse response bodies just to figure out if something went wrong.

- **200 OK** : The default success response for GET, PATCH, PUT, and custom actions.
- **201 Created** : Return this specifically when a POST creates a new resource. It signals something new now exists in the database.
- **204 No Content** : The right response after a successful DELETE. Success, but nothing to return.
- **400 Bad Request** : The client sent malformed or invalid data.
- **401 Unauthorized** : The request lacks valid authentication credentials.
- **403 Forbidden** : The client is authenticated but doesn't have permission for this action.
- **404 Not Found** : A specific resource ID doesn't exist.
- **409 Conflict** : The request conflicts with existing state (e.g., trying to create an account with an email that already exists).
- **422 Unprocessable Entity** : The request was well-formed but failed validation rules.
- **500 Internal Server Error** : Something broke on the server side.

One rule worth calling out: if a client hits a list endpoint and the filters return zero results, return **200 with an empty array, and not a 404**. An empty result set isn't an error; it's a valid answer.

<<<SECTION 7>>>
## Golden Rules for API Engineers

**Mine the UI for your data model:** Before designing any endpoint, look at the product mockups. What data does the user actually interact with? The nouns like users, projects, tasks, invoices become your resources. The actions become your methods.

**Build in sane defaults:** Your API will be called by client code written by tired engineers at 2am (me) who forgot to include pagination parameters. Don't crash. Default the page size to 10, the sort order to newest-first, and new records' status to active. Reasonable defaults make your API resilient and forgiving.

**Enforce consistency ruthlessly:** Use camelCase for all JSON keys, everywhere, always. If a field is called organizationName in one endpoint, it cannot be org_name or orgname in another. Inconsistency forces every consumer of your API to write extra defensive code, and breeds justified resentment.

**Document interactively:** Static documentation gets outdated. Tools like **Swagger (OpenAPI)** generate living, interactive documentation where frontend developers can make real test calls against your API from the browser. Treat documentation as a first-class deliverable, not an afterthought.

**Design for the consumer, not the database:** Your API is a product. The shape of your endpoints should reflect how clients need to use the data, not how it happens to be stored in your database. Resist the temptation to expose raw table structures, that's an implementation detail, not an interface.

I hope this article helped you (even a bit) in understanding some useful practices while designing efficient RESTful APIs.

That's all folks, Cheers!
