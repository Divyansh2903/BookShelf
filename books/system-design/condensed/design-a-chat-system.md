# Design A Chat System

<<<SECTION 1>>>
## Problem statement

A real-time chat system like WhatsApp, WeChat, or Messenger: instant 1:1 and group messaging, delivery receipts, online presence.

## Requirements and scope

**Functional:**
- One-on-one and group messaging (up to 1024 members per group)
- Real-time delivery
- Receipts: sent (one tick), delivered (two ticks), read (blue ticks)
- Online presence and last seen
- Media (images, video at a high level)
- Message search

**Non-functional:**
- 10M DAU
- Highly available, low latency
- Eventual consistency acceptable for receipts
- Messages must never be lost

**Out of scope:** end-to-end encryption, calls, stories.

## Capacity estimation

- DAU: 10M; 50 messages per user per day → 500M messages/day
- ~5,000 msg/sec; avg text message ~100 bytes → ~500 KB/sec writes
- ~10,000 effective ops/sec (store + deliver)
- ~2M concurrent WebSocket connections (20% of DAU active)
- ~40 chat server instances (at 50K connections each)

### Protocol choice: WebSockets

HTTP is request-response; chat needs server push.
- **Short polling:** at 10M users polling every 5s, 2M requests/second just for polling. Unacceptable.
- **Long polling:** connection held until a message arrives. Better, but half-duplex and expensive at scale.
- **WebSockets:** full-duplex, persistent, bi-directional; server pushes instantly. Used by WhatsApp, Messenger, Slack.

~50,000 connections per server; ~2M users → ~40 instances behind the load balancer.

<<<SECTION 2>>>
## Core design: store-and-forward

Always persist to Cassandra before attempting delivery (write first, deliver second, never skip optimistically), so a message survives if the recipient's device dies mid-delivery.

**Write path (sender online)**
1. Sender sends over WebSocket to **Chat Server A**
2. Server A generates a **Snowflake ID** (time-sortable, distributed)
3. Server A publishes the message to **Kafka**
4. Server A returns a one-tick ack ("we have it")
5. **Delivery workers** consume from Kafka and write durably to **Cassandra**
6. Worker checks recipient status in the **Presence store (Redis)**

**Recipient online:**
- Worker uses Redis Pub/Sub to find the recipient's chat server and publishes a delivery event to that channel
- **Chat Server B** pushes the message over WebSocket
- Recipient device ACKs over WebSocket
- Server A notifies the sender; two ticks appear

**Recipient offline:**
- Message is already in Cassandra
- Worker triggers the **Notification service** to send a push notification
- On reconnect, the client pulls missed messages from Cassandra
- ACK flows back over WebSocket; two ticks update

**Read receipts (blue ticks):** triggered when the recipient opens the conversation. Client sends a read event over WebSocket, the chat server updates status in Cassandra, the sender is notified and blue ticks appear.

## Cross-server message routing

Sender and recipient are rarely on the same of 40 servers. Each server subscribes to **Redis Pub/Sub** channels for its users; a worker publishes to the recipient's channel and Server B delivers.

## Online presence

Clients send a heartbeat every 5 seconds. The server sets Redis key presence:{userId} to the current timestamp with a 15-second TTL. After 3 missed heartbeats the TTL expires and the user is offline automatically, no logout needed. "Last seen" is the last heartbeat timestamp.

<<<SECTION 3>>>
## Database choices

- **Cassandra (message store)** - partitioned by conversationId, sorted by timestamp, range reads O(1). Best-in-class write throughput. Used by Facebook Messenger.
- **Redis KV (presence)** - sub-millisecond reads, TTL expiry for automatic offline detection
- **Redis Pub/Sub (cross-server routing)** - lightweight, fast, already in the stack
- **Elasticsearch (search)** - full-text search; CDC pipeline syncs from Cassandra asynchronously

**Why Cassandra:** the core access pattern is "fetch all messages in conversation X, ordered by timestamp, from offset Y." Partitioning by conversationId keeps a chat's messages on one node; rows sorted by timestamp within a partition make range reads very fast. It handles ~5,000 writes/second comfortably.

## Group chat

For groups up to 1024 members, fan-out happens in the delivery worker when a group message arrives in a Kafka partition:
1. Fetch the member list from a **Group service** (SQL DB)
2. Check each member's presence in Redis
3. Online members: deliver via Redis Pub/Sub to WebSocket
4. Offline members: push notification
5. Write the message once to Cassandra under the group conversationId, not per member

Beyond the 1024 cap, fan-out becomes a thundering herd problem; a hybrid (fan-out on read for very large groups) would be needed.

<<<SECTION 4>>>
## Media handling

Text goes WebSocket -> Kafka -> Cassandra. Media is separate to keep that pipeline lean:
- Client uploads directly to **S3** via a pre-signed URL
- S3 stores the asset and triggers replication to **CloudFront (CDN)**
- The chat message carries only the media URL and metadata, not the binary
- Recipients fetch from CloudFront, not through chat servers

This keeps large payloads off WebSocket servers; CDN edges serve media globally.

## Message search

A CDC (change-data-capture) pipeline tails Cassandra writes and syncs to **Elasticsearch** asynchronously. A dedicated Search service, decoupled from delivery, keeps full-text load off Cassandra, which isn't built for it.

## Auth and rate limiting

Auth happens at the **load balancer / API gateway** with JWT. The WebSocket upgrade handshake carries the token in the query string or header; the gateway validates it before the connection is established. Per-user rate limiting on sends prevents abuse and protects Kafka from ingest spikes.

<<<SECTION 5>>>
## Bottlenecks and trade-offs

**Delivery latency vs durability:** persisting to Cassandra first adds slight latency; a slower delivery beats a lost message.

**Cross-server routing:** Redis Pub/Sub adds a hop; fine at 40 servers, but a larger fleet warrants a service mesh or consistent hashing (deterministic user-to-server routing).

**Group fan-out ceiling:** the 1024 cap is an architectural constraint; beyond it per-member fan-out is expensive. Very large broadcasts would benefit from a pub/sub tree rather than flat fan-out.

**Presence accuracy:** a disconnected user may appear online for up to ~15 seconds; accepted in every major chat system.
