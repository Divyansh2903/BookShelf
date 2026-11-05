# Design a Content Delivery Network

<<<SECTION 1>>>
A CDN is a geographically distributed network of servers that puts content physically near users. Mumbai to a New York origin: ~200ms. Mumbai to a Mumbai edge: ~5ms.

**Functional requirements**
1. Store popular static content near users.
2. Serve from the nearest edge, not the origin.
3. On miss, fetch from origin and cache it.
4. Invalidate cache when origin updates.

### What to cache and what not to

**Cache:** static content identical for every user: HTML, CSS, JS, images, videos, fonts, PDFs.

**Never cache:**
1. User-specific data (bank balances, DMs, watchlists): wrong user = privacy breach.
2. Real-time data (live cricket scores, stock prices, ride tracking): stale on arrival.
3. POST/PUT/DELETE or any write.
4. Personalised pages (Amazon/Pinterest homepage).

Rule: same for everyone, cache; per-user or changes every second, don't.

<<<SECTION 2>>>
### Geographic routing ( GeoDNS )

Regular DNS returns one IP to everyone. GeoDNS locates the user by IP and returns the nearest edge server's IP. Everything else builds on this.

1. Mumbai user types netflix.com
2. GeoDNS detects Mumbai
3. Returns Mumbai edge IP
4. Content in ~5ms, not ~200ms

### The three-tier architecture

Many designs use two tiers (edge, origin); Cloudflare and Akamai use three. With two, every edge miss (Mumbai, Singapore, Dubai, London) hits origin directly.

A **Regional Cache (Origin Shield)** sits between: edge misses go there first, and only its misses send one request to origin.

Edge (Singapore, Mumbai, Dubai, London) → Regional Cache (Asia) → Origin

Origin is hit once, not thousands of times.

**Request flow:**
1. User → GeoDNS → Mumbai edge; hit → return
2. Miss → Regional Cache (Asia); hit → return + cache at edge
3. Miss → Origin → return + cache at regional + edge

### Cache invalidation : keeping the content fresh

**TTL** (primary): each object expires, then the edge refetches from origin. Not enough for urgent updates.

**Purge:** tell every edge to delete a file now. Instant but costly (thousands of edges); critical fixes only.

**Versioning:** change the filename. `style.css?v=1` (old) expires via TTL; `style.css?v=2` is fetched fresh on first request. No purge; what most frontend engineers use.

<<<SECTION 3>>>
### Cache-Control headers

Origin attaches caching rules for CDNs and browsers:
- `netflix.com/logo.png`: `Cache-Control: public, max-age=31536000` (everywhere, 1 year)
- `netflix.com/user/watchlist`: `Cache-Control: private, no-store` (never cached)
- `netflix.com/trending.json`: `Cache-Control: public, s-maxage=300` (CDN, 5 min)
- `netflix.com/checkout`: `Cache-Control: no-store` (never cached)

`max-age` = TTL in seconds; `no-store` = never cache; `private` = browser only, not CDN; `s-maxage` overrides max-age for CDNs so browser and CDN TTLs can differ.

### Now, The data layer

Speed vs capacity per tier:
- **Edge → Redis** (in-memory, ~100GB/node): hottest content for that city.
- **Regional → SSD** (~10TB/node): warm content for the continent.
- **Origin → S3** (unlimited): permanent source of truth.
- **Metadata DB → Cassandra:** TTL rules, cache policies, cache status per object; edges query it for how long to cache each file.

### Non-functional requirements

**Latency:** edges in every major city give Redis-speed local hits; origin is rarely touched.

**Scalability:** add edges in more cities. Edges are independent (no coordination); the regional cache absorbs origin load, so edges scale horizontally.

**Availability:** edge down → GeoDNS reroutes to next nearest edge. Regional down → edges go to origin (slower, functional). Graceful degradation at every tier.
