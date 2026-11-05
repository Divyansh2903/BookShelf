# Design Google Docs

<<<SECTION 1>>>
## 1. Requirements

**Functional:**
- Create, read, update, delete documents
- Real-time collaborative editing by multiple users
- Cursor presence (others' typing positions with avatars)
- Rich text (bold, italic, headings, lists, code blocks)
- Sharing and permissions (view only, comment, edit, public link)
- Comment threads on text selections
- Version history (view and restore)
- Offline editing with automatic sync on reconnect

**Out of scope:** Google Sheets, Slides, Drive (file system), export to PDF/Word, AI writing suggestions, voice typing.

**Non-functional:**
- Strong consistency for document state: all users see the same content
- Operation delivery under 100ms within a region
- No data loss for offline edits; locally queued ops survive reconnection
- Conflict-free convergence: concurrent edits always yield the same final state
- Horizontally scalable collaboration layer; up to 100 concurrent editors on one document
- Eventual consistency acceptable for version history reconstruction and search indexing

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 50 million
- **Document size:** 1-5 MB incl. formatting metadata and embedded images
- **Documents created/day:** 10 million
- **Concurrent editors per doc:** avg 2-5; design for 100 (class/team docs)
- **Ops per session:** 100 keystrokes/min x 30 min = 3000
- **Ops per day:** 50M x 3000 = 150 billion
- **Op size:** 50 bytes
- **Raw op log:** 150B x 50 bytes = 7.5 TB/day before retention
- **With snapshots** (every 30 min, ops retained 24 hours): 250 GB/day active op log
- **Snapshot storage:** 10M docs x 1 snapshot per 30 min x 16 active hours, manageable in MongoDB

The challenge is correctness under concurrency, not storage: converging all users to the same state despite network delays, concurrent edits, and offline editing is the hardest distributed systems problem in this series.

<<<SECTION 3>>>
## 3. API Gateway

Handles authentication, rate limiting, and routing for REST requests (document CRUD, sharing, version history). Real-time collaboration bypasses REST: after initial authentication, clients connect directly to the Collaboration Service via WebSocket.

The Gateway checks permissions on document open, before the WebSocket is set up. During the session, permissions are checked via Redis on every operation, keeping the collaboration hot path off the Gateway.

## 4. Operational Transformation

**Operational Transformation (OT)** is the conflict resolution algorithm at the core of Google Docs' real-time collaboration.

### The Core Problem

Simultaneous edits can conflict and leave users with different states. Document "Hello":
- User A: INSERT(2, "X") -> intends "HeXllo"
- User B: INSERT(2, "Y") -> intends "HeYllo"

Applied naively in different orders, A gets "HeXYllo" and B gets "HeYXllo": divergence.

OT transforms one operation against the other before applying it. Since A inserted at 2, B's insert shifts to INSERT(3, "Y"). Both get "HeXYllo".

**Operation Structure** (one per keystroke):

- op_id UUID
- doc_id UUID
- user_id UUID
- type ENUM('insert', 'delete', 'format')
- position INTEGER
- character VARCHAR (null for delete and format)
- format_type VARCHAR (null for insert and delete)
- client_version INTEGER (document version the client had when generating the op)
- server_version INTEGER (assigned by server after transformation; null until processed)
- created_at TIMESTAMP

**client_version** is the most critical field: it tells the OT worker which version the client saw. The worker transforms the incoming op against all ops between client_version and the current server_version. This is the **revision number approach**.

**Why not timestamps:** unreliable for distributed ordering; two ops on different servers with clock skew can share a millisecond. A monotonically incrementing server_version integer is correct; each processed op increments it by exactly 1.

### OT Algorithm (Simplified)

User B's op has client_version = 5; server is at server_version = 8:
1. Fetch ops with server_version 6 to 8 from the operation log
2. Transform B's op against those 3 ops in order
3. Each transformation adjusts positions for earlier inserts and deletes
4. Apply the result at server_version = 9
5. Broadcast it to all other connected users

All clients converge regardless of the order ops arrived.

<<<SECTION 4>>>
## 5. User and Auth Service

Manages identity, authentication, and sessions.

### Users Table (PostgreSQL)

- user_id UUID, PK
- email VARCHAR, unique
- display_name VARCHAR
- profile_pic_url TEXT
- created_at, last_active TIMESTAMP

Sessions use JWTs with short expiry (1 hour) plus refresh tokens. The Collaboration Service validates the JWT when the WebSocket connects; later messages aren't re-validated, since the connection is the authenticated session.

## 6. Document Service

Manages document metadata, creation, deletion, and sharing permissions via REST, separate from real-time collaboration.

**Storage architecture:** documents are far more complex than Medium articles: nested rich text blocks, inline comments, suggestion-mode edits, formatting spans. Content is stored as structured JSON in **MongoDB**. **PostgreSQL** stores metadata. **S3** stores embedded images.

### Documents Table (PostgreSQL)

- doc_id UUID, PK
- owner_id UUID, FK -> Users
- title VARCHAR
- current_version INTEGER (monotonically incrementing server version)
- content_mongo_id TEXT (MongoDB ID for current content)
- is_deleted BOOLEAN
- created_at, updated_at TIMESTAMP
- last_edited_by UUID, FK -> Users

### DocumentPermissions Table (PostgreSQL)

- doc_id UUID, FK -> Documents
- user_id UUID, FK -> Users (null for link-based sharing)
- permission ENUM('owner', 'editor', 'commenter', 'viewer')
- share_type ENUM('specific_user', 'link_anyone')
- created_at TIMESTAMP
- PRIMARY KEY (doc_id, user_id)

**Permission caching in Redis.** Checking the DB on every WebSocket op would mean 1000 DB hits/s per document (100 editors x 10 ops/s). Instead:
- Key: doc:permissions:{doc_id}:{user_id}
- Value: ENUM('owner', 'editor', 'commenter', 'viewer')
- TTL: 30 minutes

On open, the permission is read from PostgreSQL and cached; every later op checks Redis only (sub-millisecond, no DB).

**Permission invalidation.** If the owner revokes access mid-session, a `permission.revoked` event goes to Kafka. The Collaboration Service consumes it and closes the user's WebSocket immediately; the Redis entry is invalidated at the same time. Access is lost within seconds.

**Document Content in MongoDB**

```json
{
  "doc_id": "uuid",
  "version": 1847,
  "blocks": [
    { "id": "b1", "type": "heading", "level": 1, "text": "Project Proposal" },
    { "id": "b2", "type": "paragraph", "text": "This document outlines...",
      "formats": [{ "start": 5, "end": 13, "type": "bold" }] },
    { "id": "b3", "type": "image", "url": "https://storage.googleapis.com/...",
      "caption": "Architecture diagram" },
    { "id": "b4", "type": "paragraph", "text": "The system consists of..." }
  ],
  "updated_at": "2026-08-11T10:00:00Z"
}
```

Each block's ID never changes as content shifts, so partial updates rewrite only modified blocks.

**Bottlenecks:** metadata reads (title, permission checks on every open) are cached in Redis. MongoDB serves initial content loads and snapshot saves. The Document Service isn't on the hot path during editing; the Collaboration Service is.

<<<SECTION 5>>>
## 7. Collaboration Service

The most complex service: WebSocket connections, OT processing, broadcasting, cursor presence, and the snapshot + operation log architecture.

**WebSocket connection management** when a user opens a document:
1. Client authenticates via API Gateway (REST), gets a session token
2. Client opens WebSocket: WSS /docs/{doc_id}/collaborate
3. Service validates the token and checks permission in Redis
4. Client joins the document's **collaboration room**

A room groups all WebSocket connections for a document; 50 concurrent editors means 50 connections in one room.

### Multi-Server WebSocket Problem

Connections are stateful. If A is on Server 1 and B on Server 3, Server 1 must get A's transformed op to B, but servers share no memory. Solution: Redis Pub/Sub (as in chat services and LeetCode's verdict delivery).

Channel: doc:{doc_id}:operations

Each server subscribes to the channel of every active document it hosts. A transformed op published there reaches every subscribed server, which pushes it to its connected users for that document.

**Full Operation Flow: User A Presses "X"**

**Step 1 - Operation generated:**

```json
{
  "op_id": "uuid",
  "doc_id": "doc_123",
  "type": "insert",
  "position": 47,
  "character": "X",
  "client_version": 1523
}
```

**Step 2 - Sent** to Collaboration Server 1 over the open WebSocket.

**Step 3 - Permission check** of doc:permissions:{doc_id}:{user_id} in Redis; rejected unless editor or owner.

**Step 4 - Published to Kafka** topic `doc.operations` for durability; not lost even if the service crashes now.

**Step 5 - OT Worker** consumes it, fetches all ops with server_version > client_version from the Cassandra Operation Log, and transforms against each in order.

**Step 6 - Server version assigned** atomically via Redis counter: `INCR doc:version:{doc_id}`. Atomic and monotonic, so no two ops share a server_version.

**Step 7 - Persisted:** written asynchronously to the Cassandra Operation Log; Redis snapshot updated:
- Key: doc:snapshot:{doc_id}
- Value: { content: current_state, server_version: 1524 }

**Step 8 - Broadcast:** OT Worker publishes to doc:{doc_id}:operations; subscribed servers push it to connected users via WebSocket.

**Step 9 - Client acknowledgement:** client receives the op with server_version: 1524, updates its client_version, and applies it locally. User B sees "X" within milliseconds.

**Cursor Presence** is pure broadcast, no conflict resolution. When A moves the cursor:
1. Client sends { user_id, doc_id, position, color }
2. Service publishes to Redis Pub/Sub doc:{doc_id}:cursors
3. Other users render A's cursor avatar at that position

Cursors aren't persisted; they live only in Redis Pub/Sub and client memory and vanish on disconnect.
- Key: doc:cursors:{doc_id}
- Value: Hash { user_id: { position, color, display_name, last_seen } }
- TTL: refreshed on each update, expires 5 seconds after the last

### Initial Document State for Joining Users

When a user opens a document 5 people are editing:
1. Fetch snapshot from Redis: doc:snapshot:{doc_id}
2. Simultaneously subscribe to doc:{doc_id}:operations
3. Serve the snapshot (content + server_version)
4. Buffer ops arriving between snapshot fetch and subscription
5. Client applies buffered ops in server_version order on the snapshot
6. Client is fully synchronized, no gaps

Version numbers let the client detect and fill any gap.

**Bottlenecks:** the OT Worker. Transforming an offline user's 300 queued ops against 300 server ops is 300 x 300 = 90,000 transformations worst case. Mitigated by scaling OT Workers horizontally via Kafka consumer groups. Ops are partitioned by doc_id in Kafka, so one document's ops go to the same OT Worker, preserving order.

<<<SECTION 6>>>
## 8. Operation Log Service

Manages the append-only log of all operations and periodic snapshots.

**Why Cassandra for the operation log:**
- Very high write throughput (150 billion ops/day)
- Append-only writes fit its LSM tree storage
- Time-ordered retrieval by server_version is efficient with clustering keys
- Horizontal scaling without complex sharding

### Operations Table (Cassandra)

- doc_id UUID, partition key
- server_version INTEGER, clustering key (ascending)
- op_id UUID
- user_id UUID
- type TEXT
- position INTEGER
- character TEXT
- client_version INTEGER
- created_at TIMESTAMP

Partitioning by doc_id keeps a document's ops on the same node, so version range queries are very fast:

SELECT \* FROM Operations WHERE doc_id = 'doc_123' AND server_version > 1500 ORDER BY server_version ASC

### Snapshot Strategy

A background Snapshot Worker takes a full snapshot every 30 minutes of active editing or every 1000 ops, whichever comes first, and when the last editor closes the document.

**Snapshot flow:**
1. Read current state from Redis: doc:snapshot:{doc_id}
2. Write full content to the MongoDB Snapshots collection
3. Record metadata in PostgreSQL

### Snapshots Table (PostgreSQL)

- snapshot_id UUID, PK
- doc_id UUID, FK -> Documents
- mongo_content_id TEXT (MongoDB document ID)
- server_version INTEGER
- created_at TIMESTAMP

### Operation Retention Policy

Raw ops are kept 30 days in Cassandra; after that only snapshots remain. This cuts storage from 7.5 TB/day raw to a manageable long-term footprint. History older than 30 days is reconstructed from snapshots only: lower granularity, sufficient for most uses.

<<<SECTION 7>>>
## 9. Version History Service

Lets users view and restore previous versions. Point-in-time reconstruction:

### Step 1 - Find nearest snapshot before target time

SELECT \* FROM Snapshots WHERE doc_id = X AND created_at <= target_timestamp ORDER BY created_at DESC LIMIT 1

### Step 2 - Fetch operations between snapshot and target time

SELECT \* FROM Operations WHERE doc_id = X AND server_version > snapshot.server_version AND created_at <= target_timestamp ORDER BY server_version ASC

**Step 3 - Replay operations on snapshot** in server_version order up to the target timestamp, giving the exact document state at that time.

### Step 4 - Cache reconstructed version

- Key: doc:version:{doc_id}:{timestamp_bucket}
- Value: reconstructed content
- TTL: 1 hour

Repeated requests for the same version skip Cassandra queries and replay.

### Named Versions

Users can name versions ("Before client review", "Final draft"). These store a direct pointer to a snapshot plus a server_version, skipping reconstruction for instant retrieval.

<<<SECTION 8>>>
## 10. Offline Editing and Sync

Offline, the client keeps a local op queue in the browser's **IndexedDB** (persistent local storage in all modern browsers).

### Offline Flow

1. User loses connectivity
2. Client detects it via the WebSocket close event
3. Client keeps accepting input, appending ops to the IndexedDB queue
4. Each offline op is tagged with the client_version at disconnection
5. E.g. 5 minutes offline produces 300 queued ops

**Reconnection Flow**

1. **WebSocket reconnects;** client sends its last known client_version.
2. **Server sends missed ops:** fetches from Cassandra all ops with server_version > client_version (others' edits during the outage).
3. **Client applies missed ops** via OT, transforming them against its local offline queue.
4. **Client sends offline queue:** all 300 ops, each with the original client_version.
5. **OT Worker transforms** each against all server ops since that client_version; same process as real-time, larger batch.
6. **Broadcast:** transformed ops go to all connected users; all clients converge.

Because every op carries client_version, offline sync is mathematically equivalent to real-time sync: the server always knows the client's state when each op was made.

<<<SECTION 9>>>
## 11. Comment Service

Comments anchor to text selections, not positions; if the text is edited, the comment moves with it.

### Comments Table (PostgreSQL)

- comment_id UUID, PK
- doc_id UUID, FK -> Documents
- author_id UUID, FK -> Users
- anchor_start_op UUID (op_id that created the selection start)
- anchor_end_op UUID (op_id that created the selection end)
- content TEXT
- is_resolved BOOLEAN
- created_at TIMESTAMP

Operation IDs never change as surrounding text shifts, so anchors stay correct when text is inserted or deleted before the selection.

### CommentReplies Table (PostgreSQL)

- reply_id UUID, PK
- comment_id UUID, FK -> Comments
- author_id UUID, FK -> Users
- content TEXT
- created_at TIMESTAMP

<<<SECTION 10>>>
## 12. Notification Service

Same architecture as previous systems: Kafka fanout from upstream services; APNs (iOS), FCM (Android), email via SES. Subscribes to:

- `doc.shared` -> "Harry shared a document with you" email + push
- `comment.created` -> notify document owner and mentioned users
- `comment.replied` -> notify parent comment author
- `permission.changed` -> "Your access to this document has changed"
- `doc.access_requested` -> "Someone requested access to your document" to owner

## 13. Search Service

Covers titles and content. Unlike Medium (content search limited to a preview), Google Docs indexes full content, since users often search for phrases inside their documents.

### Document search index in Elasticsearch:

```json
{
  "doc_id": "123",
  "title": "Project Proposal Q3 2026",
  "content_text": "This document outlines the plan for...",
  "owner_id": "456",
  "owner_name": "Harry The Nerd",
  "last_edited_at": "2026-08-11T10:00:00Z",
  "shared_with": ["user_789", "user_101"]
}
```

Results are filtered by `shared_with` so users only see accessible documents; a Kafka consumer updates it when permissions change.

Content syncs to Elasticsearch from MongoDB snapshots via a background indexing worker, on each new snapshot (every 30 minutes of active editing), not per keystroke. Keystroke-level indexing is unnecessary and would overwhelm Elasticsearch.

<<<SECTION 11>>>
## 14. Full Data Flow Summary

**Document open:** Client -> API Gateway (auth) -> Document Service -> metadata from PostgreSQL -> permission from Redis (doc:permissions:{doc_id}:{user_id}) -> snapshot from Redis (doc:snapshot:{doc_id}) -> return content + server_version -> client opens WebSocket to Collaboration Service -> subscribe to doc:{doc_id}:operations -> buffer ops arriving during setup -> apply buffered ops in server_version order.

**Real-time edit:**
1. Keypress -> client op with client_version -> WebSocket -> Collaboration Service -> Redis permission check (sub-millisecond) -> Kafka (`doc.operations`, partitioned by doc_id)
2. OT Worker: fetch ops with server_version > client_version from Cassandra -> transform against each -> assign server_version via Redis INCR doc:version:{doc_id} -> write to Cassandra (async) -> update Redis snapshot -> publish to doc:{doc_id}:operations
3. Subscribed Collaboration Servers receive it -> push to connected users via WebSocket -> clients apply and update client_version

**Cursor presence:** cursor move -> WebSocket -> Collaboration Service -> Redis HSET doc:cursors:{doc_id} user_id {position, color} -> publish doc:{doc_id}:cursors -> users receive and render avatar at new position.

**Offline sync:** disconnect -> ops queued in IndexedDB. Reconnect -> WebSocket re-established -> client sends last client_version -> server fetches missed ops from Cassandra (server_version > client_version) and sends them -> client applies via OT against local queue -> client sends offline queue -> OT Worker transforms against server ops since disconnect -> broadcast via Redis Pub/Sub.

**Snapshot:** every 30 min or 1000 ops -> Snapshot Worker -> read Redis doc:snapshot:{doc_id} -> write MongoDB Snapshots -> record in PostgreSQL Snapshots -> trigger Elasticsearch reindex.

**Version history:** request at target_timestamp -> Version History Service -> PostgreSQL: nearest snapshot before target -> Cassandra: ops between snapshot.server_version and target -> replay on snapshot -> cache in Redis (doc:version:{doc_id}:{timestamp_bucket}) -> return.

**Permission revocation:** owner revokes -> Document Service -> DELETE doc:permissions:{doc_id}:{user_id} from Redis -> publish `permission.revoked` to Kafka -> Collaboration Service closes the user's WebSocket -> access lost within seconds.

<<<SECTION 12>>>
## 15. Resilience and Fault Tolerance

- **OT correctness:** client_version on every op tells the OT worker exactly which ops to transform against, despite network delays or out-of-order delivery.
- **Kafka durability:** no keystroke is lost if the OT Worker or Collaboration Service crashes mid-processing; ops are replayed from Kafka on restart.
- **Redis snapshot for initial state:** joining users never wait on a DB query; served from memory in sub-millisecond time.
- **Cassandra operation log:** durable, ordered, high-throughput; replication factor 3 means no op is lost to node failures.
- **MongoDB snapshots:** durable version history with flexible schema; async writes keep MongoDB slowdowns off real-time editing.
- **IndexedDB offline queue:** no work lost during outages; client_version makes reconnection sync equivalent to real-time sync.
- **Redis Pub/Sub broadcast** decouples Collaboration Servers. A crash affects only that server's users, who reconnect elsewhere within seconds and get missed ops from their last client_version.
- **Permission caching + event-driven invalidation:** sub-millisecond checks on the hot path; revocation propagates within seconds via Kafka.
- **Snapshot + retention policy:** raw ops kept 30 days then evicted; snapshots kept indefinitely for coarser history beyond that.

<<<SECTION 13>>>
## 16. Technology Choices Summary

- **API Gateway:** Kong / AWS API Gateway (auth, rate limiting, REST routing)
- **Document Metadata DB:** PostgreSQL (metadata, permissions, snapshot references, strong consistency)
- **Document Content Store:** MongoDB (rich text JSON blocks, flexible schema, large nested docs)
- **Operation Log:** Apache Cassandra (append-only, high write throughput, partition by doc_id, cluster by server_version)
- **Snapshot Cache:** Redis (current state + server_version, sub-millisecond load for joiners)
- **Version Cache:** Redis, 1-hour TTL (reconstructed point-in-time versions)
- **Real-time Transport:** WebSockets (persistent bidirectional, sub-100ms delivery)
- **Operation Broadcast:** Redis Pub/Sub (cross-server ops and cursors)
- **Conflict Resolution:** OT Workers consuming from Kafka, transforming against the Cassandra op log
- **Version Counter:** Redis INCR (atomic, monotonic server_version per document)
- **Permission Cache:** Redis with TTL + event-driven invalidation (Kafka-based revocation)
- **Cursor Presence:** Redis Hash with TTL (expires 5 s after last update)
- **Offline Queue:** browser IndexedDB (survives tab close and connectivity loss)
- **Search Engine:** Elasticsearch (full content, updated from MongoDB snapshots every 30 min)
- **Image Storage:** AWS S3 (embedded images, CDN-native)
- **CDN:** CloudFront / Akamai (edge caching for images)
- **Decoupling:** Apache Kafka (op durability, permission events, snapshot triggers, notification fanout)
- **Notification Delivery:** APNs + FCM + AWS SES (shares, comment alerts, access requests)
