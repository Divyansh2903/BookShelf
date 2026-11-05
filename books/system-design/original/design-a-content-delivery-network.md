# Design a Content Delivery Network

<<<SECTION 1>>>
A CDN is not just another caching thingie, it's a geographically distributed network of servers that brings content physically closer to users. A request from Mumbai to a New York origin takes ~200ms. The same request to a Mumbai edge server takes ~5ms. That's the problem a CDN solves. Here's the full breakdown.

**Functional requirements**  
1. Store frequently requested static content close to the user geographically 2. Serve content from the nearest edge server instead of the origin  
3. Fetch from origin on cache miss and cache it for future requests  
4. Cache invalidation, i.e. keep the content fresh when the origin updates

### What to cache and what not to

Cache this

Static content that is the same for every user like HTML, CSS, JS, images, videos, fonts, PDFs. These are safe to cache because the response doesn't change per user.

Never cache the following stuff  
1. User-specific data like bank balances, DMs, watchlists. Serving this to the wrong user is a privacy breach.  
2. Real-time data like live cricket scores, stock prices, ride tracking. Stale by the time it's cached.  
3. POST/PUT/DELETE requests, anything that writes or modifies data. Never cache writes.  
4. Personalised pages, your Amazon/pinterest homepage is different from everyone else's.

The easy way to remember: same response for everyone, sure, cache it. Different per user or changes every second, nope, never cache it.

<<<SECTION 2>>>
### Geographic routing ( GeoDNS )

When a user in Mumbai types [netflix.com](https://x.com//netflix.com), something smarter than regular DNS kicks in. GeoDNS detects the user's IP, determines their location, and returns the IP of the nearest edge server, not the origin.

User in Mumbai types [netflix.com](https://x.com//netflix.com)

↓

GeoDNS detects → user is in Mumbai

↓

Returns IP of Mumbai edge server

↓

User fetches content in ~5ms instead of ~200ms

Regular DNS returns the same IP to everyone. GeoDNS returns a different IP based on geography. This is the core magic of a CDN, everything else is built on top of it.

### The three-tier architecture

Most people design CDN as two tiers : edge and origin. Production CDNs like Cloudflare and Akamai use three.

Without a middle tier, every cache miss from every edge server worldwide hits the origin directly:

Cache miss Mumbai    -> hits origin

Cache miss Singapore -> hits origin

Cache miss Dubai     -> hits origin

Cache miss London    -> hits origin

The fix is a Regional Cache (Origin Shield). It is a middle tier between edge servers and origin. Cache misses from edge servers hit the regional cache first. Only if the regional cache also misses does a single request go to origin:

Edge Server (Singapore,Mumbai, Dubai, London) → Regional Cache (Asia) → Origin

Origin gets hit once instead of thousands of times. Every subsequent edge miss gets served from the regional cache.

The complete request flow:

User in Mumbai

↓

GeoDNS → Mumbai Edge Server

↓ cache hit  → return content

↓ cache miss

Regional Cache (Asia)

↓ cache hit  → return + cache at edge

↓ cache miss

Origin Server → return + cache at regional + cache at edge

### Cache invalidation : keeping the content fresh

TTL is the primary mechanism — every cached object has an expiry time. After it expires, the edge server fetches it fresh from the origin. But TTL alone isn't enough for urgent updates.

### Purge

Explicitly tell every edge server to delete a file right now. Instant but expensive as you're sending a purge command to thousands of edge servers worldwide. Use for critical fixes only.

### Versioning

Change the filename instead of invalidating:

style.css?v=1  -> old, still cached, expires naturally

style.css?v=2  -> new, fetched fresh on first request

No purge needed. Old version expires via TTL. New version is immediately fresh. This is what most frontend engineers use in production.

<<<SECTION 3>>>
### Cache-Control headers

The origin attaches instructions to every file telling CDNs and browsers exactly how to cache it:

[netflix.com/logo.png](https://x.com//netflix.com/logo.png)

Cache-Control: public, max-age=31536000

cache everywhere for 1 year

[netflix.com/user/watchlist](https://x.com//netflix.com/user/watchlist)

Cache-Control: private, no-store

never cached anywhere (private stuff)

[netflix.com/trending.json](https://x.com//netflix.com/trending.json)

Cache-Control: public, s-maxage=300

CDN caches for 5 minutes ✅

[netflix.com/checkout](https://x.com//netflix.com/checkout)

Cache-Control: no-store

never cached, always fresh ✅

Key directives: max-age sets TTL in seconds. no-store means never cache. private means browser only, not CDN. s-maxage overrides max-age specifically for CDNs, letting browser and CDN have different TTLs.

### Now, The data layer

Storage at each tier mirrors the speed vs capacity tradeoff:

Edge Server -> Redis (in-memory, ~100GB per node). Blazing fast, limited capacity. Only the hottest content for that city.

Regional Cache -> SSD storage (~10TB per node). Fast disk, much more capacity. Warm content for the entire continent.

Origin -> S3 (unlimited). The Og source of truth. Every piece of content lives here permanently.

Metadata DB -> Cassandra. Stores TTL rules, cache policies, and cache status per content object. Edge servers query this to know how long to cache each file.

### Non-functional requirements

### Latency

The entire point of a CDN is latency reduction. Edge servers in every major city mean users almost always hit Redis-speed local cache. The three-tier architecture means the origin is rarely touched at all.

### Scalability

CDNs scale by adding more edge servers in more cities. Each edge server is independent, so no coordination is needed between them. The regional cache absorbs the load that would otherwise hit the origin, making horizontal scaling of edge servers straightforward.

### Availability

If an edge server goes down, GeoDNS automatically reroutes to the next nearest edge. If a regional cache goes down, edge servers fall back directly to origin. This is slower but functional. The system degrades gracefully at every tier.  
  
Thats all folks...Cheers!
