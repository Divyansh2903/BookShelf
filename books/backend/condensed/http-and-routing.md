# HTTP & Routing

<<<SECTION 1>>>
**What is the backend?**  
The frontend is what you see: buttons, text, images. The backend is everything running on the server (code, database, logic) that supplies the data, checks your password, and calculates your bank balance. It talks to your browser using **HTTP**.

### What is HTTP?

HTTP (HyperText Transfer Protocol) is the agreed language between browsers and servers. Every page load, form submit, or API call is an HTTP exchange: you send a **request**, the server returns a **response**.

**HTTP Responses** always have three parts (status, headers, body):

**1. Status Line:** the first line; tells you immediately whether things went well.

HTTP/1.1  200  OK  
 version   code  reason

**2. Headers:** metadata telling the browser how to handle the response.

Content-Type: application/json  
Cache-Control: max-age=3600  
Set-Cookie: session=abc123; HttpOnly

**3. Body:** the content: JSON, HTML, an image, a file. Some responses have none.

<<<SECTION 2>>>
### Status Codes

Five families:

- **1xx Informational:** request received, keep going.
- **2xx Success:** it worked.
- **3xx Redirection:** look somewhere else.
- **4xx Client error:** you made a mistake.
- **5xx Server error:** the server failed.

Common ones:

- **200 OK**: worked, here's your data.
- **201 Created**: what you sent was created.
- **301 Moved Permanently**: URL is gone for good; browser caches the redirect.
- **304 Not Modified**: nothing changed; use your cached copy.
- **400 Bad Request**: malformed request (missing field, broken JSON, etc.).
- **401 Unauthorized**: not logged in; authenticate first.
- **403 Forbidden**: logged in but no permission; logging in doesn't help.
- **404 Not Found**: nothing here.
- **429 Too Many Requests**: you're rate limited.
- **500 Internal Server Error**: something broke on the server.
- **503 Service Unavailable**: server down or overloaded; try later.

<<<SECTION 3>>>
### The Headers That Matter

**Content-Type:** body format; the browser can't parse without it.

Content-Type: application/json  
Content-Type: text/html; charset=utf-8

**Cache-Control:** how long a copy may be kept.

Cache-Control: max-age=3600   ( cache for 1 hour )  
Cache-Control: no-store        ( never cache this, sensitive data )  
Cache-Control: private        ( only this browser, not CDNs )

**Set-Cookie:** save this cookie and send it back on every future request to this domain.

Set-Cookie: session=abc123; HttpOnly; Secure; SameSite=Strict

HttpOnly: JS can't read it. Secure: HTTPS only. SameSite=Strict: never sent cross-site.

**ETag:** a fingerprint of the response. The browser sends it back next time; if it matches, the server returns 304 instead of resending, saving bandwidth.

**Retry-After:** paired with 429 or 503; seconds to wait before retrying.

<<<SECTION 4>>>
### CORS : Cross-Origin Resource Sharing

**Analogy:** the browser is a person entering a club (the server); CORS is the bouncer checking a guest list.

When the browser requests a different domain, it checks whether the server allows your origin via the Access-Control-Allow-Origin response header. If your origin is listed, the response is delivered; if not, the browser blocks it and you get a CORS error.

An **origin** is protocol + domain + port. https://app.com and https://api.app.com are different origins despite sharing a domain.

### Why CORS Exists??

Without CORS, any website could steal your data from other sites using your cookies:

1. You log into bank.com; the browser saves your session cookie.
2. You visit evil-site.com in a new tab.
3. Its JavaScript runs: fetch('https://bank.com/my-account')
4. The browser automatically attaches your bank cookie.
5. The bank sees a valid session and returns your account data.
6. The evil site reads the response: balance, account number, transaction history.

CORS stops step 6. The request still reaches the bank and the bank still responds, but the browser checks whether bank.com allows evil-site.com to read it before handing it to JavaScript. With no Access-Control-Allow-Origin header, the browser silently discards the response and the evil site gets a CORS error.

<<<SECTION 5>>>
### Simple vs Preflighted Requests

The browser splits requests into two categories.

**Simple requests** (GET, HEAD, basic POST with plain headers) go straight to the server; the browser checks CORS headers on the response.

**Preflighted requests** first trigger an automatic OPTIONS request:

OPTIONS /api/data HTTP/1.1  
Origin: https://app.com  
Access-Control-Request-Method: PUT  
Access-Control-Request-Headers: Authorization, Content-Type

This asks "may I send a PUT with an Authorization header?" The server replies with its permissions; the browser sends the real request only if approved.

**Why preflight exists:** a GET only reads, and JS can't read the response without permission, so it's safe to just try. But DELETE /account would do its damage before CORS could check the response, so the browser asks first.

Access-Control-Max-Age caches the preflight approval so the browser doesn't re-check every request:

Access-Control-Max-Age: 86400  → approved for 24 hours

**CORS is purely a browser mechanism.** curl, Node, Python, Postman ignore it. It exists only to protect users browsing the web.

### Content Negotiation and Compression

### The Core Idea

Before data is sent, browser and server agree on format, language, and body compression. The browser advertises what it handles; the server picks the best match. They negotiate on four things.

### 1. Content type, meaning what format?

Browser sends:

Accept: application/json, text/html, \*/\*

\*/\* means "anything." Preferences use quality factors:

Accept: application/json;q=1.0, text/xml;q=0.8, \*/\*;q=0.5

The server picks the highest q value it supports and confirms with Content-Type. No match: 406 Not Acceptable.

<<<SECTION 6>>>
### 2. Encoding i.e. how is the body compressed?

Browser sends:

Accept-Encoding: gzip, deflate, br, zstd

Server compresses and reports what it used:

Content-Encoding: gzip

Common algorithms:

- **gzip**: old reliable, universally supported, typically shrinks JSON by approx 77%.
- **Brotli (br)**: Google's modern algorithm, approx 82% smaller, HTTPS only.
- **Zstandard (zstd)**: Facebook's newer entry, even faster than Brotli at similar ratios.

Decompression is invisible to JavaScript: response.json() returns clean data.

### 3. Language i.e. which human language?

Accept-Language: en-IN, en;q=0.9, hi;q=0.8

This lets one URL serve different languages to different users. Server responds with Content-Language: en.

**4. Character encoding.** Basically irrelevant today: UTF-8 won, and servers always send charset=utf-8.

A server using content negotiation must tell CDNs and caches the response varies by request headers:

Vary: Accept-Encoding, Accept-Language

Without it, a CDN might cache the gzip version and serve it to a browser that only understands plain text. Vary tells caches to store separate copies per header combination.

**A full real-world exchange**

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

One round trip agrees format, compression, and language, sets caching to 5 minutes, and tells the CDN to store separate copies per encoding and language.

**Routing**

**What is Routing?**

HTTP methods (GET, POST, PUT, DELETE) express a request's **intent** (fetch data, modify data). Routing maps a combination of HTTP method and URL path to a specific server-side **handler** (business logic): the "where to go" part.

The server combines method and route into a unique key, so e.g. a \`GET\` to \`/api/users\` and a \`POST\` to \`/api/users\` never clash and can run different logic.

**Types of Routes**

1. **Static Routes**: constant URLs with no variables, e.g. \`/api/users\`.
2. **Dynamic Routes:** include variables the server uses as data, denoted by a colon, e.g. \`/api/users/:id\`. A request to \`/api/users/30\` gives the server "30" as the ID of the user to fetch.

<<<SECTION 7>>>
### Path Parameters vs. Query Parameters

Two ways to send data in the URL:

- **Path Parameters (Route Parameters):** variables in the path (e.g. \`30\` in \`/api/users/30\`), placeholders that let the server pinpoint a unique item.
- **Query Parameters:** key-value pairs appended after the path, \`/resource?key=value\`. Since \`GET\` requests have no body, these give extra instructions for handling the data: filtering, sorting, searching, or paginating.

**Nested Routing**

Defines endpoints within other routes, creating a hierarchical parent-child structure (e.g. /users/:userId/posts/:postId) that models resource relationships, improving code organization and semantic clarity by tying child resources to their parent.

**Route Versioning and Deprecation**

Versioning lets APIs evolve without breaking existing clients by supporting multiple versions at once (e.g. /v1/, /v2/), usually via URL paths, headers, or query parameters. Deprecation warnings tell clients a version is obsolete and will be removed, typically via the Deprecation and Sunset HTTP headers before final removal. \[[1](https://docs.fiserv.dev/public/docs/versioning), [2](https://medium.com/@instatunnel/api-versioning-vulnerabilities-the-deprecated-endpoints-still-accepting-requests-3b53631dfad6), [3](https://www.xmatters.com/blog/api-versioning-strategies), [4](https://www.gravitee.io/blog/api-versioning-best-practices), [5](https://openrest.krotscheck.net/api-fundamentals/api-versioning/)\]

**Catch-All Routes**

A dynamic route that matches multiple or unknown paths instead of defining each separately, acting as a fallback when no specific route matches. Used for 404 pages, nested dynamic routes, and frontend SPA routing. Examples: \* in Express/React Router, \[...slug\] in Next.js.
