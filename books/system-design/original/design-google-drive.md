# Design Google Drive

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

- File upload and download (any file type: documents, images, videos, audio, PDFs, zip files)
- Folder hierarchy and organization
- File and folder sharing with role-based access (viewer, commenter, editor, owner)
- File versioning (see and restore previous versions)
- Search for files and folders (by name and by content)
- Notifications (share alerts, file update notifications)
- Trash and restore deleted files
- Storage quota management per user

### Out of Scope

- Google Docs real-time collaborative editing (separate system, already designed)
- Google Photos (separate product)
- Third-party app integrations
- Team Drives and Shared Drives (enterprise feature)
- Offline sync client

### Non-Functional Requirements

- High availability for file upload and download
- Resumable uploads, interrupted uploads must resume without restarting
- No data loss, every uploaded file must be durable across hardware failures
- Strong consistency for file metadata and permissions
- Eventual consistency acceptable for search indexing and notifications
- Storage deduplication to avoid storing identical files multiple times
- Storage tiering, old file versions move to cheaper cold storage automatically
- Permission changes must propagate immediately, revoked access must stop working within seconds

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 10 million
- **Files uploaded per user per day:** 2
- **Average file size:** 500 KB
- **Raw storage per day:** 10M x 2 x 500 KB = 10 TB/day
- **After 40% deduplication:** 60% x 10 TB = 6 TB/day effective new storage
- **Read/write ratio:** 10:1, files are uploaded once and accessed many times across devices and shared users
- **Storage tiering:** current versions in S3 Standard, versions older than 30 days in S3 Infrequent Access, versions older than 90 days in S3 Glacier
- **Quota per user:** 15 GB free, paid tiers for more

The dominant design challenge is correctness across three dimensions: resumable uploads that survive network failures, deduplication that saves storage without leaking information between users, and permission enforcement that propagates instantly when access is revoked.

## 3. API Gateway

All client requests enter through the API Gateway which handles authentication, rate limiting, and routing. The API Gateway enforces authentication on every request before any file operation reaches downstream services.

One important distinction from previous systems: the API Gateway handles metadata operations (create folder, rename file, share file) but never handles binary file payloads directly. File uploads go through a presigned URL pattern for small files and a resumable chunked upload pattern for large files. The API Gateway only orchestrates the session creation and tracks upload state, never touching the raw bytes.

<<<SECTION 3>>>
## 4. Upload Service and Block Service

Small File Upload (under 5 MB)

For small files, the standard presigned S3 URL pattern applies:

1. Client sends POST /api/v1/files/upload with file metadata (name, size, MIME type) to the Upload Service via API Gateway
1. Upload Service generates a presigned S3 URL
1. Client uploads file directly to S3
1. S3 triggers an upload event to Kafka
1. File Assembly Service picks up the event and triggers deduplication

Large File Upload (over 5 MB) - Resumable Upload

Large files are split into chunks on the client side before upload. This enables resumable uploads where interrupted transfers can continue from the last successful chunk.

### Step 1 - Create Upload Session

POST /api/v1/files/upload?uploadType=resumable  
Body: { file_name, file_size, mime_type, parent_folder_id }

Upload Service creates an upload session record and returns a session_id:

UploadSessions  
session_id        UUID, primary key  
user_id           UUID, foreign key -> Users  
file_name         VARCHAR  
file_size         BIGINT  
mime_type         VARCHAR  
parent_folder_id  UUID  
total_chunks      INTEGER  
chunk_size        INTEGER (5 MB default)  
status            ENUM('in_progress', 'completed', 'expired')  
expires_at        TIMESTAMP (24 hours from last activity)  
created_at        TIMESTAMP

Uploaded chunk tracking is stored in Redis for fast access:

Key: upload:{session_id}:chunks  
Value: SET of completed chunk indices  
TTL: 24 hours

**Step 2 - Upload Chunks**  
 Client splits file into 5 MB chunks and uploads each independently:

PUT /api/v1/files/upload/{session_id}/chunk/{chunk_index}  
Content-Range: bytes 0-5242879/10737418240  
Body: raw chunk bytes

The Block Service receives each chunk and:

1. Encrypts the chunk using AES-256 with a per-file encryption key
1. Uploads the encrypted chunk to S3 at path: uploads/{session_id}/{chunk_index}
1. Records completion: SADD upload:{session_id}:chunks {chunk_index}
1. Returns success to client

**Step 3 - Resume After Interruption**  
 If the upload is interrupted, the client queries upload status:

GET /api/v1/files/upload/{session_id}/status  
Response: { completed_chunks: \[0, 1, 2, 4\], total_chunks: 10 }

Client identifies missing chunks (3, 5, 6, 7, 8, 9) and resumes uploading from the first missing chunk. No previously uploaded chunks need to be re-sent.

**Step 4 - Complete Upload**  
 When all chunks are uploaded, client sends:

POST /api/v1/files/upload/{session_id}/complete

File Assembly Service picks this up and stitches chunks into the final file using S3 Multipart Upload Complete API. The temporary chunk objects are merged into a single S3 object. The upload session is marked complete.

### Encryption

Every file is encrypted at rest. The Block Service uses **envelope encryption**:

- A unique Data Encryption Key (DEK) is generated per file
- File chunks are encrypted with the DEK using AES-256
- The DEK itself is encrypted with a master Key Encryption Key (KEK) managed by AWS KMS
- Only the encrypted DEK is stored in the database, never the plaintext DEK

When a file is downloaded, the Download Service decrypts the DEK using KMS and uses it to decrypt the file chunks before serving them to the client.

### Bottlenecks in the Upload Pipeline

The Block Service is the primary bottleneck since it handles encryption for every chunk of every file. Encryption is CPU-intensive. This is mitigated by horizontal scaling of Block Service instances via Kubernetes autoscaling based on CPU utilization. The upload session state in Redis is fast and not a concern. S3 multipart upload handles chunk assembly natively without additional bottlenecks.

<<<SECTION 4>>>
## 5. Deduplication Service

The Deduplication Service prevents storing identical file content multiple times in S3, saving significant storage costs at scale.

Content-Based Deduplication via SHA-256 Hashing

When the File Assembly Service completes chunk assembly:

1. Deduplication Service computes the SHA-256 hash of the complete assembled file
1. Queries the S3Objects table:

```sql
SELECT file_id, s3_url, reference_count FROM S3Objects
   WHERE content_hash = 'abc123...'
```

1. If hash exists: the file is a duplicate. Create a new file metadata record pointing to the existing S3 object. Increment reference_count. Delete the temporary assembled file from S3 (it was already stored).
1. If hash does not exist: the file is new. Move it from the temporary upload path to the permanent path. Create a new S3Objects record with reference_count = 1.

S3Objects Table (PostgreSQL)

S3Objects  
content_hash      VARCHAR(64), primary key (SHA-256 hex)  
s3_url            TEXT (permanent S3 path)  
file_size         BIGINT  
reference_count   INTEGER  
created_at        TIMESTAMP

Reference Counting for Safe Deletion

The reference_count tracks how many user files point to this S3 object:

- User A uploads file X: reference_count = 1
- User B uploads same file X (deduplicated): reference_count = 2
- User A deletes their file: reference_count = 1 (S3 object stays)
- User B deletes their file: reference_count = 0 (S3 object safe to delete)

Reference count updates are done inside PostgreSQL transactions to prevent race conditions:

```sql
BEGIN;
UPDATE S3Objects SET reference_count = reference_count - 1
WHERE content_hash = 'abc123...'
RETURNING reference_count;
-- If reference_count = 0, publish s3.object.orphaned to Kafka
COMMIT;
```

The S3 Cleanup Worker consumes s3.object.orphaned events and deletes the actual S3 object.

### Security and Privacy

Deduplication must never leak information between users. User B cannot infer that User A has a file by noticing their identical upload completed instantly. The deduplication is completely transparent to users. Each user sees their own file in their own Drive with no indication of shared underlying storage.

### Bottlenecks in the Deduplication Service

SHA-256 hashing of large files (10 GB video) is CPU-intensive and takes several seconds. This happens asynchronously after upload completes so users are not blocked. The hash computation can be distributed by hashing each chunk independently and combining chunk hashes into a final file hash (Merkle tree approach), reducing single-threaded hashing time significantly.

<<<SECTION 5>>>
## 6. File Metadata Service

The File Metadata Service manages all metadata about files and folders: names, types, sizes, locations in the folder hierarchy, and ownership.

Data Model

### Files Table (PostgreSQL)

Files  
file_id           UUID, primary key  
owner_id          UUID, foreign key -> Users  
file_name         VARCHAR  
file_extension    VARCHAR  
mime_type         VARCHAR  
file_size         BIGINT  
content_hash      VARCHAR(64), foreign key -> S3Objects  
s3_url            TEXT  
is_folder         BOOLEAN  
is_starred        BOOLEAN  
is_trashed        BOOLEAN  
trashed_at        TIMESTAMP (null if not trashed)  
version           INTEGER (current version number)  
created_at        TIMESTAMP  
modified_at       TIMESTAMP  
last_modified_by  UUID, foreign key -> Users

### Folder Hierarchy - Multi-Parent Adjacency List

Google Drive uses a multi-parent adjacency list to model the folder hierarchy. Files and folders are stored in the same Files table (distinguished by is_folder). The parent-child relationship is stored in a separate join table to support files appearing in multiple folders simultaneously via shortcuts:

### FileParents Table (PostgreSQL)

FileParents  
file_id       UUID, foreign key -> Files  
parent_id     UUID, foreign key -> Files  
is_shortcut   BOOLEAN (true if this is a shortcut, not the original location)  
PRIMARY KEY (file_id, parent_id)

Key queries:

### Give me all contents of folder X (one level deep):

```sql
SELECT f.* FROM Files f
JOIN FileParents fp ON f.file_id = fp.file_id
WHERE fp.parent_id = 'folder_x'
AND f.is_trashed = false
ORDER BY f.is_folder DESC, f.file_name ASC
```

### Give me the full path of file X (breadcrumb navigation):

Recursive lookup: file -> parent -> parent -> parent -> root  
Typically 5-6 levels deep, fast with indexed lookups

The adjacency list tradeoff is acceptable for Google Drive because:

- One-level-deep queries (listing folder contents) are the overwhelming majority of queries
- Full path reconstruction (breadcrumbs) only goes 5-6 levels deep in practice
- Moving a file is a single UPDATE FileParents SET parent_id = new_folder operation

Caching Strategy

Hot folders (My Drive root, frequently accessed project folders) are cached in Redis with a short TTL. File metadata for recently accessed files is cached per user. Cache is invalidated on file rename, move, or delete via Kafka events.

Bottlenecks in the File Metadata Service

Folder listing queries with large folders (thousands of files) can be slow without proper indexing. A composite index on (parent_id, is_trashed, is_folder, file_name) covers the most common listing query efficiently. The File Metadata Service is read-heavy and benefits significantly from Redis caching of hot directories.

<<<SECTION 6>>>
## 7. Permission Service

The Permission Service manages role-based access control for all files and folders. It is the most security-critical service in the system.

Permission Model

FilePermissions  
file_id         UUID, foreign key -> Files  
user_id         UUID, foreign key -> Users (null for link-based sharing)  
permission      ENUM('owner', 'editor', 'commenter', 'viewer')  
share_type      ENUM('specific_user', 'link_anyone', 'link_org')  
created_at      TIMESTAMP  
granted_by      UUID, foreign key -> Users  
PRIMARY KEY (file_id, user_id)

### Permission Inheritance

Permissions in Google Drive inherit down the folder hierarchy. If User A has editor access to a folder, they have editor access to all files and subfolders within it. Permission inheritance is resolved at query time by walking up the FileParents tree until a permission record is found.

Inheritance resolution is cached in Redis per user per file to avoid repeated tree traversals:

Key: perm:{file_id}:{user_id}  
Value: ENUM('owner', 'editor', 'commenter', 'viewer', 'none')  
TTL: 15 minutes

### Permission Revocation

When a file owner revokes a user's access:

1. Delete permission record from FilePermissions table in PostgreSQL
1. Delete permission cache: DEL perm:{file_id}:{user_id} in Redis
1. Publish permission.revoked event to Kafka
1. Download Service invalidates any active signed URLs for that user and file
1. User loses access within seconds

Signed URLs for Google Drive have a short TTL (15-30 minutes) precisely because permissions can be revoked at any time. A long-TTL signed URL would continue to work after revocation until expiry.

Bottlenecks in the Permission Service

Permission checks happen on every file access, download, and metadata operation. The Redis permission cache absorbs the vast majority of checks. The inheritance resolution walk is the bottleneck for deeply nested folders, mitigated by caching the resolved permission rather than the raw inheritance chain.

<<<SECTION 7>>>
## 8. Download Service

The Download Service generates signed URLs for file access and handles both small file downloads and large file streaming.

Download Flow

1. Client requests file: GET /api/v1/files/{file_id}/download
1. Download Service checks permission via Redis cache
1. If permitted: fetches file metadata (S3 URL, encryption key reference) from File Metadata Service
1. Generates a short-lived signed CDN URL (15-30 minute TTL) for the file
1. Returns signed URL to client
1. Client fetches file directly from CDN using signed URL

### CDN Layer

All files are served through a CDN (CloudFront or Akamai) in front of S3. Popular shared files (a PDF shared with 10,000 colleagues for a product launch) are cached at CDN edge nodes. The first download triggers a cache fill from S3. All subsequent downloads are served from the CDN edge with no S3 involvement.

For large files (videos, large archives), the CDN supports **byte-range requests** which allow clients to fetch specific portions of a file. This enables:

- Video seeking without downloading the entire file
- Resumable downloads that continue from where they left off
- Parallel chunk downloads for faster transfer speeds

### Small vs Large File Handling

- **Small files (under 10 MB):** single CDN request, served in one response
- **Large files (over 10 MB):** client issues byte-range requests, CDN serves chunks sequentially or in parallel

The Block Service's encryption per chunk aligns naturally with byte-range requests. Each chunk can be decrypted independently since it was encrypted independently during upload.

### Bottlenecks in the Download Service

The CDN absorbs the vast majority of download load. The Download Service itself only generates signed URLs and checks permissions, both sub-millisecond operations. The bottleneck is CDN cache fill for newly uploaded files that are immediately shared with thousands of users simultaneously, mitigated by CDN warming for anticipated high-traffic files.

<<<SECTION 8>>>
## 9. Version History Service

Google Drive retains previous versions of files when they are modified and re-uploaded. Users can view and restore any previous version.

Data Model

### FileVersions Table (PostgreSQL)

FileVersions  
version_id      UUID, primary key  
file_id         UUID, foreign key -> Files  
version_number  INTEGER  
content_hash    VARCHAR(64), foreign key -> S3Objects  
s3_url          TEXT  
file_size       BIGINT  
created_at      TIMESTAMP  
created_by      UUID, foreign key -> Users  
comment         VARCHAR (optional version label)

Each time a file is re-uploaded, a new FileVersions record is created pointing to the new S3 object. The previous version record is retained. The Files table version column points to the current version number.

### Storage Tiering for Old Versions

Version storage follows a tiered approach to control costs:

- **Current version:** S3 Standard (fast access, full price)
- **Versions from last 30 days:** S3 Infrequent Access (slightly slower, 40% cheaper)
- **Versions older than 30 days:** S3 Glacier (minutes to retrieve, 80% cheaper)

A background **Version Tiering Worker** runs nightly and moves eligible versions to cheaper storage tiers based on age. S3 Object Lifecycle Policies automate the actual storage class transitions.

### Version Restoration

When a user restores a previous version:

1. Version History Service fetches the target version record from FileVersions table
1. If version is in Glacier: initiates restore request (takes 1-5 minutes)
1. Once restored: creates a new version record pointing to the old content (does not delete any existing versions)
1. Updates Files table version to the new version number
1. Publishes file.version_restored event to Kafka for search reindexing and notifications

### Deduplication and Versioning Interaction

If a user uploads a file, edits it, then reverts to the original content and re-uploads, the re-upload produces the same SHA-256 hash as the original. Deduplication detects this and the new version points to the same S3 object as the original version. No duplicate storage. Reference count on the S3 object increments to account for the new version reference.

<<<SECTION 9>>>
## 10. Quota Service

Every Google Drive user has a storage quota. The Quota Service tracks usage and enforces limits.

Quota Tracking

### UserQuotas Table (PostgreSQL)

UserQuotas  
user_id           UUID, primary key, foreign key -> Users  
quota_bytes       BIGINT (15 GB free = 16,106,127,360 bytes)  
used_bytes        BIGINT  
last_updated      TIMESTAMP

used_bytes is a denormalized counter updated asynchronously via Kafka consumers when files are uploaded or deleted. It reflects the sum of all current file versions owned by the user, regardless of deduplication savings.

Quota Enforcement

Quota is checked before every upload:

GET quota:{user_id} from Redis  
If used_bytes + new_file_size > quota_bytes: reject upload with 507 Insufficient Storage

Quota balance is cached in Redis per user with a short TTL for fast checks:

Key: quota:{user_id}  
Value: { quota_bytes, used_bytes }  
TTL: 5 minutes

Quota and Deduplication

Each user's quota is charged against their own files regardless of deduplication:

- User A uploads 500 MB file: User A's used_bytes += 500 MB
- User B uploads identical 500 MB file (deduplicated): User B's used_bytes += 500 MB
- Google saves the 500 MB S3 storage cost internally but both users are charged fairly

Quota and Deletion

When a user deletes a file it moves to Trash. Quota is not freed until the file is permanently deleted (user empties Trash or 30-day auto-purge):

1. File permanently deleted -> Kafka (file.permanently_deleted)
1. Quota Service consumer: UPDATE UserQuotas SET used_bytes = used_bytes - file_size WHERE user_id = X
1. Redis quota cache invalidated: DEL quota:{user_id}
1. Reference count on S3 object decremented

<<<SECTION 10>>>
## 11. Search Service

Google Drive search covers file names, folder names, and full text content within supported file types.

### Text Extraction Pipeline

Before files can be searched by content, their text must be extracted. This happens asynchronously after upload:

file.assembled event -> Kafka -> Text Extraction Worker  
    -> Determine file type from MIME type  
    -> Run appropriate parser:  
        PDF    -> Apache PDFBox extracts text  
        DOCX   -> Apache POI extracts text from XML  
        XLSX   -> Apache POI extracts cell values  
        Images -> OCR via Tesseract (makes whiteboard photos searchable)  
        TXT    -> direct indexing, no extraction needed  
        ZIP    -> extract and parse contents recursively  
    -> Publish file.text_extracted to Kafka  
    -> Search Indexing Worker indexes into Elasticsearch

Extracted text is indexed into Elasticsearch only, not stored permanently in the database. If the search index needs rebuilding, text extraction runs again from the original S3 file.

Elasticsearch Document Model

```json
{
  "file_id": "123",
  "owner_id": "456",
  "file_name": "Q3 Product Roadmap.pdf",
  "file_type": "application/pdf",
  "file_extension": "pdf",
  "file_size_bytes": 2048000,
  "content_text": "This document outlines the product strategy for Q3 2026...",
  "parent_folder_id": "789",
  "shared_with": ["user_101", "user_202", "user_303"],
  "is_starred": false,
  "is_trashed": false,
  "created_at": "2026-06-01T10:00:00Z",
  "modified_at": "2026-08-10T14:30:00Z",
  "last_modified_by": "user_456"
}
```

Filter Support

All common Drive filters map to Elasticsearch structured queries:

### Files shared with me:

{ "filter": { "term": { "shared_with": "current_user_id" } } }

### Files modified last week:

{ "filter": { "range": { "modified_at": { "gte": "now-7d" } } } }

### Files larger than 10 MB:

{ "filter": { "range": { "file_size_bytes": { "gte": 10485760 } } } }

### Files of type PDF:

{ "filter": { "term": { "file_extension": "pdf" } } }

### Combined search with filters:

```json
{
  "query": {
    "bool": {
      "must": [
        { "match": { "content_text": "product strategy" } }
      ],
      "filter": [
        { "term": { "shared_with": "current_user_id" } },
        { "term": { "file_extension": "pdf" } },
        { "range": { "modified_at": { "gte": "now-7d" } } },
        { "term": { "is_trashed": false } }
      ]
    }
  }
}
```

Security Filtering

Every search query automatically includes a security filter:

```json
{
  "filter": {
    "bool": {
      "should": [
        { "term": { "owner_id": "current_user_id" } },
        { "term": { "shared_with": "current_user_id" } }
      ]
    }
  }
}
```

A user can never see files they do not have access to in search results, even if they know the exact filename. The shared_with array in the Elasticsearch document is updated via Kafka consumer whenever permissions change.

Keeping Elasticsearch in Sync

The Search Indexing Worker consumes from multiple Kafka topics:

- file.assembled -> initial index after upload
- file.text_extracted -> update with extracted content
- file.renamed -> update file_name
- file.moved -> update parent_folder_id
- file.shared -> update shared_with array
- file.trashed -> update is_trashed flag
- file.permanently_deleted -> delete from index

<<<SECTION 11>>>
## 12. Notification Service

Same architecture as all previous systems. Kafka fanout from upstream services, APNs for iOS, FCM for Android, email via SES.

The Notification Service subscribes to:

- file.shared -> "Harry shared a file with you" email + push notification
- file.permission_changed -> "Your access to a file has changed" notification
- file.comment_added -> comment notification to file owner and mentioned users
- file.version_restored -> "A file was restored to a previous version" notification
- quota.warning -> "You are approaching your storage limit" email when usage exceeds 80% and 95%
- upload.completed -> "Your upload is complete" notification for large file uploads

## 13. Full Data Flow Summary

Small File Upload Flow:  
Client -> API Gateway (auth) -> Upload Service -> presigned S3 URL  
Client -> S3 (direct upload)  
S3 -> Kafka (file.uploaded)  
    -> Deduplication Service:  
        -> Compute SHA-256 hash  
        -> Check S3Objects table (duplicate or new)  
        -> INCR reference_count if duplicate  
        -> Create new S3Objects record if new  
    -> File Metadata Service: create Files record  
    -> Quota Service: UPDATE used_bytes  
    -> Text Extraction Worker -> Kafka (file.text_extracted)  
    -> Search Indexing Worker -> Elasticsearch  
  
Large File Upload Flow (Resumable):  
Client -> POST /upload?uploadType=resumable -> Upload Service -> session_id  
Client -> PUT /upload/{session_id}/chunk/{index} (repeat per chunk)  
    -> Block Service: encrypt chunk -> S3 (uploads/{session_id}/{index})  
    -> Redis SADD upload:{session_id}:chunks {index}  
Client -> POST /upload/{session_id}/complete  
    -> File Assembly Service: S3 Multipart Complete  
    -> Deduplication Service (same as small file flow)  
  
Interrupted Upload Resume Flow:  
Client reconnects -> GET /upload/{session_id}/status  
    -> Redis SMEMBERS upload:{session_id}:chunks -> completed chunk list  
    -> Client resumes from first missing chunk index  
  
Download Flow:  
Client -> GET /files/{file_id}/download -> Download Service  
    -> Redis permission check (perm:{file_id}:{user_id})  
    -> Fetch file metadata + S3 URL  
    -> Generate short-lived signed CDN URL (15-30 min TTL)  
    -> Client fetches from CDN (cache hit ~90% for popular shared files)  
    -> CDN cache miss -> S3 -> CDN caches -> serves file  
  
Permission Revocation Flow:  
Owner revokes access -> Permission Service  
    -> DELETE from FilePermissions (PostgreSQL)  
    -> DEL perm:{file_id}:{user_id} (Redis)  
    -> Kafka (permission.revoked)  
    -> Download Service invalidates active signed URLs  
    -> User loses access within seconds  
  
File Deletion Flow:  
User deletes file -> File Metadata Service -> is_trashed = true  
User empties trash (or 30-day auto-purge) -> hard delete triggered  
    -> Quota Service: used_bytes decremented  
    -> S3Objects: reference_count decremented via PostgreSQL transaction  
    -> If reference_count = 0: Kafka (s3.object.orphaned) -> S3 Cleanup Worker deletes S3 object  
    -> Search Indexing Worker: delete from Elasticsearch index  
  
Version History Flow:  
User re-uploads file -> new FileVersions record created  
    -> Previous version retained  
    -> Files.version incremented  
Version Tiering Worker (nightly):  
    -> Move versions older than 30 days to S3 Infrequent Access  
    -> Move versions older than 90 days to S3 Glacier  
User restores version:  
    -> If Glacier: initiate restore (1 to 5 minutes)  
    -> Create new version record pointing to old content  
    -> Update Files.version  
  
Search Flow:  
Client searches "product strategy pdf" -> Search Service  
    -> Elasticsearch bool query:  
        must: match content_text  
        filter: owner OR shared_with, file_extension, is_trashed = false  
        security filter: owner_id OR shared_with = current_user  
    -> Redis MGET (hydrate file metadata for results)

<<<SECTION 12>>>
## 14. Resilience and Fault Tolerance

**Resumable uploads with Redis chunk tracking** ensure no upload progress is lost on network failure. The client always knows exactly which chunks succeeded and resumes from the first failure. Upload sessions expire after 24 hours of inactivity preventing orphaned session state.

**Content-addressable deduplication with reference counting** prevents both storage waste and premature S3 deletion. PostgreSQL transactions ensure reference count updates are atomic. No two concurrent deletes can both decrement to zero and both try to delete the S3 object.

**Short-lived signed URLs (15 to 30 minute TTL)** ensure permission revocations propagate within minutes even if the explicit revocation event is delayed. A revoked user's signed URL expires at most 30 minutes after revocation.

**Kafka durability** throughout all pipelines means no file event is lost even if downstream services crash. Text extraction, search indexing, quota updates, and notification delivery all retry from Kafka offsets on recovery.

**Storage tiering with S3 Glacier** reduces long-term storage costs for old file versions without deleting them. Restoration from Glacier takes minutes, which is acceptable for version history retrieval.

**CDN caching** for all file downloads absorbs the vast majority of download traffic. Popular shared files are served from CDN edge nodes with no S3 origin involvement after the initial cache fill.

**Envelope encryption with AWS KMS** ensures files are encrypted at rest with per-file keys. A compromised S3 bucket cannot be read without the encryption keys, which are managed separately in KMS.

**PostgreSQL transactions for reference counting** prevent race conditions during concurrent file deletions. The S3 Cleanup Worker only deletes S3 objects after receiving a Kafka event confirming reference_count reached zero inside a committed transaction.

**Redis quota caching with short TTL** ensures quota checks are fast while remaining reasonably accurate. The 5-minute TTL means a user could theoretically upload slightly over their quota in a race condition but the Kafka consumer reconciles the true used_bytes within minutes.

<<<SECTION 13>>>
## 15. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, routing for metadata operations)

**Block Service** -> Custom encryption service + AWS S3 Multipart Upload (AES-256 per-file encryption, 5 MB chunk upload)

**Upload Session Store** -> Redis (Chunk completion tracking, resumable upload state, 24-hour TTL)

**File Content Store** -> AWS S3 (Encrypted file chunks, content-addressable paths, lifecycle policies for tiering)

**CDN** -> CloudFront / Akamai (Edge caching for all file downloads, byte-range request support)

**Storage Tiering** -> S3 Standard + S3 Infrequent Access + S3 Glacier (Automated via S3 Object Lifecycle Policies)

**Deduplication** -> SHA-256 hashing + PostgreSQL S3Objects table with reference counting

**File Metadata DB** -> PostgreSQL sharded + replicas (Files, FileParents, FileVersions, FilePermissions, strong consistency)

**Folder Hierarchy** -> Multi-parent adjacency list in FileParents table (Supports shortcuts via multiple parent rows)

**Permission Cache** -> Redis with 15-minute TTL + Kafka-based invalidation (Sub-millisecond permission checks)

**Quota Store** -> PostgreSQL UserQuotas + Redis cache with 5-minute TTL (Fast quota checks, async counter updates)

**Encryption Key Management** -> AWS KMS with envelope encryption (Per-file DEK encrypted by master KEK)

**Deduplication DB** -> PostgreSQL S3Objects table (content_hash primary key, reference_count, atomic transactions)

**Search Engine** -> Elasticsearch (Filename search, full-text content search, rich filter support)

**Text Extraction** -> Apache PDFBox + Apache POI + Tesseract OCR (Async pipeline via Kafka)

**Decoupling** -> Apache Kafka (Upload events, deduplication triggers, permission changes, quota updates, search indexing)

**Version Tiering Worker** -> Background job + S3 Lifecycle Policies (Nightly tiering of old versions to cheaper storage)

**S3 Cleanup Worker** -> Kafka consumer (Deletes orphaned S3 objects when reference_count reaches zero)

**Notification Delivery** -> APNs + FCM + AWS SES (Share notifications, quota warnings, upload completion alerts)

That's all, folks...Cheers!!
