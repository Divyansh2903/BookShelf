# Design Discord

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

- Create servers (guilds) and channels
- Text messaging in channels with message history
- Roles and per-channel permissions
- Direct messages (1:1 and group), presence, and typing indicators
- Notifications
- Search across messages

### Out of Scope

- Voice and video (WebRTC and media servers, a separate system)
- Bots and webhooks
- Moderation tooling and audit logs
- Go Live streaming

### Non-Functional Requirements

- Highly scalable, from 5-member friend servers to servers with millions of members
- Low latency, messages delivered to online members within a few hundred milliseconds
- Fault tolerance, no single point of failure on the message path
- High throughput in busy servers and hot channels
- Strict per-channel message ordering, every client sees the same order
- Eventual consistency acceptable for presence, typing, and unread counters
- Strong enforcement of permissions on the server side

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 500 million
- **Peak concurrent users:** ~100 million (20% of DAU), each holding one WebSocket connection
- **Messages per day:** 500M x 10 = ~1 billion
- **Write QPS:** 1B / 86,400 = ~11.5K per second average, ~35K per second at peak
- **Message size:** ~1 KB including metadata (a sentence of text is 100 to 200 bytes)
- **Text storage:** 1B x 1 KB = ~1 TB per day, ~365 TB per year, ~1.1 PB per year with replication factor 3
- **Attachments:** assume 10% of messages carry a 1 MB file, so ~100 TB per day in S3 and CDN. Messages store only a URL.
- **Gateway servers:** at ~100K to 500K connections each, ~200 to 1,000 gateways
- **Fan-out:** one message in a server with 500K online members is 500K deliveries. At 100 messages per second that is 50M deliveries per second for one server.

Discord’s load is highly skewed. Most servers have 10 to 50 members, while a few giants have hundreds of thousands online at once. The dominant challenges are holding 100M WebSocket connections and fan-out in giant servers, not raw storage.

<<<SECTION 3>>>
## 3. High Level Services

- **User Service:** profiles, settings, friend lists
- **Guild Service:** servers, channels, categories, invites (low write, merged Server and Channel service)
- **Permission Service:** roles, per-channel overrides, cached permission checks
- **Gateway Service:** holds persistent WebSocket connections, stateful, only moves bytes
- **Message Service:** stateless send and history path, validation, ID assignment, persistence
- **Presence Service:** online status and typing indicators, ephemeral
- **Media Service:** presigned S3 URLs for attachments
- **Notification Service:** push, unread counters, mentions
- **Search Service:** Elasticsearch over messages

### Gateway vs Message Service

The Gateway is the phone line: it keeps a live connection per user and carries bytes in both directions. It is stateful and scales with the number of connections (100M). The Message Service is the clerk: it checks rules, assigns an ID, saves the message, and publishes it. It is stateless and scales with messages per second (35K). Splitting them lets each tier scale independently. A crashed Gateway just means clients reconnect. A crashed Message Service instance just means a retry.

<<<SECTION 4>>>
## 4. API Gateway and Service Discovery

REST requests (create server, edit profile, fetch history) pass through the API Gateway for authentication and rate limiting. Real-time traffic uses WebSockets.

When a client comes online, a load balancer and a service registry (etcd or Consul) assign it a healthy Gateway. The registry also answers “which Gateway holds user X’s connection?” for other services. On connect the Gateway authenticates the token, then the client sends heartbeats every ~30 seconds.

Binary media never passes through the API Gateway. Uploads use presigned S3 URLs.

## 5. Message Send Path

A user sends "hello" in [#general](https://x.com/search?q=%23general&src=hashtag_click)  
-> Gateway A (holds his WebSocket)  
-> Message Service:  
     1. Permission check (can they post in this channel?)  
     2. Assign Snowflake ID  
     3. Persist to Cassandra  
     4. Publish to Kafka (partitioned by channel_id)  
-> Fan-out to Gateways subscribed to the channel  
-> Each Gateway pushes to its local WebSocket connections

Message ID: Snowflake

A 64-bit integer:

| 41 bits: timestamp (ms since custom epoch) | 10 bits: worker ID | 12 bits: sequence |

The timestamp sits in the high bits, so IDs sort by time without a separate timestamp column. Worker ID gives uniqueness across machines without coordination. The sequence handles up to 4,096 IDs per millisecond per worker. Each Message Service instance generates IDs locally, so there is no central bottleneck.

Ordering

Clients never decide order because their clocks disagree. The server does:

1. Kafka is partitioned by channel_id. A partition is a strictly ordered log, so one channel always has a single, agreed order.
1. The Message Service stamps the Snowflake ID. Ties in the same millisecond are broken by worker ID and sequence.

All clients sort by Snowflake ID and see the same order. Unlike Google Docs, no Operational Transformation is needed. Chat messages are independent appends, not concurrent edits to shared state.

Tradeoff: one partition per channel caps throughput for an extremely hot channel. That is acceptable because a channel with thousands of messages per second is already unreadable.

<<<SECTION 5>>>
## 6. Fan-out and the 500K Member Problem

### Why per-user queues fail???

Giving every recipient their own queue is fan-out on write. At 100 members that is fine. At 500K online members, one message means 500K writes, and at 100 messages per second that is 50M writes per second for a single server.

Solution: Fan-out per Gateway, not per user

500K online members are spread across roughly 500 gateways. Publish once per Gateway instead of once per user:

1. **Subscription map.** Each Gateway keeps in memory which of its local users are viewing which channel.
1. **Gateway subscribes to the channel topic** (Redis Pub/Sub or a Kafka consumer) when its first local user opens the channel, and unsubscribes when the last leaves.
1. **One publish per message** to channel:42. Every subscribed Gateway receives it.
1. **Local fan-out.** Each Gateway loops over its own connections for that channel and writes to each WebSocket. This is an in-memory loop of microseconds.

Message Service -> publish once to channel:42  
    -> Gateway 1 (800 local members) -> 800 WebSocket writes  
    -> Gateway 2 (950 local members) -> 950 WebSocket writes  
    -> ... (~500 gateways)

Work drops from 500K deliveries to about 500 publishes per message, a 1000x reduction.

What still breaks and how to handle it

- **Hot channel.** All traffic for one channel goes through one Kafka partition and one pub/sub channel. Very large servers shard the pub/sub layer or add a relay tier (a tree of relays between the publisher and the gateways).
- **Per-Gateway write volume.** 100 messages per second x 1,000 local users = 100K WebSocket writes per second on one Gateway. This is the practical ceiling.
- **Lazy delivery.** Users not currently viewing a channel receive only a lightweight unread or mention counter, not the full message. Full messages go only to users with that channel open. This cuts real fan-out sharply.

<<<SECTION 6>>>
## 7. Message Storage

Cassandra (ScyllaDB)

Messages are append-only and always read by channel in time order, which suits a wide-column store with horizontal scaling and replication factor 3.

Naive key: channel_id

```
channel_id    BIGINT, partition key
message_id    BIGINT (Snowflake), clustering key DESC
```

Problems with this key:

- Partitions grow without limit (a channel with 50M messages becomes a multi-GB partition)
- Hot partitions for busy channels
- Slow compaction, GC pauses, and painful node repair
- Poor performance when scrolling deep into old history

Fix: time bucketing

Messages (Cassandra)

```
channel_id    BIGINT
bucket        INTEGER (floor(timestamp_ms / 10 days in ms))
message_id    BIGINT (Snowflake), clustering key DESC
author_id     BIGINT
content       TEXT
attachments   LIST<TEXT>
edited_at     TIMESTAMP
deleted       BOOLEAN
PRIMARY KEY ((channel_id, bucket), message_id)
```

The bucket is computed from the Snowflake timestamp with no extra lookup, and each partition stays bounded.

**Write path:** compute the bucket from the new ID and write to (channel_id, bucket).

**Read path:** read the newest 50 from the current bucket. If fewer than 50 are returned, step back through earlier buckets until 50 are collected. A cached “last message” pointer per channel avoids scanning empty buckets on quiet channels.

Supporting techniques

- **Hot-channel cache.** The latest ~50 messages of active channels live in Redis, so most reads never touch Cassandra.
- **Soft deletes.** Deletes write tombstones that hurt reads in busy partitions, so use a deleted flag and let compaction or TTL clean up later.
- **Attachments** live in S3 behind a CDN. The row stores only the URL.

<<<SECTION 7>>>
## 8. Presence and Typing Indicators

### Presence: heartbeat plus TTL

```
Key: presence:{user_id}
Value: { status: "online" | "idle" | "dnd", last_seen, gateway_id }
TTL: 60 seconds
```

The client sends a heartbeat every ~30 seconds, and the Gateway refreshes the TTL. If the app closes or the network drops, the key expires and the user shows offline. The client reports idle after 5 minutes without input.

### The real problem: who is notified?

One status flip for a user in 20 servers of 100K members each would mean 2M notifications. Fixes:

1. **Notify only people who can see you right now.** Friends, and members of servers whose member list is open on a client.
1. **Lazy presence for big servers.** Above a size threshold (say 100K members) do not push individual changes. The client requests presence only for the ~50 members visible in the sidebar and refreshes as the user scrolls.
1. **Debounce.** Wait a few seconds before broadcasting an offline transition so flaky connections do not flap.
1. **Gateway-level fan-out.** Publish one change per interested Gateway, and each Gateway fans out locally.

### Typing indicators: ephemeral

- The client sends a typing event when typing starts, then at most once every ~5 seconds while typing continues.
- The Gateway publishes to the channel topic, and subscribed Gateways push “User is typing...” to clients viewing the channel.
- The receiving client hides the indicator after ~8 to 10 seconds with no new event. No “stopped typing” event is needed.
- Nothing is stored and nothing goes through Kafka. Losing a typing event is harmless, so Redis Pub/Sub (fire and forget) is enough.
- In very large channels the indicator is throttled hard or disabled.

### Durability

Presence is not stored durably. After a Redis restart, clients reconnect and heartbeats rebuild the state in about a minute. Only the user’s preference (for example, invisible mode) lives in the User Service database.

<<<SECTION 8>>>
## 9. Roles and Permissions

Bitmask model

Each permission is one bit:

```
VIEW_CHANNEL    = 1 << 0
SEND_MESSAGES   = 1 << 1
MANAGE_MESSAGES = 1 << 2
MANAGE_CHANNEL  = 1 << 3
ADMINISTRATOR   = 1 << 4
```

A role is a number, and a check is one bitwise AND: (permissions & SEND_MESSAGES) != 0. No joins and no list scans.

Data model

Roles

```
role_id        BIGINT, primary key
guild_id       BIGINT
name           VARCHAR
permissions    BIGINT (bitmask)
position       INTEGER (hierarchy)
```

MemberRoles

```
guild_id, user_id, role_id  
```

ChannelOverrides

```
channel_id     BIGINT 
target_id      BIGINT (role_id or user_id) 
target_type    ENUM('role', 'user') 
allow          BIGINT (bits explicitly granted) 
deny           BIGINT (bits explicitly denied)
```

1. Effective permission, general to specific
1. base = OR of the permissions of all the user’s roles
1. If base has ADMINISTRATOR, allow everything and stop
1. Apply the channel’s [@everyone](https://x.com/@everyone) override: base = (base & ~deny) | allow
1. Apply overrides for the user’s roles (OR the denies and allows together, then apply)
1. Apply the override for the specific user
1. The result is the effective bitmask for this user in this channel

The more specific rule always wins.

Making 35K checks per second fast

Key: perm:{guild_id}:{channel_id}:{user_id}:v{guild_perm_version}  
Value: effective bitmask (8 bytes)  
TTL: 10 minutes

- Hot path is one Redis GET and one bitwise AND, sub-millisecond.
- A small in-process L1 cache in the Message Service avoids most network calls.
- On a miss, load roles and overrides, compute, and store.

### Invalidation

Editing a role or override publishes permission.changed to Kafka. For a 500K-member server, deleting 500K keys is expensive, so each guild has a version number embedded in the key. Bumping guild_perm_version makes all old keys unreachable in one write, and they expire via TTL.

### Security

The check runs server side in the Message Service and is never trusted from the client. VIEW_CHANNEL is also checked before delivering any event, so users never receive messages from channels they cannot see.

<<<SECTION 9>>>
## 10. Notifications

Kafka fanout from the Message Service to the Notification Service, using the same APNs and FCM pattern as earlier designs.

- **Mentions** ([@user](https://x.com/@user), [@role](https://x.com/@role), [@everyone](https://x.com/@everyone)) generate push notifications for users who are offline or not viewing the channel.
- **Unread counters** are stored per user per channel in Redis and sent as lightweight events, not full messages.
- **Mute settings** per server and channel are checked before sending.
- [**@everyone**](https://x.com/@everyone) **in a huge server** is rate limited and processed in batches to avoid a notification storm.
- Online users receive events over their WebSocket, so push is sent only to offline devices.

## 11. Search

Elasticsearch indexes messages for search within a server or DM.

```
{
  "message_id": "1234567890",
  "guild_id": "42",
  "channel_id": "7",
  "author_id": "99",
  "content": "deploy finished successfully",
  "has_attachment": false,
  "mentions": ["123"],
  "created_at": "2026-10-25T13:00:00Z"
}
```

- Indexing is asynchronous. A Kafka consumer reads new messages and indexes them, so search lags by a few seconds, which is acceptable.
- Index routing is by guild_id, so a search touches only that server’s shard.
- Filters such as from:user, in:channel, has:file, and before:date map to Elasticsearch filter clauses.
- **Security filter:** results are limited to channels the user has VIEW_CHANNEL on.

## 12. Direct Messages

DMs reuse the same pipeline. A DM is a channel with two participants (or a few for group DMs), so it has a channel_id and the same Cassandra table, Snowflake IDs, and Kafka partitioning. Fan-out is trivial because there are only a couple of recipients. Permissions reduce to “are these users friends or share a server, and is neither blocking the other.”

<<<SECTION 10>>>
## 13. Full Data Flow Summary

**Connect Flow:**  
Client -> Load balancer + service registry -> Gateway  
    -> Authenticate token  
    -> Register connection (user_id -> gateway_id)  
    -> Heartbeat every ~30s refreshes presence TTL in Redis  
  
**Send Message Flow:**  
Client -> Gateway -> Message Service  
    -> Permission check (Redis, L1 cache, bitmask AND)  
    -> Assign Snowflake ID  
    -> Write to Cassandra (channel_id, bucket)  
    -> Publish to Kafka (partition by channel_id)  
    -> Publish once to channel pub/sub topic  
        -> Each subscribed Gateway fans out to local WebSockets  
    -> Kafka consumers:  
        -> Search indexer -> Elasticsearch  
        -> Notification Service -> mentions, unread counters, APNs/FCM  
        -> Hot-channel cache -> Redis recent messages  
  
**Read History Flow:**  
Client -> Message Service  
    -> Redis recent messages (hit for active channels)  
    -> Cassandra (channel_id, bucket) stepping back through buckets  
    -> Return 50 messages sorted by Snowflake ID  
  
**Typing Flow:**  
Client -> Gateway (throttled to 1 event per ~5s)  
    -> Redis Pub/Sub on channel topic  
    -> Subscribed Gateways -> clients (auto-hide after ~8s)  
  
**Presence Flow:**  
Heartbeat -> Gateway -> Redis SET presence:{user_id} TTL 60s  
Status change -> publish once per interested Gateway -> local fan-out  
Large servers: client requests presence for visible members only  
  
**Permission Change Flow:**  
Admin edits role or override -> Permission Service  
    -> Update database  
    -> Bump guild_perm_version  
    -> Kafka (permission.changed) -> old cache keys become unreachable and expire  
  
**Attachment Flow:**  
Client -> Media Service -> presigned S3 URL  
Client -> S3 (direct upload)  
Message stores the URL, CDN serves the file

<<<SECTION 11>>>
## 14. Resilience and Fault Tolerance

- **Stateless Message Service.** Any instance handles any request, and failures are just retries.
- **Gateway failure.** Clients detect the dropped WebSocket and reconnect through the load balancer to a new Gateway. They then fetch missed messages using their last seen message ID, which works because IDs are time-sortable.
- **Kafka durability.** Replicated, partitioned by channel, and consumers resume from offsets after crashes, so search indexing and notifications never lose events.
- **Cassandra replication.** Replication factor 3 across availability zones means node loss does not lose messages.
- **Redis failure.** Presence rebuilds from heartbeats. Permission and message caches fall back to the source of truth. Pub/Sub loss only drops live events, and clients backfill from history.
- **Hot-channel protection.** Sharded pub/sub or relay tiers, lazy delivery, and throttled typing and presence in giant servers.
- **Backpressure.** Per-user and per-channel rate limits at the Message Service stop spam from overwhelming a channel.
- **Graceful degradation.** If search or notifications are down, sending and receiving messages still work.

<<<SECTION 12>>>
## 15. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, REST routing)

**Real-time Transport** -> WebSockets on a stateful Gateway tier (100M concurrent connections, ~200 to 1,000 servers)

**Service Discovery** -> etcd / Consul plus load balancer (Gateway assignment, connection lookup)

**Message Queue** -> Apache Kafka partitioned by channel_id (Ordering, durability, fanout to search, notifications, cache)

**Live Fan-out** -> Redis Pub/Sub with per-Gateway subscriptions (One publish per Gateway, local in-memory fan-out)

**Message Store** -> Cassandra / ScyllaDB with (channel_id, bucket) partition key (Append-only, time-ordered, bounded partitions)

**Message IDs** -> Snowflake (64-bit, time-sortable, no coordination)

**Recent Message Cache** -> Redis (Latest ~50 messages per active channel)

**Presence** -> Redis with heartbeat TTL (Ephemeral, rebuilt from heartbeats)

**Typing Indicators** -> Redis Pub/Sub, client throttled (Never stored, never in Kafka)

**Permissions** -> Bitmask roles and overrides in PostgreSQL, cached in Redis with guild version keys (Sub-millisecond checks, one-write invalidation)

**Guild, User, Role Metadata** -> PostgreSQL (Low write, relational, strongly consistent)

**Search** -> Elasticsearch routed by guild_id (Full text, filters, permission-aware results)

**Media** -> AWS S3 with presigned URLs plus CDN (Attachments never touch the API layer)

**Notifications** -> Kafka consumers plus APNs and FCM (Mentions, unread counters, mute rules)

### That's all folks, Cheers!!
