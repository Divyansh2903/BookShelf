# Design Discord

<<<SECTION 1>>>
## 1. Requirements

**Functional:** servers (guilds) and channels; channel text messaging with history; roles and per-channel permissions; DMs (1:1 and group), presence, typing indicators; notifications; message search.

**Out of scope:** voice/video (WebRTC and media servers, a separate system), bots and webhooks, moderation tooling and audit logs, Go Live streaming.

**Non-functional:**
- Scale from 5-member servers to millions of members
- Delivery to online members within a few hundred ms
- No single point of failure on the message path
- High throughput in busy servers and hot channels
- Strict per-channel ordering, same for every client
- Eventual consistency OK for presence, typing, unread counters
- Strong server-side permission enforcement

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU** 500M; **peak concurrent** ~100M (20%), one WebSocket each
- **Messages/day:** 500M x 10 = ~1B
- **Write QPS:** 1B / 86,400 = ~11.5K/s avg, ~35K/s peak
- **Message size** ~1 KB with metadata (a sentence is 100-200 bytes)
- **Text storage:** ~1 TB/day, ~365 TB/year, ~1.1 PB/year at RF 3
- **Attachments:** 10% carry 1 MB → ~100 TB/day in S3/CDN; messages store only a URL
- **Gateways:** ~100K-500K connections each → ~200-1,000 servers
- **Fan-out:** 500K online members → 500K deliveries per message; at 100 msg/s, 50M/s for one server

Load is skewed: most servers have 10-50 members, a few have hundreds of thousands online. The hard parts are 100M WebSockets and giant-server fan-out, not storage.

<<<SECTION 3>>>
## 3. High Level Services

- **User:** profiles, settings, friends
- **Guild:** servers, channels, categories, invites (low write; merged Server and Channel service)
- **Permission:** roles, channel overrides, cached checks
- **Gateway:** persistent WebSockets; stateful, only moves bytes
- **Message:** stateless send/history, validation, ID assignment, persistence
- **Presence:** ephemeral status and typing
- **Media:** presigned S3 URLs
- **Notification:** push, unread counters, mentions
- **Search:** Elasticsearch

**Gateway vs Message Service.** The Gateway (phone line) holds a live connection per user and carries bytes; stateful, scales with connections (100M). The Message Service (clerk) checks rules, assigns an ID, saves, publishes; stateless, scales with msg/s (35K). Split so each scales independently: a crashed Gateway means reconnects, a crashed Message instance means a retry.

<<<SECTION 4>>>
## 4. API Gateway and Service Discovery

REST (create server, edit profile, fetch history) goes through the API Gateway for auth and rate limiting; real-time uses WebSockets. A load balancer plus registry (etcd or Consul) assigns a healthy Gateway on connect and answers "which Gateway holds user X?". The Gateway authenticates the token; the client heartbeats every ~30s. Media uploads use presigned S3 URLs, never the API Gateway.

## 5. Message Send Path

"hello" in #general → Gateway A (his WebSocket) → Message Service: permission check, assign Snowflake ID, persist to Cassandra, publish to Kafka (partitioned by channel_id) → fan-out to subscribed Gateways → each pushes to local WebSockets.

**Snowflake ID** (64-bit):

| 41 bits: timestamp (ms since custom epoch) | 10 bits: worker ID | 12 bits: sequence |

High-bit timestamp → time-sortable, no timestamp column. Worker ID → uniqueness without coordination. Sequence → 4,096 IDs/ms/worker. Generated locally per instance, no central bottleneck.

**Ordering** is set by the server, since client clocks disagree:
1. Kafka partitioned by channel_id; a partition is a strictly ordered log, so each channel has one order.
2. Snowflake ID stamped by the Message Service; same-ms ties break by worker ID and sequence.

Clients sort by Snowflake ID. No Operational Transformation (unlike Google Docs): messages are independent appends, not concurrent edits. Tradeoff: one partition per channel caps a hot channel's throughput, acceptable since thousands of msg/s is unreadable anyway.

<<<SECTION 5>>>
## 6. Fan-out and the 500K Member Problem

**Per-user queues fail.** Fan-out on write is fine at 100 members; at 500K online it's 500K writes per message, 50M writes/s at 100 msg/s.

**Fan-out per Gateway instead.** 500K online members span ~500 gateways:
1. **Subscription map:** each Gateway tracks in memory which local users view which channel.
2. **Subscribe** to the channel topic (Redis Pub/Sub or Kafka consumer) when the first local user opens it; unsubscribe when the last leaves.
3. **One publish** per message to channel:42; every subscribed Gateway gets it.
4. **Local fan-out:** in-memory loop (microseconds) writing to each local WebSocket.

E.g. Gateway 1 (800 local members) → 800 writes, Gateway 2 (950) → 950 writes, ... ~500 gateways. 500K deliveries become ~500 publishes, a 1000x reduction.

**Remaining limits:**
- **Hot channel:** one Kafka partition and one pub/sub channel; huge servers shard pub/sub or add a relay tier (tree of relays to gateways).
- **Per-Gateway writes:** 100 msg/s x 1,000 local users = 100K writes/s, the practical ceiling.
- **Lazy delivery:** users not viewing the channel get only an unread/mention counter; full messages only to viewers.

<<<SECTION 6>>>
## 7. Message Storage

**Cassandra (ScyllaDB):** append-only messages read by channel in time order suit a horizontally scaling wide-column store, RF 3.

Naive key: channel_id

```
channel_id    BIGINT, partition key
message_id    BIGINT (Snowflake), clustering key DESC
```

Problems: unbounded partitions (50M messages → multi-GB), hot partitions, slow compaction, GC pauses, painful repair, slow deep-history scrolling.

**Fix: time bucketing.** Messages (Cassandra):

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

Bucket derives from the Snowflake timestamp (no lookup); partitions stay bounded.
- **Write:** bucket from new ID → (channel_id, bucket).
- **Read:** newest 50 from current bucket, stepping back until 50 found; a cached per-channel "last message" pointer skips empty buckets on quiet channels.
- **Hot-channel cache:** latest ~50 per active channel in Redis.
- **Soft deletes:** tombstones hurt busy-partition reads, so use a deleted flag; compaction or TTL cleans up.
- **Attachments:** S3 behind CDN; row stores the URL.

<<<SECTION 7>>>
## 8. Presence and Typing Indicators

### Presence: heartbeat plus TTL

```
Key: presence:{user_id}
Value: { status: "online" | "idle" | "dnd", last_seen, gateway_id }
TTL: 60 seconds
```

Heartbeat every ~30s refreshes the TTL; app close or network drop lets the key expire (offline). Idle after 5 minutes without input.

**Who is notified?** A user in 20 servers of 100K members → 2M notifications per flip. Fixes:
1. Notify only friends and members whose member list for a shared server is open.
2. **Lazy presence** above a threshold (say 100K): client fetches presence for the ~50 visible sidebar members, refreshing on scroll.
3. **Debounce** offline broadcasts a few seconds to avoid flapping.
4. **Gateway-level fan-out:** one change per interested Gateway.

### Typing indicators: ephemeral

- Event on start, then at most every ~5s while typing.
- Published to the channel topic; subscribed Gateways show "User is typing..." to viewers.
- Receiver hides it after ~8-10s without events; no "stopped typing" event.
- Not stored, not in Kafka; losses are harmless, so fire-and-forget Redis Pub/Sub.
- Throttled hard or disabled in very large channels.

**Durability:** presence isn't durable; after a Redis restart heartbeats rebuild it in about a minute. Only preferences (e.g. invisible mode) live in the User Service DB.

<<<SECTION 8>>>
## 9. Roles and Permissions

**Bitmask model**, one bit per permission:

```
VIEW_CHANNEL    = 1 << 0
SEND_MESSAGES   = 1 << 1
MANAGE_MESSAGES = 1 << 2
MANAGE_CHANNEL  = 1 << 3
ADMINISTRATOR   = 1 << 4
```

A check is one bitwise AND: (permissions & SEND_MESSAGES) != 0. No joins or scans.

Roles:

```
role_id        BIGINT, primary key
guild_id       BIGINT
name           VARCHAR
permissions    BIGINT (bitmask)
position       INTEGER (hierarchy)
```

MemberRoles:

```
guild_id, user_id, role_id  
```

ChannelOverrides:

```
channel_id     BIGINT 
target_id      BIGINT (role_id or user_id) 
target_type    ENUM('role', 'user') 
allow          BIGINT (bits explicitly granted) 
deny           BIGINT (bits explicitly denied)
```

**Effective permission** (general to specific; most specific wins):
1. base = OR of all the user's roles
2. ADMINISTRATOR → allow all, stop
3. Channel @everyone override: base = (base & ~deny) | allow
4. User's role overrides (OR denies and allows, then apply)
5. User-specific override
6. Result = effective bitmask for this user in this channel

**35K checks/s:** cache key perm:{guild_id}:{channel_id}:{user_id}:v{guild_perm_version} → 8-byte bitmask, TTL 10 min. Hot path is one Redis GET plus AND (sub-ms); an in-process L1 cache in the Message Service avoids most network calls; misses load, compute, store.

**Invalidation:** edits publish permission.changed to Kafka. Rather than deleting 500K keys, bump guild_perm_version: old keys become unreachable in one write and expire via TTL.

**Security:** checks run server side in the Message Service, never trusted from clients. VIEW_CHANNEL is checked before delivering any event.

<<<SECTION 9>>>
## 10. Notifications

Kafka fanout from Message to Notification Service, APNs/FCM as in earlier designs.
- **Mentions** (@user, @role, @everyone) push to users offline or not viewing.
- **Unread counters** per user per channel in Redis, sent as lightweight events.
- **Mute settings** per server/channel checked first.
- **@everyone in huge servers** rate limited and batched to avoid a storm.
- Online users get WebSocket events; push only to offline devices.

## 11. Search

Elasticsearch indexes messages per server or DM.

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

- Async: a Kafka consumer indexes; few-second lag is acceptable.
- Routed by guild_id, touching one server's shard.
- from:user, in:channel, has:file, before:date → ES filter clauses.
- **Security filter:** only channels with VIEW_CHANNEL.

## 12. Direct Messages

A DM is a channel with two (or a few) participants: same channel_id, Cassandra table, Snowflake IDs, Kafka partitioning. Fan-out is trivial. Permissions: friends or shared server, and neither blocking the other.

<<<SECTION 10>>>
## 13. Full Data Flow Summary

- **Connect:** Client → LB + registry → Gateway → auth token → register user_id → gateway_id → heartbeat ~30s refreshes Redis presence TTL.
- **Send:** Client → Gateway → Message Service → permission check (Redis, L1, bitmask AND) → Snowflake ID → Cassandra (channel_id, bucket) → Kafka (by channel_id) → one publish to channel pub/sub → Gateways fan out locally. Kafka consumers: search indexer → Elasticsearch; Notification Service → mentions, unread counters, APNs/FCM; hot-channel cache → Redis.
- **Read history:** Message Service → Redis recent (active channels) → Cassandra stepping back through buckets → 50 messages sorted by Snowflake ID.
- **Typing:** Gateway (1 event per ~5s) → Redis Pub/Sub → subscribed Gateways → clients (auto-hide ~8s).
- **Presence:** heartbeat → Redis SET presence:{user_id} TTL 60s; changes published once per interested Gateway; large servers fetch visible members only.
- **Permission change:** Permission Service → update DB → bump guild_perm_version → Kafka permission.changed → old keys expire.
- **Attachment:** Media Service → presigned URL → direct S3 upload → message stores URL, CDN serves.

<<<SECTION 11>>>
## 14. Resilience and Fault Tolerance

- **Stateless Message Service:** any instance serves any request; failures are retries.
- **Gateway failure:** clients reconnect via LB to a new Gateway and fetch missed messages by last seen ID (time-sortable).
- **Kafka:** replicated, partitioned by channel; consumers resume from offsets, so search and notifications lose nothing.
- **Cassandra:** RF 3 across AZs.
- **Redis failure:** presence rebuilds from heartbeats; caches fall back to source of truth; Pub/Sub loss drops only live events, backfilled from history.
- **Hot channels:** sharded pub/sub or relays, lazy delivery, throttled typing/presence.
- **Backpressure:** per-user and per-channel rate limits stop spam.
- **Graceful degradation:** messaging works if search or notifications are down.

<<<SECTION 12>>>
## 15. Technology Choices Summary

- **API Gateway:** Kong / AWS API Gateway (auth, rate limiting, REST)
- **Real-time:** WebSockets on stateful Gateways (100M connections, ~200-1,000 servers)
- **Discovery:** etcd / Consul + LB
- **Queue:** Kafka by channel_id (ordering, durability, fanout to search, notifications, cache)
- **Live fan-out:** Redis Pub/Sub, per-Gateway subscriptions
- **Message store:** Cassandra / ScyllaDB, (channel_id, bucket) key (append-only, bounded partitions)
- **IDs:** Snowflake (64-bit, time-sortable, no coordination)
- **Recent cache:** Redis, ~50 per active channel
- **Presence:** Redis heartbeat TTL (ephemeral)
- **Typing:** Redis Pub/Sub, client throttled (never stored or in Kafka)
- **Permissions:** bitmasks in PostgreSQL, Redis cache with guild version keys (sub-ms checks, one-write invalidation)
- **Guild/User/Role metadata:** PostgreSQL (low write, relational, strongly consistent)
- **Search:** Elasticsearch by guild_id (full text, filters, permission-aware)
- **Media:** S3 presigned URLs + CDN (never touches API layer)
- **Notifications:** Kafka consumers + APNs/FCM (mentions, unread counters, mute rules)
