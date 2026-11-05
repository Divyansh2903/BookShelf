# Design Google Drive

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

Upload/download any file type (documents, images, videos, audio, PDFs, zip); folder hierarchy; sharing with roles (viewer, commenter, editor, owner); versioning (view, restore); search by name and content; notifications (shares, file updates); trash and restore; per-user storage quota.

### Out of Scope

Google Docs real-time collaborative editing (separate system, already designed); Google Photos; third-party integrations; Team/Shared Drives (enterprise); offline sync client.

### Non-Functional Requirements

- High availability for upload and download
- Resumable uploads: interrupted uploads resume without restarting
- No data loss: every file durable across hardware failures
- Strong consistency for metadata and permissions
- Eventual consistency OK for search indexing and notifications
- Deduplication: don't store identical files multiple times
- Storage tiering: old versions move to cheaper cold storage automatically
- Revoked access must stop working within seconds

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 10 million; **uploads/user/day:** 2; **average file:** 500 KB
- **Raw storage/day:** 10M x 2 x 500 KB = 10 TB/day
- **After 40% deduplication:** 60% x 10 TB = 6 TB/day
- **Read/write ratio:** 10:1 (uploaded once, accessed many times across devices and shared users)
- **Tiering:** current versions in S3 Standard; versions older than 30 days in S3 Infrequent Access; older than 90 days in S3 Glacier
- **Quota:** 15 GB free, paid tiers for more

The main challenge is correctness in three areas: resumable uploads surviving network failures, deduplication that saves storage without leaking information between users, and permission enforcement that propagates instantly on revocation.

## 3. API Gateway

Authenticates every request before any file operation reaches downstream services; also rate limits and routes. It handles metadata operations (create folder, rename, share) but never binary payloads: small files use presigned URLs, large files resumable chunked upload, and the Gateway only orchestrates sessions and tracks upload state.

<<<SECTION 3>>>
## 4. Upload Service and Block Service

**Small file upload (under 5 MB)**, presigned S3 URL pattern:

1. Client sends POST /api/v1/files/upload with metadata (name, size, MIME type) to the Upload Service via API Gateway
1. Upload Service generates a presigned S3 URL
1. Client uploads directly to S3
1. S3 sends an upload event to Kafka
1. File Assembly Service picks it up and triggers deduplication

**Large file upload (over 5 MB), resumable:** the client splits files into chunks so interrupted transfers continue from the last successful chunk.

### Step 1 - Create Upload Session

POST /api/v1/files/upload?uploadType=resumable with body { file_name, file_size, mime_type, parent_folder_id }. The Upload Service creates a session record and returns session_id.

**UploadSessions:** session_id UUID PK; user_id UUID FK -> Users; file_name VARCHAR; file_size BIGINT; mime_type VARCHAR; parent_folder_id UUID; total_chunks INTEGER; chunk_size INTEGER (5 MB default); status ENUM('in_progress', 'completed', 'expired'); expires_at TIMESTAMP (24 hours from last activity); created_at TIMESTAMP.

Chunk progress lives in Redis: key upload:{session_id}:chunks, value a SET of completed chunk indices, TTL 24 hours.

**Step 2 - Upload Chunks.** The client uploads 5 MB chunks independently:

PUT /api/v1/files/upload/{session_id}/chunk/{chunk_index}, header Content-Range: bytes 0-5242879/10737418240, body raw chunk bytes.

The Block Service per chunk:

1. Encrypts it with AES-256 using a per-file key
1. Uploads it to S3 at uploads/{session_id}/{chunk_index}
1. Records completion: SADD upload:{session_id}:chunks {chunk_index}
1. Returns success

**Step 3 - Resume After Interruption.** The client calls GET /api/v1/files/upload/{session_id}/status, response { completed_chunks: [0, 1, 2, 4], total_chunks: 10 }. It identifies missing chunks (3, 5, 6, 7, 8, 9) and resumes from the first; uploaded chunks are never re-sent.

**Step 4 - Complete Upload.** Client sends POST /api/v1/files/upload/{session_id}/complete. The File Assembly Service stitches chunks into a single S3 object via the S3 Multipart Upload Complete API, and the session is marked complete.

### Encryption

Every file is encrypted at rest using **envelope encryption**:

- A unique Data Encryption Key (DEK) per file
- Chunks encrypted with the DEK using AES-256
- The DEK encrypted with a master Key Encryption Key (KEK) in AWS KMS
- Only the encrypted DEK is stored in the database, never plaintext

On download, the Download Service decrypts the DEK via KMS and uses it to decrypt chunks before serving.

### Bottlenecks in the Upload Pipeline

The Block Service (CPU-intensive encryption of every chunk) is the bottleneck; scale it horizontally with Kubernetes CPU-based autoscaling. Redis session state and S3 multipart assembly are not concerns.

<<<SECTION 4>>>
## 5. Deduplication Service

Prevents storing identical content multiple times in S3, saving significant storage cost.

**Content-based deduplication via SHA-256.** After assembly:

1. Compute the SHA-256 hash of the assembled file
1. Query the S3Objects table:

```sql
SELECT file_id, s3_url, reference_count FROM S3Objects
   WHERE content_hash = 'abc123...'
```

1. Hash exists (duplicate): create a file metadata record pointing to the existing S3 object, increment reference_count, delete the temporary assembled file.
1. Hash missing (new): move the file from the temporary to the permanent path; create an S3Objects record with reference_count = 1.

**S3Objects (PostgreSQL):** content_hash VARCHAR(64) PK (SHA-256 hex); s3_url TEXT (permanent path); file_size BIGINT; reference_count INTEGER; created_at TIMESTAMP.

**Reference counting for safe deletion** (how many user files point to the object):

- User A uploads X: 1
- User B uploads the same X (deduplicated): 2
- A deletes: 1 (object stays)
- B deletes: 0 (object safe to delete)

Updates run inside PostgreSQL transactions to prevent races:

```sql
BEGIN;
UPDATE S3Objects SET reference_count = reference_count - 1
WHERE content_hash = 'abc123...'
RETURNING reference_count;
-- If reference_count = 0, publish s3.object.orphaned to Kafka
COMMIT;
```

The S3 Cleanup Worker consumes s3.object.orphaned and deletes the S3 object.

### Security and Privacy

Deduplication must not leak information: User B must not infer User A has a file because B's identical upload finished instantly. It is fully transparent; each user sees their own file with no sign of shared storage.

### Bottlenecks in the Deduplication Service

SHA-256 of large files (10 GB video) takes several seconds of CPU. It runs asynchronously after upload, so users aren't blocked. It can be distributed by hashing chunks independently and combining them into a file hash (Merkle tree approach), sharply cutting single-threaded hashing time.

<<<SECTION 5>>>
## 6. File Metadata Service

Manages file and folder metadata: names, types, sizes, location in the hierarchy, ownership.

### Files Table (PostgreSQL)

file_id UUID PK; owner_id UUID FK -> Users; file_name VARCHAR; file_extension VARCHAR; mime_type VARCHAR; file_size BIGINT; content_hash VARCHAR(64) FK -> S3Objects; s3_url TEXT; is_folder BOOLEAN; is_starred BOOLEAN; is_trashed BOOLEAN; trashed_at TIMESTAMP (null if not trashed); version INTEGER (current version); created_at TIMESTAMP; modified_at TIMESTAMP; last_modified_by UUID FK -> Users.

### Folder Hierarchy - Multi-Parent Adjacency List

Files and folders share the Files table (distinguished by is_folder). Parent-child links live in a separate join table so a file can appear in multiple folders via shortcuts.

### FileParents Table (PostgreSQL)

file_id UUID FK -> Files; parent_id UUID FK -> Files; is_shortcut BOOLEAN (true if a shortcut, not the original location); PRIMARY KEY (file_id, parent_id).

### Give me all contents of folder X (one level deep):

```sql
SELECT f.* FROM Files f
JOIN FileParents fp ON f.file_id = fp.file_id
WHERE fp.parent_id = 'folder_x'
AND f.is_trashed = false
ORDER BY f.is_folder DESC, f.file_name ASC
```

### Give me the full path of file X (breadcrumb navigation):

Recursive lookup file -> parent -> ... -> root; typically 5-6 levels, fast with indexed lookups.

The adjacency list tradeoff works because one-level listings are the overwhelming majority of queries, breadcrumbs only go 5-6 levels deep, and moving a file is a single UPDATE FileParents SET parent_id = new_folder.

**Caching:** hot folders (My Drive root, frequent project folders) are cached in Redis with a short TTL; recently accessed file metadata is cached per user. Rename, move, or delete invalidates the cache via Kafka events.

**Bottlenecks:** listing folders with thousands of files is slow without indexing. A composite index on (parent_id, is_trashed, is_folder, file_name) covers the common listing query. The service is read-heavy and gains a lot from caching hot directories.

<<<SECTION 6>>>
## 7. Permission Service

Role-based access control for all files and folders; the most security-critical service.

**FilePermissions:** file_id UUID FK -> Files; user_id UUID FK -> Users (null for link sharing); permission ENUM('owner', 'editor', 'commenter', 'viewer'); share_type ENUM('specific_user', 'link_anyone', 'link_org'); created_at TIMESTAMP; granted_by UUID FK -> Users; PRIMARY KEY (file_id, user_id).

### Permission Inheritance

Permissions inherit down the hierarchy: editor on a folder means editor on all its files and subfolders. Resolved at query time by walking up FileParents until a permission record is found. The result is cached in Redis to avoid repeated traversals: key perm:{file_id}:{user_id}, value ENUM('owner', 'editor', 'commenter', 'viewer', 'none'), TTL 15 minutes.

### Permission Revocation

1. Delete the record from FilePermissions (PostgreSQL)
1. DEL perm:{file_id}:{user_id} in Redis
1. Publish permission.revoked to Kafka
1. Download Service invalidates active signed URLs for that user and file
1. User loses access within seconds

Signed URLs have a short TTL (15-30 minutes) because permissions can be revoked any time; a long-TTL URL would keep working after revocation until expiry.

**Bottlenecks:** checks run on every access, download, and metadata operation; the Redis cache absorbs most. The inheritance walk is the bottleneck for deep nesting, mitigated by caching the resolved permission rather than the raw chain.

<<<SECTION 7>>>
## 8. Download Service

Generates signed URLs and handles small downloads and large-file streaming.

**Download flow:**

1. Client: GET /api/v1/files/{file_id}/download
1. Check permission via Redis cache
1. If permitted, fetch metadata (S3 URL, encryption key reference) from the File Metadata Service
1. Generate a short-lived signed CDN URL (15-30 minute TTL)
1. Return it to the client
1. Client fetches the file directly from the CDN

### CDN Layer

A CDN (CloudFront or Akamai) sits in front of S3. Popular shared files (a PDF shared with 10,000 colleagues for a launch) are cached at edges: the first download fills the cache from S3, and later ones come from the edge.

For large files the CDN supports **byte-range requests**, enabling video seeking without full download, resumable downloads, and parallel chunk downloads.

- **Small files (under 10 MB):** one CDN request, one response
- **Large files (over 10 MB):** byte-range requests served sequentially or in parallel

Per-chunk encryption fits byte ranges: each chunk was encrypted independently, so it can be decrypted independently.

**Bottlenecks:** the CDN absorbs most load; the service only signs URLs and checks permissions, both sub-millisecond. The bottleneck is cache fill for new files immediately shared with thousands of users, mitigated by CDN warming for expected high-traffic files.

<<<SECTION 8>>>
## 9. Version History Service

Drive keeps previous versions when files are modified and re-uploaded; users can view and restore any of them.

### FileVersions Table (PostgreSQL)

version_id UUID PK; file_id UUID FK -> Files; version_number INTEGER; content_hash VARCHAR(64) FK -> S3Objects; s3_url TEXT; file_size BIGINT; created_at TIMESTAMP; created_by UUID FK -> Users; comment VARCHAR (optional version label).

Each re-upload creates a new FileVersions record pointing to the new S3 object; previous records are kept. Files.version holds the current version number.

### Storage Tiering for Old Versions

- **Current version:** S3 Standard (fast, full price)
- **Versions from last 30 days:** S3 Infrequent Access (slightly slower, 40% cheaper)
- **Older than 30 days:** S3 Glacier (minutes to retrieve, 80% cheaper)

A nightly **Version Tiering Worker** moves versions by age; S3 Object Lifecycle Policies automate the storage class transitions.

### Version Restoration

1. Fetch the target version from FileVersions
1. If in Glacier, start a restore (1-5 minutes)
1. Create a new version record pointing to the old content (no existing versions deleted)
1. Update Files.version to the new number
1. Publish file.version_restored to Kafka for search reindexing and notifications

### Deduplication and Versioning Interaction

If a user uploads, edits, then reverts to the original content and re-uploads, the hash matches the original. Deduplication points the new version at the same S3 object (no duplicate storage) and increments its reference count.

<<<SECTION 9>>>
## 10. Quota Service

Tracks storage usage and enforces limits.

### UserQuotas Table (PostgreSQL)

user_id UUID PK, FK -> Users; quota_bytes BIGINT (15 GB free = 16,106,127,360 bytes); used_bytes BIGINT; last_updated TIMESTAMP.

used_bytes is a denormalized counter updated asynchronously via Kafka consumers on upload or delete. It sums all current file versions the user owns, regardless of deduplication savings.

**Enforcement:** before every upload, GET quota:{user_id} from Redis; if used_bytes + new_file_size > quota_bytes, reject with 507 Insufficient Storage. Cache: key quota:{user_id}, value { quota_bytes, used_bytes }, TTL 5 minutes.

**Quota and deduplication:** each user is charged for their own files. A uploads a 500 MB file: A += 500 MB. B uploads the identical file (deduplicated): B += 500 MB. Google saves the 500 MB S3 cost internally while both are charged fairly.

**Quota and deletion:** deleted files go to Trash; quota is freed only on permanent deletion (emptying Trash or 30-day auto-purge):

1. Permanent delete -> Kafka (file.permanently_deleted)
1. Quota consumer: UPDATE UserQuotas SET used_bytes = used_bytes - file_size WHERE user_id = X
1. DEL quota:{user_id} in Redis
1. S3 object reference count decremented

<<<SECTION 10>>>
## 11. Search Service

Covers file and folder names and full-text content of supported types.

### Text Extraction Pipeline

Runs asynchronously after upload:

1. file.assembled event -> Kafka -> Text Extraction Worker
2. Determine file type from MIME type
3. Run a parser: PDF -> Apache PDFBox; DOCX -> Apache POI (text from XML); XLSX -> Apache POI (cell values); Images -> Tesseract OCR (makes whiteboard photos searchable); TXT -> indexed directly; ZIP -> extract and parse contents recursively
4. Publish file.text_extracted to Kafka
5. Search Indexing Worker indexes into Elasticsearch

Extracted text lives only in Elasticsearch; rebuilding the index reruns extraction from the S3 original.

**Elasticsearch document model:**

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

**Filters** map to structured queries:

- Shared with me: `{ "filter": { "term": { "shared_with": "current_user_id" } } }`
- Modified last week: `{ "filter": { "range": { "modified_at": { "gte": "now-7d" } } } }`
- Larger than 10 MB: `{ "filter": { "range": { "file_size_bytes": { "gte": 10485760 } } } }`
- PDF type: `{ "filter": { "term": { "file_extension": "pdf" } } }`

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

**Security filtering:** every query automatically includes:

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

Users never see inaccessible files, even knowing the exact filename. A Kafka consumer updates shared_with on permission changes.

**Keeping Elasticsearch in sync**, topics consumed by the Search Indexing Worker:

- file.assembled -> initial index after upload
- file.text_extracted -> add extracted content
- file.renamed -> update file_name
- file.moved -> update parent_folder_id
- file.shared -> update shared_with
- file.trashed -> update is_trashed
- file.permanently_deleted -> delete from index

<<<SECTION 11>>>
## 12. Notification Service

Kafka fanout from upstream services; APNs (iOS), FCM (Android), SES (email). Subscriptions:

- file.shared -> "Harry shared a file with you" email + push
- file.permission_changed -> "Your access to a file has changed"
- file.comment_added -> notify file owner and mentioned users
- file.version_restored -> "A file was restored to a previous version"
- quota.warning -> "You are approaching your storage limit" email at 80% and 95% usage
- upload.completed -> "Your upload is complete" for large uploads

## 13. Full Data Flow Summary

**Small file upload:**
1. Client -> API Gateway (auth) -> Upload Service -> presigned S3 URL
2. Client -> S3 (direct upload)
3. S3 -> Kafka (file.uploaded) -> Deduplication: SHA-256, check S3Objects; duplicate -> INCR reference_count, new -> create record
4. File Metadata Service: create Files record
5. Quota Service: UPDATE used_bytes
6. Text Extraction Worker -> Kafka (file.text_extracted) -> Search Indexing Worker -> Elasticsearch

**Large file upload (resumable):**
1. Client -> POST /upload?uploadType=resumable -> Upload Service -> session_id
2. PUT /upload/{session_id}/chunk/{index} per chunk -> Block Service encrypts -> S3 (uploads/{session_id}/{index}) -> Redis SADD upload:{session_id}:chunks {index}
3. POST /upload/{session_id}/complete -> File Assembly: S3 Multipart Complete -> Deduplication (as above)

**Resume:** GET /upload/{session_id}/status -> Redis SMEMBERS upload:{session_id}:chunks -> client resumes from first missing chunk.

**Download:** GET /files/{file_id}/download -> Redis permission check (perm:{file_id}:{user_id}) -> metadata + S3 URL -> signed CDN URL (15-30 min TTL) -> CDN (hit ~90% for popular shared files; miss -> S3 -> CDN caches -> serves).

**Revocation:** Permission Service -> DELETE FilePermissions row -> DEL perm:{file_id}:{user_id} -> Kafka (permission.revoked) -> Download Service invalidates signed URLs -> access lost within seconds.

**File deletion:**
1. Delete -> is_trashed = true
2. Empty trash or 30-day auto-purge -> hard delete
3. Quota: used_bytes decremented
4. reference_count decremented in a transaction; at 0, Kafka (s3.object.orphaned) -> S3 Cleanup Worker deletes object
5. Removed from Elasticsearch

**Version history:**
- Re-upload -> new FileVersions record, previous kept, Files.version incremented
- Nightly tiering: >30 days -> Infrequent Access; >90 days -> Glacier
- Restore: Glacier restore if needed (1-5 min) -> new version record pointing to old content -> update Files.version

**Search:** "product strategy pdf" -> Search Service -> Elasticsearch bool query (must: match content_text; filter: owner OR shared_with, file_extension, is_trashed = false; security filter: owner_id OR shared_with = current_user) -> Redis MGET hydrates metadata.

<<<SECTION 12>>>
## 14. Resilience and Fault Tolerance

- **Resumable uploads with Redis chunk tracking:** no progress lost on network failure; the client resumes from the first failed chunk. Sessions expire after 24 hours of inactivity, avoiding orphaned state.
- **Content-addressable deduplication with reference counting:** prevents storage waste and premature S3 deletion. Transactions make count updates atomic, so two concurrent deletes can't both hit zero and both delete the object.
- **Short-lived signed URLs (15 to 30 minute TTL):** revocation takes effect within minutes even if the explicit event is delayed; a revoked user's URL expires at most 30 minutes later.
- **Kafka durability:** no event lost if consumers crash; extraction, indexing, quota updates, notifications retry from offsets.
- **Storage tiering with S3 Glacier:** cuts long-term cost of old versions without deleting them; minutes-long restores are acceptable for version history.
- **CDN caching:** absorbs most downloads; after the first fill, popular files skip S3.
- **Envelope encryption with AWS KMS:** per-file keys at rest; a compromised S3 bucket is unreadable without the keys, managed separately in KMS.
- **PostgreSQL transactions for reference counting:** prevent races during concurrent deletions. The S3 Cleanup Worker deletes only after a Kafka event confirming reference_count reached zero in a committed transaction.
- **Redis quota cache with short TTL:** fast and reasonably accurate. With the 5-minute TTL a user could, in a race, upload slightly over quota, but the Kafka consumer reconciles true used_bytes within minutes.

<<<SECTION 13>>>
## 15. Technology Choices Summary

- **API Gateway:** Kong / AWS API Gateway (auth, rate limiting, metadata routing)
- **Block Service:** custom encryption + S3 Multipart Upload (AES-256 per file, 5 MB chunks)
- **Upload Session Store:** Redis (chunk tracking, resumable state, 24h TTL)
- **File Content Store:** S3 (encrypted chunks, content-addressable paths, lifecycle tiering)
- **CDN:** CloudFront / Akamai (edge caching, byte-range support)
- **Storage Tiering:** S3 Standard + Infrequent Access + Glacier via S3 Object Lifecycle Policies
- **Deduplication:** SHA-256 + PostgreSQL S3Objects (content_hash PK, reference_count, atomic transactions)
- **File Metadata DB:** PostgreSQL sharded + replicas (Files, FileParents, FileVersions, FilePermissions; strong consistency)
- **Folder Hierarchy:** multi-parent adjacency list in FileParents (shortcuts = extra parent rows)
- **Permission Cache:** Redis, 15-min TTL + Kafka invalidation (sub-ms checks)
- **Quota Store:** PostgreSQL UserQuotas + Redis, 5-min TTL (async counter updates)
- **Key Management:** AWS KMS envelope encryption (per-file DEK under master KEK)
- **Search:** Elasticsearch (filename + full-text, rich filters)
- **Text Extraction:** PDFBox + POI + Tesseract OCR (async via Kafka)
- **Decoupling:** Kafka (uploads, dedup triggers, permission changes, quota updates, indexing)
- **Version Tiering Worker:** nightly job + S3 Lifecycle Policies
- **S3 Cleanup Worker:** Kafka consumer deleting objects at reference_count zero
- **Notifications:** APNs + FCM + AWS SES (shares, quota warnings, upload completion)
