# Databases in Depth Part-2

<<<SECTION 1>>>
## Databases in Depth: Part 2 (File Formats, B-Tree Implementation, and Transaction Processing)

Part 1 covered DBMS architecture, memory-versus-disk trade-offs, row-versus-column storage, and why B-trees dominate indexing. Part 2 covers how to actually build a B-tree, and how a database guarantees correctness under concurrent transactions and crashes: byte layouts, page headers, split propagation, write-ahead logs, and locking protocols.

## File Formats

Before any tree can exist, the **file format layer** must represent data as bytes on disk and organize them for efficient reading, writing, and modification.

<<<SECTION 2>>>
### Binary encoding: general principles

Databases store data in binary, not text, because it is **compact** (no bytes wasted on delimiters, quotes, whitespace), **fast to parse** (fixed-width fields read by direct offset, not character scanning), and **deterministic in size**, which matters for page-based storage where you must know exactly how much space a record takes.

Recurring principles:

- **Fixed- vs variable-width fields.** Fixed-width fields (integers, fixed-length booleans, timestamps) are read directly by offset. Variable-width fields (strings, blobs) need a length prefix or a delimiter; length-prefixing is near-universal because it avoids ambiguity and allows fast skipping.
- **Endianness.** Multi-byte values (integers, floats) need a defined byte order (big- or little-endian) so files are portable across machines. Most engines pick one and enforce it across the whole format.
- **Alignment and padding.** CPUs read types faster at addresses that are multiples of their size (e.g. a 4-byte integer on a 4-byte boundary). Some formats pad records for alignment, trading a little space for speed.
- **Checksums.** Disk corruption, bit rot, and partial writes are real, so many formats embed checksums (commonly CRC32) per page or record to detect corruption before returning bad data.
- **Versioning and magic numbers.** Header bytes hold a magic number (fixed signature identifying the file type) and a format version, so the engine detects incompatible or corrupted files early and the format can evolve without breaking old files.

<<<SECTION 3>>>
### Page structure

Disk-based databases use fixed-size pages, typically 4KB, 8KB, or 16KB. Every page (table rows, index entries, or metadata) shares a common anatomy:

- **Page header**: page ID, page type (leaf node, internal node, overflow page, free page), checksum, number of records/cells, pointers to free space, and sometimes a **log sequence number (LSN)** for crash recovery, marking the last write-ahead log point that affected this page.
- **Cell pointer array (slot array)**: compact array of offsets, each pointing to where a record ("cell") lives in the page.
- **Cell content area**: the serialized records, packed together, usually growing from the opposite end of the page from the slot array.
- **Free space**: the room between slot array and cell content area, available for inserts.

Header at the front, slot array growing forward, cells growing backward from the end, free space in the middle: this layout is nearly universal (essentially how SQLite, Postgres, and InnoDB structure pages, with detail variations).

<<<SECTION 4>>>
### Slotted pages

The problem: store variable-length records in a fixed-size page with efficient inserts and deletes, without constantly shifting data.

Packing records back to back with no indirection fails: deleting a middle record either leaves a gap (wasted space, harder free-space tracking) or requires shifting all later records (expensive, and it invalidates external pointers).

Slotted pages add indirection. External structures (a parent B-tree node, a row ID) point at a **slot number**, not a byte offset. Only the slot array (small, at the front of the page) changes when a record moves; the cell content area can be compacted or rearranged freely without breaking references.

Consequences:

- Deleting a record means removing or nulling its slot entry; space is reclaimed in a later compaction pass, with no immediate shifting.
- Records can be kept logically sorted by key via slot array order, without physically reordering bytes; sorting the slot array is far cheaper than sorting variable-length cells.
- Fragmentation stays manageable, since periodic compaction defragments the cell content area independently of logical slot order.

<<<SECTION 5>>>
### Cell layout

A **cell** is the serialized unit stored in a page: a row in a data page; in an index page, a key plus child pointer (internal node) or key plus value/row-pointer (leaf node). A typical cell contains:

- A length field (cells are usually variable length), telling the reader how many bytes to consume.
- The key, serialized by type (fixed-width for integers, length-prefixed for strings).
- Either the payload (in a clustered index leaf, possibly the full row) or a reference to it (a row ID, or a pointer to an overflow page).
- Sometimes extra metadata, such as a "deleted" tombstone flag for soft deletes before compaction, or version information for MVCC engines.

### Overflow pages

Large text fields, blobs, or JSON columns may not fit in one page. Some engines cap how much of a page one cell may use, so one giant row doesn't starve other cells. If a cell is too large, the engine stores a truncated prefix inline plus a pointer to one or more **overflow pages** holding the rest, chained if the value spans several pages. This keeps primary-page cell sizes bounded and predictable, which keeps tree fanout high and page-splitting logic simple.

## Implementing B-Trees

Next: how the B-tree (specifically the B+tree, per Part 1) is built on this page format.

<<<SECTION 6>>>
### Page header, B-tree specific fields

Beyond the generic header fields, B-tree pages carry:

- **Node type flag**: internal (routing) or leaf node; determines how the page's cells are interpreted.
- **Key count**: number of keys in the node, checked against min/max bounds that trigger splits or merges.
- **Right sibling pointer** (B+trees): leaves point to the next leaf in sorted order, forming the linked list that makes range scans efficient.
- **Parent pointer** (optional, engine-dependent): simplifies split/merge propagation, but many implementations instead track the search path during traversal and skip parent pointers, since maintaining them adds write overhead.

<<<SECTION 7>>>
### Binary search within a node

Keys within a node are sorted, so finding the right child pointer (internal node) or record (leaf) uses binary search over the slot array: O(log k) comparisons, where k is the node's key count (typically hundreds). Overall B-tree search is often stated as O(log n) disk page reads, but within each page the local search is also a binary search, not a linear scan.

### Insertion and propagating splits

1. Traverse root to leaf (binary search at each level) to find the correct leaf.
2. Insert the key into the leaf in sorted order.
3. If the leaf has room, done. If it exceeds its maximum key count, it splits.

**Splitting** divides the keys into two roughly equal halves: one half moves to a newly allocated page, the other stays. A copy of the middle key (or the first key of the right half, depending on variant) is pushed up into the parent as a new separator key, with a pointer to the new sibling page.

This can cascade: if the parent overflows, it splits too, pushing a key further up (**propagating splits**), possibly to the root. If the root splits, a new root is created above it and the tree's height grows by exactly one. Because growth always happens at the root, never by extending a branch downward, every leaf stays at the same depth: B-trees are height-balanced by construction.

<<<SECTION 8>>>
### Deletion, propagating merges, and rebalancing

Deletion mirrors insertion and is trickier to implement correctly. After removing a key from a leaf, if it still has the minimum number of keys, nothing more happens. If it **underflows**, there are two options:

- **Borrow (redistribute) from a sibling**: if an adjacent sibling has more than the minimum, move one key from the sibling, through the parent, to rebalance both without a structural merge. Cheaper and preferred.
- **Merge with a sibling**: if the sibling is at or near the minimum (borrowing would underflow it), combine the two nodes into one and remove their separator key from the parent.

Merges can propagate upward: removing a separator may underflow the parent, triggering another borrow or merge. Rarely this reaches the root; if the root is left with a single child, that child becomes the new root and the height decreases by one.

This split/merge/borrow machinery is what "self-balancing" means. Unlike a plain BST, where a bad sequence of inserts and deletes can skew the tree, a correct B-tree enforces its balance invariants on every insert and delete, keeping height (and thus worst-case disk reads per operation) bounded and predictable.

<<<SECTION 9>>>
### Right-only appends (the sequential insert optimization)

With monotonically increasing keys (auto-increment primary keys, timestamps, sequence IDs), every insert lands in the rightmost leaf. A naive implementation still traverses root to leaf each time: correct but wasteful.

Many production engines special-case this (**"right-only append"** or **"hot rightmost leaf"** optimization): cache a pointer to the rightmost leaf and skip traversal for sequential inserts, falling back to a full search only for an out-of-order key. Since the rightmost leaf fills and splits purely to the right, the tree ends up more densely and predictably packed than with random insert order. That's partly why monotonic primary keys (or Snowflake IDs, mentioned in earlier articles) are recommended for high-throughput inserts: they minimize traversal cost and page fragmentation.

<<<SECTION 10>>>
### Node size and fanout tuning

Page size (4KB, 8KB, 16KB) determines fanout and therefore tree height for a given dataset. Larger pages mean more keys per node, higher fanout, and a shorter tree, but more bytes read per disk access (even when only one key is needed) and costlier splits/merges (more data copied). Engines tune this to workload and storage medium; SSDs tolerate larger random reads better than spinning disks did, influencing page sizes in newer engines.

**Copy-on-write versus in-place update variants**

- **In-place** (classical, e.g. InnoDB, SQLite): modify the existing page's bytes directly, relying on write-ahead logging for crash safety.
- **Copy-on-write** (e.g. LMDB, some copy-on-write filesystems' B-tree variants): never modify a page in place. A change creates a new copy of the page and propagates upward, copying every ancestor up to a new root. The old root and path stay valid until the new root is atomically swapped in. This gives strong crash consistency nearly for free (a mid-write crash leaves the old tree intact), at the cost of write amplification: one leaf change can rewrite a whole root-to-leaf path.

## Transaction Processing and Recovery

Real databases must handle many concurrent operations and survive crashes without losing or corrupting data. The transaction processing and recovery subsystem does this, built around **ACID**: Atomicity, Consistency, Isolation, Durability.

<<<SECTION 11>>>
### Buffer management, revisited

The buffer pool caches pages in memory between storage engine and disk (Part 1). For transactions, the buffer manager must also track **dirty pages** (modified in memory, not yet flushed) and coordinate with recovery so dirty pages are never flushed before their log entries are persisted. This rule, that a change's log record must reach durable storage before the changed data page does, is the **write-ahead logging (WAL) rule**, the most important invariant behind crash recovery.

When the cache fills, an eviction policy is needed. Naive LRU (least recently used) is a reasonable start, but many engines use LRU-K, clock-sweep (Postgres), or ARC (adaptive replacement cache) to better handle patterns like large sequential scans that would otherwise flush out genuinely hot pages.

**Write-ahead logging (WAL)**

The WAL is an append-only file recording every change before it's applied to data pages. Each entry holds enough to **redo** the change (reapply it if it didn't reach disk before a crash) and **undo** it (reverse it if its transaction never committed).

Log writes are sequential and append-only, so cheap (sequential I/O is dramatically faster than random writes, per Part 1). The database can therefore defer the expensive, scattered data-page writes, batching and reordering them, while staying durable: if a crash precedes those flushes, the log can reconstruct the correct state.

<<<SECTION 12>>>
### Recovery

After a crash, the database must apply all committed transactions and discard all uncommitted ones. Most production relational databases use a three-phase algorithm, formalized as **ARIES** (Algorithm for Recovery and Isolation Exploiting Semantics):

1. **Analysis**: scan the log to find which transactions were in progress and which pages were dirty (possibly unflushed) at crash time.
2. **Redo**: replay the log forward from the appropriate starting point, reapplying every logged change, including from transactions that never committed. This intentionally restores the exact physical state at the crash, a simpler, more reliable target than selectively redoing only "correct" changes.
3. **Undo**: roll back transactions that never committed, using the log's undo information.

Redo-then-undo makes ARIES robust to crashes at any point, including during recovery itself, since redo and undo operations are idempotent and log-driven.

**Checkpointing** optimizes this: periodically the database writes a checkpoint record to the log with the current transactions and dirty pages. Analysis can start from the latest checkpoint instead of the start of the log, greatly reducing recovery time for long-running databases with large logs.

**Concurrency control**

Concurrent transactions must not corrupt each other's work or see each other's partial results. Two families:

**Lock-based concurrency control**: transactions take shared locks (reads) or exclusive locks (writes); others wait on conflicting locks. The strictest form, **two-phase locking (2PL)**, requires acquiring all needed locks before releasing any, guaranteeing **serializability** (execution behaves as if transactions ran one at a time in some order), at the cost of concurrency, since readers and writers block each other.

**Deadlock** is the classic hazard: two transactions each hold a lock the other needs. Handled by:
- **Detection**: periodically scan a wait-for graph for cycles and abort one involved transaction.
- **Prevention**: impose an ordering on lock acquisition, or use timeouts to abort transactions that wait too long.

**Multi-version concurrency control (MVCC)**: keep multiple versions of each row; each transaction reads a consistent snapshot from the moment it began. Readers never block writers and vice versa, since a reader sees an older version instead of waiting for a writer to commit. This is Part 1's immutability applied at row-version level. Trade-offs: old versions accumulate and need cleanup (vacuuming in Postgres, purge threads in InnoDB), and write-write conflicts (two transactions modifying the same row) still need detection and resolution, typically by aborting one.

<<<SECTION 13>>>
### Isolation levels

Not every application needs full serializability; stricter isolation costs concurrency and performance. The SQL standard defines levels permitting progressively fewer anomalies:

- **Read Uncommitted**: can see other transactions' uncommitted changes (**dirty reads**). Rarely used.
- **Read Committed**: sees only committed data, but rereading a row in one transaction may return different values if another transaction commits in between (**non-repeatable reads**). Default in Postgres and many other systems.
- **Repeatable Read**: a consistent snapshot for the whole transaction, so rereads return the same value, but new rows matching a query may still appear if another transaction inserts them (**phantom reads**), depending on implementation.
- **Serializable**: strictest; concurrent transactions produce a result equivalent to some serial order, eliminating all anomalies, at the highest concurrency cost.

Choosing a level is an engineering trade-off, not just a correctness switch. Stricter isolation reduces subtle concurrency bugs but lowers throughput and increases aborts or waiting under contention. Knowing which anomalies your application can tolerate beats reflexively picking the strictest setting.
