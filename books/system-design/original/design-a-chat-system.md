# Design A Chat System

<<<SECTION 1>>>
## Problem statement

Design a real-time chat system like WhatsApp, WeChat, or Messenger. Users should be able to send and receive messages instantly, individually or in groups, with delivery receipts and online presence indicators.

## Requirements and scope

### Functional requirements:

- One-on-one and group messaging (up to 1024 members per group)
- Real-time message delivery
- Delivery receipts: sent (one tick), delivered (two ticks), read (blue ticks)
- Online presence and last seen
- Media support (images, video at a high level)
- Message search

### Non-functional requirements:

- 10M DAU
- Highly available and low latency
- Eventual consistency acceptable for delivery receipts
- Messages must never be lost

**Out of scope:** End-to-end encryption, calls, stories.

## Capacity estimation

DAU - 10M  
Messages per user per day - 50  
Total messages per day - 500M  
Messages per second~5,000 msg/sec  
Avg message size (text)~100 bytes  
Write throughput~500 KB/sec  
Effective operations/sec~10,000 (store + deliver)  
Concurrent WebSocket connections~2M (20% DAU active)  
Chat server instances needed~40 (at 50K connections each)

### Protocol choice: WebSockets

HTTP is request-response. The client asks, the server answers. Chat requires the server to push messages to the client the moment they arrive. The options:

- **Short polling:** Client asks every N seconds. At 10M users polling every 5 seconds that is 2M requests/second just for polling. Unacceptable.
- **Long polling:** Client holds connection until a message arrives. Better but still half-duplex, expensive at scale.
- **WebSockets:** Full-duplex, persistent, bi-directional. Server pushes instantly. This is what WhatsApp, Messenger, and Slack all use.

Each chat server maintains ~50,000 concurrent WebSocket connections. With ~2M concurrent users, roughly 40 chat server instances sit behind the load balancer.

<<<SECTION 2>>>
## Core design: store-and-forward

A message is always persisted to Cassandra before delivery is attempted. This is non-negotiable. If the recipient's device dies mid-delivery, the message must survive. The flow is always: write first, deliver second. Never skip persistence optimistically.

Write path (sender online)

1. Sender sends a message over their WebSocket connection to **Chat Server A**
1. Chat Server A generates a unique **Snowflake ID** (time-sortable, distributed) for the message
1. Chat Server A publishes the message to **Kafka**
1. Chat Server A immediately returns a one-tick acknowledgement to the sender, meaning "we have it"
1. **Delivery workers** consume from Kafka and write the message durably to **Cassandra**
1. Check recipient's online status in the **Presence store (Redis)**

### If recipient is online:

- Worker checks Redis Pub/Sub to find which chat server the recipient is connected to
- Publishes delivery event to that channel
- **Chat Server B** pushes the message to the recipient over WebSocket
- Recipient device sends an ACK back through WebSocket
- Chat Server A notifies the sender and two ticks appear

### If recipient is offline:

- Message is already safely in Cassandra
- Worker triggers the **Notification service** to send a push notification to the recipient's device
- When recipient comes back online, their client pulls missed messages from Cassandra
- ACK flows back through WebSocket, two ticks update

### Read receipts (blue ticks):

- Triggered when the recipient opens the specific conversation
- Client sends a read event over WebSocket
- Chat Server updates the message status in Cassandra
- Sender gets notified and blue ticks appear

## Cross-server message routing

With 40 chat server instances, the sender and recipient are rarely connected to the same server. Chat servers use **Redis Pub/Sub** to solve this. Each server subscribes to channels for its connected users. When a delivery worker needs to push to a recipient on Server B, it publishes to that user's Redis channel, and Server B picks it up and delivers over WebSocket.

## Online presence

Each client sends a heartbeat ping to its chat server every 5 seconds. The server updates a Redis key presence:{userId} with the current timestamp and a TTL of 15 seconds. If 3 consecutive heartbeats are missed, the TTL expires and the user is marked offline automatically, no explicit logout is needed. "Last seen" is the timestamp of the last heartbeat recorded.

<<<SECTION 3>>>
## Database choices

**Cassandra (Message store)** - Partitioned by conversationId, sorted by timestamp, range reads are O(1). Best-in-class write throughput. Used by Facebook Messenger.

**Redis (KV) (Presence store)** - Sub-millisecond reads, TTL-based expiry for automatic offline detection

**Redis Pub/Sub (Cross-server routing)** - Lightweight, fast, already in the stack

**Elasticsearch (Message search)** - Full-text search across messages, CDC pipeline syncs from Cassandra asynchronously

**Why Cassandra for messages specifically:** The core access pattern is "fetch all messages in conversation X, ordered by timestamp, starting from offset Y." Cassandra partitions data by conversationId, and all messages of a chat live on the same node. Within a partition, rows are sorted by timestamp, making range reads extremely fast. It also handles the ~5,000 writes/second comfortably.

## Group chat

For groups up to 1024 members, fan-out happens at the delivery worker level. When a message arrives in a Kafka partition for a group conversation:

1. Worker fetches the full member list from a **Group service** (backed by a SQL DB)
1. For each member, worker checks their presence status in Redis
1. Online members get delivery via Redis Pub/Sub to WebSocket
1. Offline members get a push notification
1. The message is written once to Cassandra under the group conversationId, not duplicated per member

This approach works well up to the 1024 member cap. Beyond that, fan-out becomes a thundering herd problem and a hybrid approach (fan-out on read for very large groups) would be needed.

<<<SECTION 4>>>
## Media handling

Text messages flow through the WebSocket -> Kafka -> Cassandra pipeline. Media (images, video) is handled separately to keep the message pipeline lean:

- Client uploads the media file directly to **S3** via a pre-signed URL
- S3 stores the raw asset and triggers replication to **CloudFront (CDN)**
- The chat message contains only the media URL and metadata, not the binary
- Recipients fetch media directly from CloudFront, not through the chat servers

This keeps the WebSocket servers free of large payloads and lets CDN edge nodes serve media at scale globally.

## Message search

A CDC (change-data-capture) pipeline tails Cassandra writes and syncs new messages to **Elasticsearch** asynchronously. Users searching for messages hit a dedicated Search service backed by Elasticsearch, completely decoupled from the real-time delivery path. This avoids putting full-text search load on Cassandra, which is not designed for it.

## Auth and rate limiting

Authentication is handled at the **load balancer / API gateway** layer using JWT tokens. The WebSocket upgrade handshake includes a token in the query string or header, the gateway validates it before the connection is established. Rate limiting on message sends is enforced per user to prevent abuse and protect Kafka from ingest spikes.

<<<SECTION 5>>>
## Bottlenecks and trade-offs

**Delivery latency vs durability:** Persisting to Cassandra before delivery adds a small latency. This is the right trade-off: a slightly slower delivery is always better than a lost message.

**Cross-server routing complexity:** Redis Pub/Sub adds a hop for cross-server delivery. At 40 servers this is manageable, but as the fleet grows, a more sophisticated service mesh or consistent hashing scheme (routing users to a deterministic server) becomes worthwhile.

**Group fan-out ceiling:** The 1024 member cap is an architectural constraint. Beyond it, per-member delivery worker fan-out becomes expensive. Very large group broadcasts would benefit from a pub/sub tree model rather than a flat fan-out.

**Presence accuracy:** Heartbeat-based presence has a ~15-second inaccuracy window. A user who loses connectivity appears online for up to 15 seconds. This is a known and accepted trade-off in every major chat system.

That's all, folks..Cheers!!!
