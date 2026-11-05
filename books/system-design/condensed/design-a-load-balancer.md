# Design a Load Balancer

<<<SECTION 1>>>
A load balancer sits between users and servers, distributing traffic so no server is overwhelmed. Assumed scale: 1M requests per second.

**Functional requirements**
1. Load distribution across servers
2. Health checking - detect and avoid unhealthy servers
3. SSL termination - decrypt HTTPS centrally
4. Sticky sessions - route a user to the same server consistently
5. Support Layer 4 and Layer 7 traffic
6. Config system - which algorithm for which server pool

### Layer 4 vs Layer 7

**Layer 4 (transport)** - routes on IP address and TCP/UDP port only, without inspecting the packet. Very fast; for raw throughput.

**Layer 7 (application)** - reads the HTTP request; routes on URL path, headers, cookies. Slower but smarter:
- /api -> API server pool
- /images -> image server pool
- /checkout -> payment server pool

Most production systems use L7 for application traffic and L4 for everything else.

**Single entry point: VIP and DNS**

Multiple LB nodes run for redundancy, but clients need one address. A **VIP (Virtual IP)** is a single floating IP in front of all LB nodes; if Node 1 fails, the VIP floats to Node 2 and the client never notices.

**DNS** instead returns multiple IPs for a domain and rotates them. Simpler, but VIP gives faster, more reliable failover in production.

Client → VIP (single IP) → Load Balancer Node 1 / Node 2 / Node 3

<<<SECTION 2>>>
### The five load balancing algorithms

1. **Round robin** - server 1, 2, 3, back to 1. Implemented as server = count % N, then increment count. Good when servers are identical.

2. **Weighted round robin** - servers weighted by specs; a 32GB RAM / 16-core server gets more weight (proportionally more traffic) than an 8GB / 4-core one. For heterogeneous fleets.

3. **IP hashing** - server = hash(clientIP) % N. Same client always hits the same server: natural sticky sessions without Redis. Downsides: uneven distribution when many users share an IP (e.g. corporate NAT), and problems when servers are added or removed.

4. **Consistent hashing** - regular hashing breaks when N changes (almost every request remaps). Servers are placed on a virtual ring (0 -> 360): Server A at 90, B at 180, C at 270. A request hashed to 100 goes clockwise and hits Server B at 180. If B goes down, only requests between 90 and 180 remap to C; only 1/N of traffic remaps instead of everything. Used in Cassandra, Redis Cluster, and CDNs.

5. **Least connections** - route to the server with the fewest active connections. Ideal when processing times vary widely (10ms vs 10 seconds); round robin would pile long requests on unlucky servers.

<<<SECTION 3>>>
### Health checks - active and passive

1. **Active** - LB pings each server every few seconds with a heartbeat; no response within a timeout → mark unhealthy and stop routing to it immediately.
2. **Passive** - LB watches real traffic; too many failures or timeouts → mark unhealthy automatically.

Production uses both: active catches servers that go silent; passive catches servers that are up but returning errors.

### SSL termination

The LB decrypts HTTPS once at the edge and forwards plain HTTP to backends. Certificates live on the LB, not each server, saving significant CPU across the fleet.

### Sticky sessions via Redis

Needed for stateful apps. With multiple LB nodes, all nodes read and write session mappings in a shared Redis cluster:

User X -> LB Node 1 -> Redis: "User X -> Server 3" -> route to Server 3
User X -> LB Node 2 -> Redis: "User X -> Server 3" -> still Server 3

### Config system - Zookeeper

A central store holds rules: algorithm per server pool, weights, health check intervals, SSL certificate locations. LB nodes watch **Zookeeper** and update in real time, no restart needed.

<<<SECTION 4>>>
### The data layer

An LB is infrastructure; storage is about speed and coordination, not business data:
- **Zookeeper** - config, algorithm rules, server weights
- **Redis** - sticky sessions + shared server health state across LB nodes
- **InfluxDB / Prometheus** - time-series metrics (requests per second, response times, error rates, traffic distribution), feeding dashboards like Grafana

No traditional SQL or NoSQL DB is needed, which makes this design unusual compared to most systems.

### The full architecture

1. Client
2. DNS / VIP (single entry point)
3. Load Balancer Nodes (horizontal, L4 + L7), exchanging:
   - sticky sessions + health state ↔ Redis
   - algorithm config ↔ Zookeeper
   - metrics → InfluxDB
4. Server Pools (API / Image / Payment), monitored by the Health Check Service (active + passive)

<<<SECTION 5>>>
### Non-functional requirements

**Scalability** - at 1M req/s one LB node is a bottleneck. Run multiple LB nodes horizontally behind a VIP, each handling a slice; Redis and Zookeeper keep them in sync as one coherent system.

**Latency** - the LB is in every request's critical path. Algorithm decisions are in-memory, health state in Redis, config cached locally from Zookeeper. Routing should add under 1ms.

**Availability** - multiple LB nodes behind a VIP remove the single point of failure; if one fails, the VIP floats traffic to others instantly. Health checks remove unhealthy backends automatically. The system degrades gracefully: fewer servers, not zero.
