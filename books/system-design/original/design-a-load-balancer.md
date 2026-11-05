# Design a Load Balancer

<<<SECTION 1>>>
A load balancer sits between your users and your servers, distributing incoming traffic so no single server gets overwhelmed. At 1M requests per second (an assumption for this design), designing this correctly is the difference between a system that scales and one that collapses. Let's go legends!

**Functional requirements**  
1. Distribute incoming traffic across servers (load distribution)  
2. Health checking - detect and avoid unhealthy servers  
3. SSL termination - decrypt HTTPS traffic centrally  
4. Sticky sessions - route a user to the same server consistently  
5. Support both Layer 4 and Layer 7 traffic  
6. Config system - decide which algorithm for which server pool

### Layer 4 vs Layer 7

Not all load balancing is equal. The layer at which you operate determines what you can see and do:

**Layer 4 (transport layer)** - routes based on IP address and TCP/UDP port only. Doesn't look inside the packet. Blazing fast, used for raw throughput where you don't need to inspect requests.

**Layer 7 (application layer)** - reads the actual HTTP request. Can route based on URL path, headers, and cookies. Slower but far smarter:

/api      -> API server pool

/images   -> image server pool

/checkout -> payment server pool

Most production systems use L7 for application traffic and L4 for everything else.

The single entry point - **VIP and DNS**

At scale, you run multiple load balancer nodes for redundancy. But clients need one single address. You can't give them three IPs. What if one goes down?

A VIP (Virtual IP) is a single floating IP that sits in front of all load balancer nodes. If Node 1 goes down, the VIP automatically floats to Node 2. The client never notices. They're always talking to the same IP.

DNS works similarly. It returns multiple IPs for the same domain and rotates between them. Simpler, but VIP provides faster and more reliable failover for production systems.

Client → VIP (single IP)

↓

Load Balancer Node 1

Load Balancer Node 2

Load Balancer Node 3

<<<SECTION 2>>>
### The five load balancing algorithms

1. Round robin

Requests are distributed in order -> server 1, server 2, server 3, back to server 1. Implemented as server = count % N, then increment count. Simple and effective when all servers are identical.

2. Weighted round robin

Same as round robin but servers get different weights based on their specs. A server with 32GB RAM and 16 cores gets a higher weight than one with 8GB and 4 cores - it receives proportionally more traffic. Right tool when your server fleet is heterogeneous (different configs).

3. IP hashing

Hash the client's IP address and map it to a server: server = hash(clientIP) % N. The same client always hits the same server - natural sticky sessions without needing Redis. Downside: uneven distribution if many users share an IP (e.g. corporate networks behind a NAT). Also problematic if we add or delete servers.

4. Consistent hashing

Regular hashing breaks when you add or remove servers - N changes, almost every request remaps to a different server. Consistent hashing fixes this by placing servers on a virtual ring:

Ring positions (0 -> 360):

Server A -> 90

Server B -> 180

Server C -> 270

Request hashed to position 100

go clockwise -> hits Server B at 180

-> request routed to Server B

If Server B goes down, only requests between positions 90 and 180 remap to Server C. Every other request is completely unaffected. Only 1/N of traffic remaps instead of everything. This is why consistent hashing is used in Cassandra, Redis Cluster, and CDNs.

5. Least connections

Route each new request to the server with the fewest active connections. Ideal when requests have wildly varying processing times. Some requests take 10ms, others take 10 seconds. Round-robin would pile up long requests on unlucky servers; least-connections naturally balances the actual load.

<<<SECTION 3>>>
### Health checks - active and passive

A load balancer must never send traffic to a dead server. Two complementary approaches:

1. Active - the load balancer pings each server every few seconds with a heartbeat request. No response within a timeout -> mark unhealthy, stop routing traffic there immediately.

2. Passive - the load balancer watches real traffic. Too many failed responses or timeouts from a server -> mark it unhealthy automatically.

Production systems use both. Active catches servers that go completely silent. Passive catches servers that are up but returning errors.

### SSL termination

The load balancer decrypts HTTPS traffic once at the edge, then forwards plain HTTP to backend servers. Your servers never touch encryption — the load balancer handles it centrally. SSL certificates live on the load balancer, not on each individual server. This saves significant CPU across your entire fleet.

### Sticky sessions via Redis

Sticky sessions mean a user always lands on the same server. Critical for stateful applications. With multiple load balancer nodes, each node needs to know where a user's session lives.

Redis solves this. All load balancer nodes read and write session mappings to the same Redis cluster:

User X -> LB Node 1 -> Redis: "User X -> Server 3" -> route to Server 3

User X -> LB Node 2 -> Redis: "User X -> Server 3" -> still Server 3

### Config system - Zookeeper

A central config store defines the rules -> which algorithm for which server pool, weight assignments, health check intervals, SSL certificate locations. Zookeeper is the right tool here: load balancer nodes watch it for changes and update themselves in real time, no restart needed.

<<<SECTION 4>>>
### The data layer

A load balancer is an infrastructure component, not a data-heavy application. Its storage needs are about speed and coordination, not business data persistence:

Zookeeper - config, algorithm rules, server weights

Redis - sticky sessions + shared server health state across all LB nodes

InfluxDB / Prometheus - time-series metrics: requests per second, response times, error rates, traffic distribution. Feeds monitoring dashboards like Grafana.

No traditional SQL or NoSQL DB needed - and that's what makes this design architecturally unique compared to most other systems.

### The full architecture

Client

↓

DNS / VIP  (single entry point)

↓

Load Balancer Nodes (horizontal, L4 + L7)

↓  ↑ sticky sessions + health state → Redis

↓  ↑ algorithm config              → Zookeeper

↓  ↑ metrics                       → InfluxDB

↓

Server Pools (API / Image / Payment)

↑

Health Check Service (active + passive)

<<<SECTION 5>>>
### Non-functional requirements

Scalability

At 1M req/s, a single load balancer node is itself a bottleneck. Run multiple LB nodes horizontally behind a VIP. Each node handles a slice of traffic. Redis and Zookeeper keep all nodes in sync so they behave as one coherent system.

Latency

The load balancer sits in the critical path of every request. Keep it lean -algorithm decisions are in-memory, health state is in Redis, config is cached locally from Zookeeper. The routing decision should add under 1ms to every request.

Availability

Multiple LB nodes behind a VIP means no single point of failure. If one node goes down, the VIP floats traffic to the others instantly. Health checks ensure unhealthy backend servers are removed from rotation automatically. The system degrades gracefully - fewer servers, not zero servers.

That's all folks...Cheers!
