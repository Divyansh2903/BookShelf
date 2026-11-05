# Design Google Docs

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

- Create, read, update, and delete documents
- Real-time collaborative editing (multiple users editing simultaneously)
- Cursor presence (see where other users are typing with their avatar)
- Rich text formatting (bold, italic, headings, lists, code blocks)
- Document sharing and permissions (view only, comment, edit, public link)
- Comment threads on specific text selections
- Version history (see and restore previous versions of a document)
- Offline editing with automatic sync on reconnect

### Out of Scope

- Google Sheets (spreadsheet logic)
- Google Slides (presentation logic)
- Google Drive (file system management)
- Export to PDF or Word
- AI writing suggestions
- Voice typing

### Non-Functional Requirements

- Strong consistency for document state, all users must see the same document content
- Real-time operation delivery under 100ms for users in the same region
- No data loss for offline edits, operations queued locally must survive reconnection
- Conflict-free convergence, concurrent edits from multiple users must always produce the same final document state
- Horizontal scalability for the collaboration layer, a single popular document can have 100 concurrent editors
- Eventual consistency acceptable for version history reconstruction and search indexing

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 50 million
- **Average document size:** 1 to 5 MB including formatting metadata and embedded images
- **Documents created per day:** 10 million (many users create multiple documents daily)
- **Average concurrent editors per document:** 2 to 5 (design for up to 100 for shared class or team documents)
- **Operations per user per session:** 100 keystrokes per minute x 30 minute session = 3000 operations per session
- **Total operations per day:** 50M DAU x 3000 operations = 150 billion operations per day
- **Operation size:** 50 bytes each
- **Raw operation log per day:** 150B x 50 bytes = 7.5 TB/day (before retention policy)
- **With snapshot strategy (snapshots every 30 mins, operations retained for 24 hours):** 250 GB/day of active operation log
- **Snapshot storage:** 10M documents x 1 snapshot per 30 mins x 16 hours active = manageable in MongoDB

The dominant challenge is not storage but correctness under concurrency. Ensuring all users converge to the same document state despite network delays, concurrent edits, and offline editing is the hardest distributed systems problem in this entire series.

<<<SECTION 3>>>
## 3. API Gateway

All client requests enter through the API Gateway which handles authentication, rate limiting, and routing. The API Gateway handles standard REST requests for document CRUD, sharing, and version history. Real-time collaboration traffic bypasses the REST layer entirely and connects directly to the Collaboration Service via WebSocket after initial authentication.

The API Gateway enforces permission checks on document open requests before a WebSocket connection is established. Once the WebSocket session is active, permissions are checked via Redis cache on every operation rather than via the API Gateway, keeping the collaboration hot path off the Gateway entirely.

## 4. Operational Transformation

Operational Transformation (OT) is the conflict resolution algorithm at the heart of Google Docs. It is the core concept that makes real-time collaborative editing possible.

### The Core Problem

When two users edit the same document simultaneously, their operations can conflict. Without conflict resolution, different users end up with different document states.

Example:

Document: "Hello"

- User A: INSERT(2, "X") -> intends "HeXllo"
- User B: INSERT(2, "Y") -> intends "HeYllo"

If applied naively in different orders, User A gets "HeXYllo" and User B gets "HeYXllo". The document has diverged.

OT solves this by transforming one operation against the other before applying it. Since A inserted at position 2, B's insert is shifted to position 3: INSERT(3, "Y"). Both users end up with "HeXYllo". Consistent.

Operation Structure

Every keystroke generates an operation with the following structure:

Operation {  
  op_id           UUID  
  doc_id          UUID  
  user_id         UUID  
  type            ENUM('insert', 'delete', 'format')  
  position        INTEGER  
  character       VARCHAR (null for delete and format)  
  format_type     VARCHAR (null for insert and delete)  
  client_version  INTEGER (document version the client had when generating this op)  
  server_version  INTEGER (assigned by server after transformation, null until processed)  
  created_at      TIMESTAMP  
}

client_version is the most critical field. It tells the OT worker exactly which version of the document the client was looking at when they generated the operation. The OT worker transforms the incoming operation against all operations that happened between client_version and the current server_version. This is called the revision number approach.

Why Not Timestamps

Timestamps are unreliable for ordering in distributed systems. Two operations can have the same millisecond timestamp across different servers with clock skew. The monotonically incrementing server_version integer is the correct ordering mechanism. Every operation processed by the server increments the version by exactly 1.

### OT Algorithm (Simplified)

When the OT worker receives an operation from User B with client_version = 5 and the server is currently at server_version = 8:

1. Fetch all operations with server_version between 6 and 8 from the operation log
1. Transform User B's operation against each of those 3 operations in order
1. Each transformation adjusts positions to account for earlier inserts and deletes
1. The final transformed operation is applied at server_version = 9
1. The transformed operation is broadcast to all other connected users

All clients converge to the same document state regardless of the order operations were received.

<<<SECTION 4>>>
## 5. User and Auth Service

Manages user identity, authentication, and session management.

Data Model

### Users Table (PostgreSQL)

Users  
user_id           UUID, primary key  
email             VARCHAR, unique  
display_name      VARCHAR  
profile_pic_url   TEXT  
created_at        TIMESTAMP  
last_active       TIMESTAMP

User sessions are managed via JWT tokens with short expiry (1 hour) and refresh tokens. The Collaboration Service validates the JWT on WebSocket connection establishment. Subsequent WebSocket messages do not re-validate the JWT, the connection itself is the authenticated session.

## 6. Document Service

The Document Service manages document metadata, creation, deletion, and sharing permissions. It handles standard REST operations separate from real-time collaboration.

Document Storage Architecture

Google Docs documents are significantly more complex than Medium articles. They contain nested rich text blocks, inline comments, suggestion mode edits, and formatting spans. This content is stored as a structured JSON document in MongoDB.

PostgreSQL stores document metadata. MongoDB stores document content. S3 stores embedded images referenced within documents.

Data Model

### Documents Table (PostgreSQL)

Documents  
doc_id            UUID, primary key  
owner_id          UUID, foreign key -> Users  
title             VARCHAR  
current_version   INTEGER (monotonically incrementing server version)  
content_mongo_id  TEXT (MongoDB document ID for current content)  
is_deleted        BOOLEAN  
created_at        TIMESTAMP  
updated_at        TIMESTAMP  
last_edited_by    UUID, foreign key -> Users

### DocumentPermissions Table (PostgreSQL)

DocumentPermissions  
doc_id        UUID, foreign key -> Documents  
user_id       UUID, foreign key -> Users (null for link-based sharing)  
permission    ENUM('owner', 'editor', 'commenter', 'viewer')  
share_type    ENUM('specific_user', 'link_anyone')  
created_at    TIMESTAMP  
PRIMARY KEY (doc_id, user_id)

**Permission Caching in Redis**  
 Checking permissions on every WebSocket operation from the database would generate 1000 database hits per second per document with 100 concurrent editors each sending 10 operations per second. Instead permissions are cached in Redis:

Key: doc:permissions:{doc_id}:{user_id}  
Value: ENUM('owner', 'editor', 'commenter', 'viewer')  
TTL: 30 minutes

When a user opens a document, their permission is fetched from PostgreSQL and cached in Redis. Every subsequent WebSocket operation checks Redis only, sub-millisecond with no database involvement.

**Permission Invalidation**  
 If a document owner revokes a user's access mid-session, a permission.revoked event is published to Kafka. The Collaboration Service consumes this event and immediately closes the affected user's WebSocket connection. Redis cache is invalidated simultaneously. The revoked user loses access within seconds.

Document Content in MongoDB

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

Each block has a unique ID that never changes even as content shifts. This makes partial document updates efficient since only modified blocks need to be rewritten.

Bottlenecks in the Document Service

Document metadata reads are cached in Redis since title and permission checks happen on every document open. MongoDB handles document content reads for the initial load and snapshot saves. The Document Service itself is not on the hot path during active editing, the Collaboration Service owns that.

<<<SECTION 5>>>
## 7. Collaboration Service

The Collaboration Service is the most unique and complex service in this design. It manages all real-time editing activity: WebSocket connections, OT processing, operation broadcasting, cursor presence, and the snapshot plus operation log architecture.

WebSocket Connection Management

When a user opens a document for editing:

1. Client authenticates via API Gateway (REST) and receives a session token
1. Client establishes a WebSocket connection to the Collaboration Service: WSS /docs/{doc_id}/collaborate
1. Collaboration Service validates the session token and checks permission from Redis
1. Client joins the document's collaboration room

Each document has a collaboration room, a logical grouping of all WebSocket connections for that document. A document with 50 concurrent editors has 50 WebSocket connections all in the same room.

### Multi-Server WebSocket Problem

WebSocket connections are stateful. User A is connected to Collaboration Server 1. User B is connected to Collaboration Server 3. When User A types a character, Collaboration Server 1 must broadcast the transformed operation to User B on Collaboration Server 3. The servers do not share memory.

The solution is Redis Pub/Sub, the same pattern used in chat services and LeetCode's verdict delivery:

Channel: doc:{doc_id}:operations

Every Collaboration Server subscribes to the Redis Pub/Sub channel for every active document on that server. When a transformed operation is ready to broadcast, it is published to the Redis channel. Every Collaboration Server subscribed to that channel receives it and pushes it to all connected users for that document.

Full Operation Flow: User A Presses "X"

**Step 1 - Operation Generated**  
 Client generates operation:

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

**Step 2 - Operation Sent via WebSocket**  
 Operation sent to Collaboration Server 1 via the open WebSocket connection.

**Step 3 - Permission Check**  
 Collaboration Service checks doc:permissions:{doc_id}:{user_id} in Redis. If not editor or owner, reject operation.

**Step 4 - Operation Published to Kafka**  
 Operation published to Kafka topic doc.operations for durability. Even if the Collaboration Service crashes at this point, the operation is not lost.

**Step 5 - OT Worker Picks Up Operation**  
 OT Worker consumes from Kafka. Fetches all operations with server_version > client_version from the Operation Log in Cassandra. Transforms the incoming operation against each of those operations in order.

**Step 6 - Server Version Assigned**  
 Transformed operation is assigned the next server_version atomically using a Redis counter:

INCR doc:version:{doc_id}

This Redis INCR is atomic and monotonically incrementing. No two operations ever get the same server_version.

**Step 7 - Operation Persisted**  
 Transformed operation written to Cassandra Operation Log asynchronously. Document snapshot in Redis updated:

Key: doc:snapshot:{doc_id}  
Value: { content: current_state, server_version: 1524 }

**Step 8 - Operation Broadcast**  
 OT Worker publishes transformed operation to Redis Pub/Sub channel doc:{doc_id}:operations. All Collaboration Servers subscribed to this channel receive it and push it to all connected users for this document via their WebSocket connections.

**Step 9 - Client Acknowledgement**  
 Client receives the transformed operation with server_version: 1524 and updates its local client_version. Client applies the operation to its local document state. User B sees "X" appear in the document within milliseconds.

Cursor Presence

Cursor presence is simpler than OT, it is a pure broadcast problem with no conflict resolution needed.

When User A moves their cursor:

1. Client sends { user_id, doc_id, position, color } to Collaboration Service
1. Collaboration Service publishes to Redis Pub/Sub: doc:{doc_id}:cursors
1. All other users in the document receive the cursor update and render User A's cursor avatar at the correct position

Cursor positions are not persisted. They exist only in Redis Pub/Sub and client memory. If a user disconnects, their cursor disappears immediately.

Key: doc:cursors:{doc_id}  
Value: Hash { user_id: { position, color, display_name, last_seen } }  
TTL: refreshed on each cursor update, expires 5 seconds after last update

### Initial Document State for Joining Users

When a new user opens a document that 5 people are already editing:

1. Collaboration Service fetches document snapshot from Redis: doc:snapshot:{doc_id}
1. Simultaneously subscribes to Redis Pub/Sub channel doc:{doc_id}:operations
1. Serves snapshot to client (content + server_version)
1. Any operations that arrived between snapshot fetch and Pub/Sub subscription are buffered
1. Client applies buffered operations in server_version order on top of snapshot
1. Client is now fully synchronized with no gaps

The version number on every operation guarantees the client can detect and fill any gaps.

Bottlenecks in the Collaboration Service

The OT Worker is the primary bottleneck. Transforming an offline user's 300 queued operations against 300 server operations requires 300 x 300 = 90,000 transformation computations in the worst case. This is mitigated by horizontal scaling of the OT Worker pool via Kafka consumer groups. Each document's operations are partitioned by doc_id in Kafka, ensuring all operations for a single document are processed by the same OT Worker instance maintaining correct ordering.

<<<SECTION 6>>>
## 8. Operation Log Service

The Operation Log Service manages the append-only log of all document operations and the periodic snapshot system.

Operation Storage in Cassandra

Cassandra is chosen for the operation log because:

- Extremely high write throughput (150 billion operations per day)
- Append-only write pattern maps perfectly to Cassandra's LSM tree storage
- Time-ordered retrieval by server_version is efficient with clustering keys
- Horizontal scalability without complex sharding logic

### Operations Table (Cassandra)

Operations  
doc_id          UUID, partition key  
server_version  INTEGER, clustering key (ascending)  
op_id           UUID  
user_id         UUID  
type            TEXT  
position        INTEGER  
character       TEXT  
client_version  INTEGER  
created_at      TIMESTAMP

Partitioning by doc_id means all operations for a document are stored together on the same Cassandra node, making version range queries extremely fast:

SELECT \* FROM Operations  
WHERE doc_id = 'doc_123'  
AND server_version > 1500  
ORDER BY server_version ASC

### Snapshot Strategy

A background Snapshot Worker triggers a full document snapshot:

- Every 30 minutes of active editing
- Every 1000 operations, whichever comes first
- When the last editor closes the document

### Snapshot flow:

1. Snapshot Worker reads current document state from Redis: doc:snapshot:{doc_id}
1. Writes full document content to MongoDB Snapshots collection
1. Records snapshot metadata in PostgreSQL:

### Snapshots Table (PostgreSQL)

Snapshots  
snapshot_id       UUID, primary key  
doc_id            UUID, foreign key -> Documents  
mongo_content_id  TEXT (MongoDB document ID)  
server_version    INTEGER  
created_at        TIMESTAMP

### Operation Retention Policy

Raw operations are retained for 30 days in Cassandra. Beyond 30 days, only snapshots are kept. This dramatically reduces storage from 7.5 TB/day raw to a manageable long-term footprint. Version history older than 30 days is reconstructed from snapshots only, providing lower granularity but sufficient for most use cases.

<<<SECTION 7>>>
## 9. Version History Service

The Version History Service allows users to view and restore previous versions of a document.

Point-in-Time Reconstruction

To reconstruct the document as it was on a specific date and time:

### Step 1 - Find nearest snapshot before target time

SELECT \* FROM Snapshots  
WHERE doc_id = X  
AND created_at <= target_timestamp  
ORDER BY created_at DESC  
LIMIT 1

### Step 2 - Fetch operations between snapshot and target time

SELECT \* FROM Operations  
WHERE doc_id = X  
AND server_version > snapshot.server_version  
AND created_at <= target_timestamp  
ORDER BY server_version ASC

**Step 3 - Replay operations on snapshot**  
 Start with the snapshot content and apply each operation in server_version order until the target timestamp is reached. The result is the exact document state at that point in time.

### Step 4 - Cache reconstructed version

Key: doc:version:{doc_id}:{timestamp_bucket}  
Value: reconstructed document content  
TTL: 1 hour

Frequently viewed version history snapshots are cached in Redis so repeated requests for the same version do not require repeated Cassandra queries and operation replay.

### Named Versions

Users can name specific versions ("Before client review", "Final draft"). Named versions store a direct pointer to a snapshot plus a specific server_version, bypassing the reconstruction step entirely for instant retrieval.

<<<SECTION 8>>>
## 10. Offline Editing and Sync

Google Docs continues to work when the user loses internet connectivity. The client maintains a local operation queue in the browser's IndexedDB (persistent local storage available in all modern browsers).

### Offline Flow

1. User loses connectivity
1. Client detects disconnection via WebSocket close event
1. Client continues accepting user input and appending operations to the local IndexedDB queue
1. Each offline operation is tagged with the client_version at the time of disconnection
1. User types for 5 minutes offline, generating 300 queued operations

Reconnection Flow

**Step 1 - WebSocket Reconnects**  
 Client re-establishes WebSocket connection to Collaboration Service and sends its last known client_version.

**Step 2 - Server Sends Missed Operations**  
 Collaboration Service fetches all operations from Cassandra with server_version > client_version (operations other users made while this user was offline). Sends them to the reconnecting client.

**Step 3 - Client Applies Missed Operations**  
 Client applies the server's missed operations to its local state using OT, transforming them against the local offline queue.

**Step 4 - Client Sends Offline Queue**  
 Client sends all 300 queued offline operations to the server. Each carries the original client_version from the time of disconnection.

**Step 5 - OT Worker Transforms Offline Operations**  
 OT Worker transforms each offline operation against all server operations since the offline client_version. Same transformation process as real-time editing, just with a larger batch.

**Step 6 - Transformed Operations Broadcast**  
 Transformed offline operations are broadcast to all currently connected users. Document converges to the same state on all clients.

The client_version field on every operation makes offline sync mathematically equivalent to real-time sync. The server always knows exactly what state the client was in when each operation was generated.

<<<SECTION 9>>>
## 11. Comment Service

Comments in Google Docs are anchored to specific text selections, not to positions. If the commented text is edited, the comment moves with it.

Data Model

### Comments Table (PostgreSQL)

Comments  
comment_id        UUID, primary key  
doc_id            UUID, foreign key -> Documents  
author_id         UUID, foreign key -> Users  
anchor_start_op   UUID (op_id of the operation that created the start of selection)  
anchor_end_op     UUID (op_id of the operation that created the end of selection)  
content           TEXT  
is_resolved       BOOLEAN  
created_at        TIMESTAMP

Comments are anchored to operation IDs rather than positions. Since operation IDs never change even as text around them shifts, the comment anchor remains correct even when text is inserted or deleted before the commented selection.

### CommentReplies Table (PostgreSQL)

CommentReplies  
reply_id      UUID, primary key  
comment_id    UUID, foreign key -> Comments  
author_id     UUID, foreign key -> Users  
content       TEXT  
created_at    TIMESTAMP

<<<SECTION 10>>>
## 12. Notification Service

Same architecture as all previous systems. Kafka fanout from upstream services, APNs for iOS, FCM for Android, email via SES.

The Notification Service subscribes to:

- doc.shared -> "Harry shared a document with you" email + push notification
- comment.created -> comment notification to document owner and mentioned users
- comment.replied -> reply notification to parent comment author
- permission.changed -> "Your access to this document has changed" notification
- doc.access_requested -> "Someone requested access to your document" to owner

## 13. Search Service

Google Docs search covers document titles and content. Unlike Medium where full content search was limited to a preview, Google Docs indexes full document content since users frequently search for specific phrases within their documents.

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

Search results are filtered by shared_with to ensure users only see documents they have access to. The shared_with array is updated via Kafka consumer when permissions change.

Document content is synced to Elasticsearch from MongoDB snapshots via a background indexing worker, not on every keystroke. A document's search index is updated every time a new snapshot is taken (every 30 minutes of active editing). Real-time keystroke-level search indexing is unnecessary and would overwhelm Elasticsearch.

<<<SECTION 11>>>
## 14. Full Data Flow Summary

Document Open Flow:  
Client -> API Gateway (auth) -> Document Service  
    -> Fetch document metadata from PostgreSQL  
    -> Check permission from Redis (doc:permissions:{doc_id}:{user_id})  
    -> Fetch document snapshot from Redis (doc:snapshot:{doc_id})  
    -> Return content + server_version to client  
    -> Client establishes WebSocket to Collaboration Service  
    -> Subscribe to Redis Pub/Sub (doc:{doc_id}:operations)  
    -> Buffer any operations arriving during connection setup  
    -> Apply buffered operations in server_version order  
  
Real-time Edit Flow:  
User presses key -> client generates operation with client_version  
    -> WebSocket -> Collaboration Service  
    -> Redis permission check (sub-millisecond)  
    -> Kafka (doc.operations, partitioned by doc_id)  
    -> OT Worker:  
        -> Fetch ops server_version > client_version from Cassandra  
        -> Transform incoming op against each fetched op  
        -> Assign server_version via Redis INCR doc:version:{doc_id}  
        -> Write transformed op to Cassandra (async)  
        -> Update Redis snapshot (doc:snapshot:{doc_id})  
        -> Publish to Redis Pub/Sub (doc:{doc_id}:operations)  
    -> All Collaboration Servers subscribed to channel receive op  
    -> Push to all connected users via WebSocket  
    -> All clients apply op and update client_version  
  
Cursor Presence Flow:  
User moves cursor -> WebSocket -> Collaboration Service  
    -> Redis HSET doc:cursors:{doc_id} user_id {position, color}  
    -> Redis Pub/Sub publish (doc:{doc_id}:cursors)  
    -> All connected users receive cursor update  
    -> Render cursor avatar at new position  
  
Offline Sync Flow:  
User disconnects -> client queues ops in IndexedDB  
User reconnects -> WebSocket re-established  
    -> Client sends last known client_version  
    -> Server fetches missed ops from Cassandra (server_version > client_version)  
    -> Server sends missed ops to client  
    -> Client applies missed ops via OT against local queue  
    -> Client sends offline op queue to server  
    -> OT Worker transforms offline ops against server ops since disconnect  
    -> Transformed ops broadcast to all connected users via Redis Pub/Sub  
  
Snapshot Flow:  
Every 30 mins or 1000 ops -> Snapshot Worker triggers  
    -> Read current state from Redis (doc:snapshot:{doc_id})  
    -> Write to MongoDB Snapshots collection  
    -> Record in PostgreSQL Snapshots Table  
    -> Trigger Elasticsearch reindex of document content  
  
Version History Flow:  
User requests document at target_timestamp  
    -> Version History Service  
    -> PostgreSQL: find nearest snapshot before target_timestamp  
    -> Cassandra: fetch ops between snapshot.server_version and target_timestamp  
    -> Replay ops on snapshot content  
    -> Cache result in Redis (doc:version:{doc_id}:{timestamp_bucket})  
    -> Return reconstructed document to client  
  
Permission Revocation Flow:  
Owner revokes access -> Document Service  
    -> DELETE doc:permissions:{doc_id}:{user_id} from Redis  
    -> Publish permission.revoked to Kafka  
    -> Collaboration Service closes affected user's WebSocket  
    -> User loses access within seconds

<<<SECTION 12>>>
## 15. Resilience and Fault Tolerance

**OT algorithm correctness** is the primary correctness guarantee. The client_version revision number on every operation ensures the OT worker always knows exactly which operations to transform against, regardless of network delays or out-of-order delivery.

**Kafka durability** for all operations means no keystroke is ever lost even if the OT Worker or Collaboration Service crashes mid-processing. Operations are replayed from Kafka on worker restart.

**Redis snapshot as fast initial state** means a user joining an active document never waits for a database query. The snapshot is served from in-memory Redis in sub-millisecond time.

**Cassandra operation log** provides durable, ordered storage for all operations with high write throughput. Cassandra's replication factor of 3 ensures no operation is lost under node failures.

**MongoDB snapshot storage** provides durable version history with flexible schema. Snapshot writes happen asynchronously so MongoDB slowdowns do not affect real-time editing performance.

**Offline editing with IndexedDB queue** ensures no work is lost during connectivity loss. The client_version on every queued operation makes reconnection sync mathematically equivalent to real-time sync.

**Redis Pub/Sub for operation broadcast** decouples Collaboration Servers from each other. A server crash only affects users connected to that server. They reconnect to another server within seconds and receive missed operations from their last known client_version.

**Permission caching with event-driven invalidation** ensures permission checks are sub-millisecond in the hot path while access revocation propagates within seconds via Kafka events.

**Snapshot plus operation retention policy** keeps storage manageable. Raw operations are retained for 30 days and then evicted. Snapshots are kept indefinitely providing coarser-grained version history beyond 30 days.

<<<SECTION 13>>>
## 16. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, REST request routing)

**Document Metadata DB** -> PostgreSQL (Document metadata, permissions, snapshot references, strong consistency)

**Document Content Store** -> MongoDB (Rich text JSON blocks, flexible schema, large nested documents)

**Operation Log** -> Apache Cassandra (Append-only high write throughput, partition by doc_id, cluster by server_version)

**Snapshot Cache** -> Redis (Current document state + server_version, sub-millisecond initial load for joining users)

**Version Cache** -> Redis with TTL (Cached reconstructed point-in-time versions, 1-hour TTL)

**Real-time Transport** -> WebSockets (Persistent bidirectional connection, sub-100ms operation delivery)

**Operation Broadcast** -> Redis Pub/Sub (Cross-server operation and cursor broadcasting to all connected clients)

**Conflict Resolution** -> Operational Transformation (OT Workers consuming from Kafka, transforming against Cassandra op log)

**Version Counter** -> Redis INCR (Atomic monotonically incrementing server_version per document)

**Permission Cache** -> Redis with TTL + event-driven invalidation (Sub-millisecond permission checks, Kafka-based revocation)

**Cursor Presence** -> Redis Hash with TTL (Per-document cursor state, auto-expires 5 seconds after last update)

**Offline Queue** -> Browser IndexedDB (Persistent local operation queue, survives tab close and connectivity loss)

**Search Engine** -> Elasticsearch (Full document content search, updated from MongoDB snapshots every 30 mins)

**Image Storage** -> AWS S3 (Embedded document images, CDN-native)

**CDN** -> CloudFront / Akamai (Edge caching for document images)

**Decoupling** -> Apache Kafka (Operation durability, permission events, snapshot triggers, notification fanout)

**Notification Delivery** -> APNs + FCM + AWS SES (Share notifications, comment alerts, access requests)

That's all, folks...Cheers!!
