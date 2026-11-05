# HTTP & Routing

<<<SECTION 1>>>
I'm starting this backend series here, along with the system design series. Trying to sort of share my learnings in a simpler way. Hope you all find will these articles interesting as well as insightful.

**What the heck is your backend?**  
When you open an app or website, you see buttons, text, images.. that's the frontend. But where does the data come from? Who checks your password? Who calculates your bank balance? That's the backend.

The backend is everything that runs on the server. The code, the database, and the logic that the user never sees directly. It's the engine behind the interface. The language it uses to talk to your browser? **HTTP.**

### What is HTTP?

HTTP stands for HyperText Transfer Protocol. It's the agreed-upon language between browsers and servers. Every time you load a page, submit a form, or call an API - an HTTP conversation is happening. You send a **request**, the server sends back a **response**.

HTTP Responses

After your browser sends a request, the server replies. Every single HTTP response has the same three-part structure (Status-headers-body):

**1. Status Line:** It is the very first line. Tells you instantly if things went well or badly.

HTTP/1.1  200  OK  
 version   code  reason

**2. Headers:** Your metadata. Tells the browser how to handle the response.

Content-Type: application/json  
Cache-Control: max-age=3600  
Set-Cookie: session=abc123; HttpOnly

**3. Body:** It is the actual content. JSON, HTML, an image, a file. Some responses have no body at all.

<<<SECTION 2>>>
### Status Codes

That three-digit number is the first thing any developer looks at. They're grouped into five families:

- **1xx == Informational.** Request received, keep going.
- **2xx == Success.** It worked, wowee
- **3xx == Redirection.** Go look somewhere else.
- **4xx == Client error.** You made a mistake.
- **5xx == Server error.** The server crashed.

I'm mentioning some famous ones

**200 OK** means worked, here's your data.   
**201 Created** means you sent something & it was successfully created.    
**301 Moved Permanently** means this URL is dead forever. Browser caches the redirect.   
**304 Not Modified** means nothing changed since last time. Use your cached copy.   
**400 Bad Request** means your request was malformed. Missing a field, broken JSON, etc.   
**401 Unauthorized** means you're not logged in. Go authenticate first, smarty   
**403 Forbidden** means you're logged in, but you don't have permission. Being logged in doesn't help here.   
**404 Not Found** means nothing is here.  
**429 Too Many Requests** means you're being rate limited. Slow down, shorty.  
**500 Internal Server Error** means something exploded on the server.   
**503 Service Unavailable** means server is down or overloaded. Try again later.

<<<SECTION 3>>>
### The Headers That Matter

**Content-Type:** The format of your body, The browser can't parse it without this.

Content-Type: application/json  
Content-Type: text/html; charset=utf-8

**Cache-Control** means how long can you keep a copy?

Cache-Control: max-age=3600   ( cache for 1 hour )  
Cache-Control: no-store        ( never cache this, sensitive data )  
Cache-Control: private        ( only this browser, not CDNs )

**Set-Cookie** : Save this cookie and send it back on every future request to this domain.

Set-Cookie: session=abc123; HttpOnly; Secure; SameSite=Strict

HttpOnly means JS can't read it. Secure means HTTPS only. SameSite=Strict means never sent cross-site.

**ETag:** It is a fingerprint of the response. Browser sends it back next time. If it matches, server returns 304 instead of resending everything. Saves bandwidth.

**Retry-After** : It is paired with 429 or 503. Tells you how many seconds to wait before trying again.

<<<SECTION 4>>>
### CORS : Cross-Origin Resource Sharing

The OG The Nightclub Analogy

Your browser is a person trying to get into a club. The server is the club. CORS is the bouncer at the door checking a guest list.

When your browser makes a request to a different domain, the bouncer steps in: *"* Did this server put you on the guest list?" The server signals yes or no through a response header i.e. Access-Control-Allow-Origin. If your origin is listed, you're in. If not, the browser blocks the response and you get a CORS error.

An origin is protocol + domain + port together. [https://app.com](https://app.com) and [https://api.app.com](https://api.app.com) are different origins even though they share a domain.

### Why CORS Exists??

Without CORS, any website could secretly steal your data from other sites using your own cookies. Here's exactly how:

1. You log into [bank.com](https://x.com//bank.com). Browser saves your session cookie.
1. You visit [evil-site.com](https://x.com//evil-site.com) in a new tab.
1. Evil site's JavaScript quietly runs: fetch('[https://bank.com/my-account](https://bank.com/my-account)')
1. Your browser automatically attaches your bank cookie to the request.
1. Bank sees a valid session and returns your account data.
1. Evil site reads the response. Your balance, account number, transaction history, entirely gone.

CORS stops step 6. The request still goes to the bank. The bank still responds. But the browser intercepts the response before handing it to JavaScript and asks, "does [bank.com](https://x.com//bank.com) allow [evil-site.com](https://x.com//evil-site.com) to read this?" No Access-Control-Allow-Origin header? Browser silently discards the response. Evil site gets a CORS error instead of your data.

<<<SECTION 5>>>
### Simple vs Preflighted Requests

Not all requests are treated equally. The browser splits them into 2 categories.

**Simple requests** go straight to the server. No questions asked first. GET, HEAD, and basic POST requests with plain headers. The browser just sends them and checks the CORS headers on the way back.

**Preflighted requests** trigger a "can I actually do something?" check first. Before sending the real request, the browser automatically fires an OPTIONS request:

OPTIONS /api/data HTTP/1.1  
Origin: [https://app.com](https://app.com)  
Access-Control-Request-Method: PUT  
Access-Control-Request-Headers: Authorization, Content-Type

It's asking: "I want to send a PUT request with an Authorization header, is that allowed?" Server replies with its permissions, browser checks, then sends the real request only if approved.

**Why does preflight exist?** A GET just reads data, so even if it goes through, JS can't read the response without permission. Safe to just try. But DELETE /account actually deleted something. The damage is done before CORS can even check. So the browser asks permission before pulling the trigger.

The Access-Control-Max-Age header caches preflight approval so the browser doesn't have to re-check on every single request:

Access-Control-Max-Age: 86400  → approved for 24 hours

And the thing most developers forget: **CORS is purely a browser mechanism.** curl, Node, Python, Postman - none of them care about CORS. It only exists to protect real users browsing the web.

### Content Negotiation and Compression

### The Core Idea

The browser and server don't just talk, they negotiate. Before data is sent, they agree on the format, the language, and how the body should be compressed. The browser advertises what it can handle; the server picks the best match.

The Four Things They Negotiate On

### 1. Content type, meaning what format?

Browser sends:

Accept: application/json, text/html, \*/\*

The \*/\* wildcard means "I'll take anything." You can express preferences with quality factors:

Accept: application/json;q=1.0, text/xml;q=0.8, \*/\*;q=0.5

Server picks the highest q value it supports and confirms with Content-Type. If nothing matches: 406 Not Acceptable.

<<<SECTION 6>>>
### 2. Encoding i.e. how is the body compressed?

Browser sends:

Accept-Encoding: gzip, deflate, br, zstd

Server compresses and tells you what it used:

Content-Encoding: gzip

Three compression algorithms in common use   
 **gzip** is the old reliable, universally supported, typically shrinks JSON by approx 77%.   
**Brotli (br)** is Google's modern algorithm, approx 82% smaller, HTTPS only. **Zstandard (zstd)** is Facebook's newer entry, even faster than Brotli at similar ratios.   
The decompression is entirely invisible to your JavaScript. You call response.json() and get clean data.

### 3. Language i.e. which human language?

Accept-Language: en-IN, en;q=0.9, hi;q=0.8

This is how the same URL serves different languages to different users. Server responds with Content-Language: en.

**4. Character encoding.** Basically irrelevant today. UTF-8 won. Servers just always send charset=utf-8.

When a server uses content negotiation, it must tell CDNs and caches that the response can differ based on request headers:

Vary: Accept-Encoding, Accept-Language

Without this, a CDN might cache the gzip version of a response and serve it to a browser that only understands plain text, which would be complete garbage. Vary tells caches: "store separate copies for different header combinations."

A Full Real-World Exchange

Request:

GET /api/products HTTP/1.1  
Accept: application/json  
Accept-Encoding: gzip, br  
Accept-Language: en-IN, en;q=0.9

Response:

HTTP/1.1 200 OK  
Content-Type: application/json; charset=utf-8  
Content-Encoding: br  
Content-Language: en  
Vary: Accept-Encoding, Accept-Language  
Cache-Control: max-age=300

In one round trip: format agreed, compression agreed, language agreed, caching set to 5 minutes, and the CDN now knows to store separate copies per encoding and language. That's content negotiation doing its full job.  
  
  
**Routing**  
  
**What is Routing?**

The HTTP methods that we learned about - (GET, POST, PUT, DELETE) express the **intent** of a request. Like I want to fetch some data or maybe modify some existing stuff.   
The internet definition- Routing is the process of mapping a combination of an HTTP method and a URL path to a specific server-side Handler (a set of instructions or business logic).  
So basically, routing is about the path or the "where to go" expression. In easier terms, "what destination do you want to hit actually? \*

There is a uniqueness here. Your server concatenates the HTTP method and the route to form a unique key. For example, a \`GET\` request to \`/api/users\` and a \`POST\` request to \`/api/user\` won't ever clash or anything (While implementing different logics).

**Types of Routes**   
  
The 2 types of routes are:   
 1. **Static Routes**: Like the example we just saw - \`/api/users\`. No variable parameters or anything here. Just a mere constant URL.  
  
2. **Dynamic Routes:** As the name suggests, these routes include variables that the target server uses as data. These variables are denoted by a colon, like- \`/api/users/:id\`. If a client requests \`/api/users/30\`, the server extracts "30" as the ID to fetch the data of that particular user.

<<<SECTION 7>>>
### Path Parameters vs. Query Parameters

When you are sending data to the server, you have two ways to act:  
**Path Parameters (also called the Route Parameters):** The parameters/variables that are added directly on the path, (e.g., the \`30\` in \`/api/users/30\`). They act as placeholders for specific values that help the server pinpoint a unique item.  
  
**Query Parameters:** Your \`GET\` requests don't have a 'body'. These query params are appended to the end of a URL. They provide additional instructions for handling the requested data. Sort of Key-value pairs after the path.   
Syntax looks like this - \`/resource?key=value\`  
The purpose is filtering, sorting, searching, or paginating through results.  
  
  
**Nested Routing**

Nested routing in backend development defines API endpoints within other routes, creating a hierarchical, parent-child structure (e.g., /users/:userId/posts/;postId) that models resource relationships. It enhances code organization and semantic clarity by associating child resources with their parent.  
  
**Route Versioning and Deprecation**   
  
Route versioning allows APIs to evolve without breaking existing clients by supporting multiple versions simultaneously (e.g., /v1/, /v2/), typically implemented via URL paths, headers, or query parameters. Deprecation warnings notify clients that an API version is obsolete and will be removed, typically communicated via the Deprecation and Sunset HTTP headers before final removal. \[[1](https://docs.fiserv.dev/public/docs/versioning), [2](https://medium.com/@instatunnel/api-versioning-vulnerabilities-the-deprecated-endpoints-still-accepting-requests-3b53631dfad6), [3](https://www.xmatters.com/blog/api-versioning-strategies), [4](https://www.gravitee.io/blog/api-versioning-best-practices), [5](https://openrest.krotscheck.net/api-fundamentals/api-versioning/)\]

**Catch-All Routes**  
  
A catch-all route is a dynamic route that matches multiple or unknown URL paths instead of defining each route separately. It acts as a fallback handler when no specific route matches. Catch-all routes are commonly used for 404 pages, nested dynamic routes, and frontend SPA routing. Examples include \* in Express/React Router or \[...slug\] in Next.js.  
  
  
That's all for this article, folks!!
