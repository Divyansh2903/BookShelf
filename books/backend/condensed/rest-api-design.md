# Rest API Design

<<<SECTION 1>>>
## The Complete Guide to REST API Design

REST APIs power nearly every modern web app (an Instagram feed, an e-commerce checkout) yet are easy to design badly. This guide covers how to design clean, scalable ones.

## Where REST Came From

In the 1990s the web grew faster than anticipated and its infrastructure began to buckle. In 2000, Roy Fielding proposed a set of architectural principles: **REST (Representational State Transfer)**.

- **Representation**: a resource (a user profile, a product listing) can be represented in different formats depending on who asks: JSON for a mobile app, HTML for a browser.
- **State**: the current snapshot of that resource.
- **Transfer**: moving that representation between client and server over HTTP.

<<<SECTION 2>>>
## The Six Constraints That Make an API Truly RESTful

A RESTful system should satisfy six architectural constraints:

1. **Client-Server Separation:** Client owns the UI; server owns data and business logic. Neither needs to know how the other works internally.
2. **Uniform Interface:** All interactions follow a consistent, standardized contract, making the API easy for any client to consume.
3. **Layered Architecture:** Layers (load balancers, caches, proxies) can sit between client and server. Each knows only its immediate neighbor, improving security and horizontal scalability.
4. **Cacheability:** Every response must explicitly declare whether it can be cached. Proper caching cuts server load and speeds up clients.
5. **Statelessness:** Arguably the most important. The server keeps no memory of previous requests; each request carries all needed context (auth token, user ID, everything). This enables easy horizontal scaling.
6. **Code on Demand (optional):** Servers can extend client behavior by sending executable code, JavaScript being the obvious example. Rarely discussed in practical API design.

<<<SECTION 3>>>
## Designing Clean, Readable URLs

A good URL reads almost like a sentence. Plan the route structure before writing code. Standard form:

[https://api.example.com/v1/users](https://api.example.com/v1/users)

- **https**: always use a secure scheme.
- **api.**: a dedicated subdomain separates the API from the main web app.
- **v1**: version from day one; ship breaking changes as v2 without breaking existing clients.
- **users**: the resource name, always a plural noun.

**Plural nouns:** even a single item belongs to a collection. /users/123 is correct; /user/123 is not.

**Hyphens, not underscores:** lowercase, hyphen-separated. /blog-posts, not /blog_posts or /blogPosts.

**Nesting for hierarchy:** /organizations/42/projects means "projects belonging to organization 42". Nesting should reflect real ownership in the data model; avoid going more than two or three levels deep.

<<<SECTION 4>>>
## HTTP Methods and the Concept of Idempotency

The method communicates intent. An operation is **idempotent** if doing it once or a hundred times yields the same server state.

| Method | Purpose | Idempotent? |
|---|---|---|
| GET | Retrieve a resource | Yes |
| POST | Create a new resource | No |
| PUT | Replace a resource entirely | Yes |
| PATCH | Update specific fields | Yes |
| DELETE | Remove a resource | Yes |

**POST is the only non-idempotent method.** Sending the same POST ten times creates ten records with ten IDs. That's why payment systems use idempotency keys, to prevent duplicate charges from accidental retries.

**PATCH vs. PUT:** use PATCH to update one or two fields (e.g. a user's email); use PUT to send a complete replacement of the resource. PATCH is far more common in modern APIs.

<<<SECTION 5>>>
## When Standard CRUD Isn't Enough

Some actions don't map to a simple update, e.g. cloning a project, or archiving an organization, which may trigger a cascade of background jobs (notifying members, cleaning up billing, locking data). REST handles these by appending a **verb to a specific resource route**, always as a POST:

POST /projects/123/clone  
POST /organizations/5/archive  
POST /invoices/88/send

The resource is identified first, the action follows.

## Building List Endpoints That Don't Break Under Load

A list endpoint must not return all 500,000 records at once. Production list APIs need three things:

**Pagination:** never return unbounded lists. Return pages with metadata:

{  
  "data": \[...\],  
  "total": 4823,  
  "page": 2,  
  "totalPages": 193  
}

total lets frontends render "Page 2 of 193" or progress indicators.

**Sorting:** via query parameters, with sensible server-side defaults (created_at descending is safe for most resources):

GET /articles?sortBy=publishedAt&sortOrder=descending

**Filtering:** let clients narrow results without fetching everything:

GET /users?status=active&role=admin

Combined:

GET /orders?status=pending&sortBy=createdAt&sortOrder=ascending&page=1&limit=20

<<<SECTION 6>>>
## Using Status Codes Correctly

Status codes are part of the API contract; misusing them forces clients to parse bodies to detect errors.

- **200 OK**: default success for GET, PATCH, PUT, and custom actions.
- **201 Created**: when a POST creates a new resource.
- **204 No Content**: after a successful DELETE; success, nothing to return.
- **400 Bad Request**: malformed or invalid data.
- **401 Unauthorized**: missing valid authentication credentials.
- **403 Forbidden**: authenticated but lacks permission.
- **404 Not Found**: a specific resource ID doesn't exist.
- **409 Conflict**: conflicts with existing state (e.g. creating an account with an existing email).
- **422 Unprocessable Entity**: well-formed but fails validation rules.
- **500 Internal Server Error**: something broke server-side.

If list filters match nothing, return **200 with an empty array, not 404**. An empty result is a valid answer, not an error.

<<<SECTION 7>>>
## Golden Rules for API Engineers

- **Mine the UI for your data model:** study product mockups first. The nouns users interact with (users, projects, tasks, invoices) become resources; the actions become methods.
- **Build in sane defaults:** clients will forget pagination parameters; don't crash. Default page size to 10, sort to newest-first, and new records' status to active.
- **Enforce consistency ruthlessly:** camelCase for all JSON keys everywhere. If a field is organizationName in one endpoint, it can't be org_name or orgname in another; inconsistency forces consumers to write defensive code.
- **Document interactively:** static docs go stale. **Swagger (OpenAPI)** generates living, interactive docs where frontend developers can make real test calls from the browser. Treat docs as a first-class deliverable.
- **Design for the consumer, not the database:** the API is a product. Endpoints should reflect how clients use the data, not how it's stored. Don't expose raw table structures; they're an implementation detail, not an interface.
