# Databases in Depth Part-2

<<<SECTION 1>>>
## Databases in Depth: Part 2 (File Formats, B-Tree Implementation, and Transaction Processing)

Hey, legends! So, the first part of this series covered the conceptual groundwork, DBMS architecture, memory-versus-disk trade-offs, row-versus-column storage, and the reasoning behind B-trees' dominance in database indexing. Part 2 goes a level deeper. We move from "why B-trees" to "how do you actually build one," and from there into what happens when a database has to guarantee correctness in the face of concurrent transactions and unexpected crashes.

This is the part of database internals that feels the most like systems programming. We're now talking about byte layouts, page headers, split propagation, write-ahead logs, and locking protocols. It's dense, but it's also where a lot of the real engineering elegance in database design lives.

## File Formats

Before any tree structure can exist, a database needs a way to represent data as bytes on disk, and to organize those bytes so they can be efficiently read, written, and modified. This is the job of the file format layer.

<<<SECTION 2>>>
### Binary encoding: general principles

Databases almost universally store data in binary form rather than as human-readable text, for a few reasons. Binary encoding is compact (no wasted bytes on delimiters, quotes, or whitespace), fast to parse (fixed-width fields can be read via direct offset access instead of scanning character by character), and deterministic in size, which matters enormously for page-based storage where you need to know exactly how much space a record occupies.

A few recurring principles show up across virtually every binary file format used in database engines:

**Fixed-width versus variable-width fields.** Fixed-width fields (integers, fixed-length booleans, timestamps) can be read directly by offset, no scanning required. Variable-width fields (strings, blobs) need either a length prefix (store the byte length before the value) or a delimiter, with length-prefixing being the near-universal choice in binary formats because it avoids ambiguity and allows fast skipping.

**Endianness.** Multi-byte values (integers, floats) need a defined byte order, big-endian or little-endian, so that a file written on one machine can be read correctly on another. Most database engines pick one and enforce it consistently across the entire file format.

**Alignment and padding.** CPUs read certain data types more efficiently when they sit at memory addresses that are multiples of their size (a 4-byte integer aligned to a 4-byte boundary, for instance). Some formats pad records to preserve this alignment, trading a small amount of extra space for faster access.

**Checksums.** Because disk corruption, bit rot, and partial writes are real failure modes, many file formats embed checksums (CRC32 being common) at the page or record level, allowing the engine to detect corruption before it silently returns bad data to a query.

**Versioning and magic numbers.** Well-designed binary formats reserve a few header bytes for a magic number (a fixed signature identifying the file type) and a format version number, so the engine can detect incompatible or corrupted files early, and so the format can evolve over time without breaking old files.

<<<SECTION 3>>>
### Page structure

As covered in Part 1, disk-based databases organize storage into fixed-size pages, typically 4KB, 8KB, or 16KB. Every page, regardless of whether it stores table rows, index entries, or metadata, tends to share a common anatomy:

- **Page header**: metadata about the page itself. This usually includes a page ID, a page type (leaf node, internal node, overflow page, free page), a checksum, the number of records or cells currently stored, pointers to free space, and sometimes a log sequence number (LSN) used for crash recovery, marking the last point in the write-ahead log that affected this page.
- **Cell pointer array (slot array)**: a compact array of offsets, each pointing to where an actual record ("cell") lives within the page.
- **Cell content area**: the actual serialized records, packed together, usually growing from the opposite end of the page relative to the slot array.
- **Free space**: whatever room remains between the slot array and the cell content area, available for new inserts.

This layout, header at the front, slot array growing forward, cells growing backward from the end, free space in the middle, is nearly universal across production database engines (it's essentially how SQLite, Postgres, and InnoDB all structure their pages, with variations in the details).

<<<SECTION 4>>>
### Slotted pages

The slotted page design deserves special attention because it elegantly solves a specific, recurring problem: how do you store variable-length records inside a fixed-size page, while supporting efficient inserts and deletes, without constantly shifting large amounts of data around?

The naive approach, packing variable-length records back to back with no indirection, breaks down quickly. If you delete a record in the middle, you either leave a gap (wasting space and complicating free space tracking) or you shift every subsequent record over (expensive, and it invalidates any external pointers to those records).

The slotted page design solves this with a layer of indirection. Instead of pointing directly at a record's byte offset, external structures (like a parent B-tree node, or a row ID) point at a slot number. The slot array, itself just a small array of offsets living at the front of the page, is the only thing that needs updating when a record moves within the page. The actual cell content area can be compacted or rearranged freely without breaking any external references, since those references only ever point at stable slot numbers, not raw byte offsets.

This has a few nice consequences:

- Deleting a record just means removing (or nulling) its slot entry and reclaiming its space during a later compaction pass, no need to shift other records immediately.
- Records within a page can be kept logically sorted (by key) via the order of the slot array, without needing to physically reorder the underlying bytes, since sorting the slot array is far cheaper than sorting variable-length cell content.
- Free space fragmentation is contained and manageable, since periodic compaction can defragment the cell content area independently of the logical slot ordering.

<<<SECTION 5>>>
### Cell layout

A "cell" is the actual serialized unit of data stored within a page, a row in a data page, or a key plus a child pointer (internal node) or a key plus a value/row-pointer (leaf node) in an index page.

A typical cell layout includes:

- A length field (since cells are usually variable length), telling the reader exactly how many bytes to consume.
- The key itself, serialized according to its type (fixed-width for integers, length-prefixed for strings).
- Either the actual payload (in a clustered index leaf, this might be the full row) or a pointer/reference to where the payload lives (a row ID, or a pointer to an overflow page).
- Sometimes additional metadata, like a "deleted" tombstone flag for structures that support soft deletes before compaction, or version information for MVCC-based engines.

### Overflow pages

Not every record fits neatly within a single page, especially with large text fields, blobs, or JSON columns. Most engines handle this with overflow pages: if a cell would be too large to fit reasonably within its parent page (some engines cap how much of a page a single cell can consume, to avoid one giant row starving all the other cells on that page), the engine stores a truncated prefix of the value inline, plus a pointer to one or more overflow pages that hold the remainder, chained together if the value spans multiple pages. This keeps the primary page's cell sizes bounded and predictable, which matters for keeping tree fanout high and page-splitting logic simple.

## Implementing B-Trees

With the page format established, we can now talk about how the B-tree (specifically the B+tree, as noted in Part 1) is actually implemented on top of it.

<<<SECTION 6>>>
### Page header, B-tree specific fields

In addition to the generic page header fields described above, B-tree pages typically carry a few tree-specific pieces of metadata:

- **Node type flag**: is this an internal (routing) node or a leaf node? This determines how the rest of the page's cells should be interpreted.
- **Key count**: how many keys currently live in this node, used to quickly check against the minimum/maximum bounds that trigger splits or merges.
- **Right sibling pointer** (in B+trees specifically): leaf nodes typically store a pointer to the next leaf in sorted order, forming the linked list that makes range scans efficient, as discussed in Part 1.
- **Parent pointer** (optional, engine-dependent): some implementations maintain an explicit parent pointer per node to simplify split/merge propagation, though many implementations instead track the search path during traversal and avoid storing parent pointers at all, since maintaining them adds write overhead.

<<<SECTION 7>>>
### Binary search within a node

Because a B-tree node holds many sorted keys within a single page, finding the correct child pointer (in an internal node) or the correct record (in a leaf node) doesn't require scanning linearly through the slot array. Since keys within a node are kept sorted, a binary search over the slot array locates the target key or the correct child branch in O(log k) comparisons, where k is the number of keys in that node, typically in the hundreds. This is a meaningful detail: the overall B-tree search cost is often expressed as O(log n) in terms of disk page reads, but within each page, the local search over that page's contents is itself a binary search, not a linear scan.

### Insertion and propagating splits

Inserting a new key into a B-tree starts with a standard root-to-leaf traversal (using binary search at each level) to find the correct leaf node for the new key. The key is inserted into that leaf, keeping it in sorted order.

If the leaf now has room, the operation is done. If the leaf has exceeded its maximum key count, it must split.

**Splitting a node** means dividing its keys into two roughly equal halves, allocating a new page for one half, and keeping the other half in the original page. A copy of the middle (or first key of the right half, depending on the exact variant) key is then pushed up into the parent node as a new separator key, along with a pointer to the newly created sibling page.

The critical detail is that this can cascade. If the parent node also overflows after receiving the pushed-up key, the parent splits too, pushing a key further up to its own parent. This is called **propagating splits**, and in the worst case it can cascade all the way up to the root. If the root itself splits, a brand new root is created above it, and the tree's height increases by exactly one level. This is precisely how B-trees remain height-balanced by construction: growth always happens at the root, not by extending some arbitrary branch downward, which guarantees every leaf remains at the same depth.

<<<SECTION 8>>>
### Deletion, propagating merges, and rebalancing

Deletion is the mirror operation, and it's meaningfully trickier to implement correctly.

After removing a key from a leaf, if the leaf still has at least the minimum required number of keys, nothing further needs to happen. If the leaf drops below that minimum (underflows), the engine has two options:

- **Borrow (redistribute) from a sibling**: if an adjacent sibling node has more than the minimum number of keys, one key can be moved over from the sibling, through the parent, to rebalance both nodes without needing a structural merge. This is generally the cheaper, preferred option.
- **Merge with a sibling**: if the sibling is also at (or near) the minimum, borrowing isn't possible without also underflowing the sibling. Instead, the underflowing node and its sibling are combined into a single node, and the separator key that previously pointed to both of them is removed from the parent.

Just like splits, merges can propagate upward: removing a separator key from the parent might cause the parent itself to underflow, triggering another borrow or merge one level up. In rare cases, this cascades all the way to the root; if the root ends up with only a single child after a merge, that child becomes the new root, and the tree's height decreases by one.

This split/merge/borrow machinery is what people mean when they refer to a B-tree as "self-balancing." Unlike a plain BST, where a bad sequence of inserts and deletes can produce a heavily skewed, inefficient tree, a correctly implemented B-tree mechanically enforces its balance invariants on every single insert and delete, guaranteeing that height (and therefore worst-case disk reads per operation) stays bounded and predictable.

<<<SECTION 9>>>
### Right-only appends (the sequential insert optimization)

A common and important special case in real-world workloads is monotonically increasing keys, auto-incrementing primary keys, timestamps, or sequence-based IDs, where every new insert has a key larger than everything currently in the tree.

In this scenario, every single insert lands in the rightmost leaf of the tree. A naive implementation would still do a full root-to-leaf traversal for every insert, which is correct but wasteful, since the destination is always the same rightmost path.

Many production B-tree implementations special-case this pattern, sometimes called a "right-only append" or "hot rightmost leaf" optimization. The engine can cache a pointer directly to the rightmost leaf and skip the traversal for sequential inserts, only falling back to a full search if an out-of-order key arrives. Because the rightmost leaf also fills up and splits purely to the right in this pattern, the resulting tree tends to be more densely and predictably packed than one built from random insert order, which is part of why monotonic primary keys (or techniques like Snowflake IDs mentioned in earlier articles) are often recommended for high-throughput insert workloads, they minimize both traversal cost and page fragmentation.

<<<SECTION 10>>>
### Node size and fanout tuning

A practical implementation detail worth mentioning: the exact page size chosen (4KB, 8KB, 16KB) directly determines the tree's fanout, and therefore its height for a given dataset size. Larger pages mean more keys per node, higher fanout, and a shorter tree, at the cost of reading more bytes per disk access (even if you only needed one key from that page) and more expensive splits/merges (since more data has to be copied when a large page is divided). Database engines generally tune this based on their expected workload and underlying storage medium; SSDs, for instance, tolerate larger random reads more gracefully than spinning disks did, which has influenced page size choices in newer engines.

Copy-on-write versus in-place update variants

Most classical B-tree implementations (as in InnoDB or SQLite) update pages in place, modifying the existing page's bytes directly and relying on write-ahead logging for crash safety. An alternative approach, used by some modern engines (LMDB and certain copy-on-write filesystems' B-tree variants), never modifies a page in place. Instead, any change to a page creates a new copy of that page, and the change propagates upward, creating new copies of every ancestor page up to a new root. The old root and old path remain untouched and valid until the new root is atomically swapped in. This gives very strong crash consistency guarantees essentially for free (a crash mid-write simply leaves the old, still-valid tree intact), at the cost of extra write amplification, since a single leaf-level change can require rewriting an entire root-to-leaf path.

## Transaction Processing and Recovery

Everything discussed so far assumes a single operation happening in isolation. Real databases have to handle many concurrent operations, and they have to survive crashes without losing or corrupting data. This is the job of the transaction processing and recovery subsystem, and it's built around the classic ACID guarantees: Atomicity, Consistency, Isolation, and Durability.

<<<SECTION 11>>>
### Buffer management, revisited

As covered in Part 1, the buffer pool sits between the storage engine and disk, caching pages in memory to avoid repeated disk I/O. In the context of transaction processing, the buffer manager takes on additional responsibility: it must track which pages are "dirty" (modified in memory but not yet flushed to disk), and it must coordinate with the recovery subsystem to ensure dirty pages are never flushed to disk before their corresponding log entries are safely persisted. This rule, that the log record for a change must reach durable storage before the changed data page itself does, is known as the **write-ahead logging (WAL) rule**, and it is the single most important invariant underpinning crash recovery.

The buffer manager also needs an eviction policy for when the cache fills up. A naive LRU (least recently used) policy is a reasonable starting point, but many production engines use more nuanced variants, LRU-K, clock-sweep algorithms (used by Postgres), or ARC (adaptive replacement cache), to better handle patterns like large sequential scans that would otherwise flush out a cache full of genuinely hot pages.

Write-ahead logging (WAL)

The write-ahead log is an append-only file where every change to the database is recorded before it's applied to the actual data pages. Each log entry typically records enough information to redo the change (reapply it, if it didn't make it to disk before a crash) and undo the change (reverse it, if the transaction that made it never committed).

Because the log is purely sequential and append-only, writing to it is cheap, exactly the kind of sequential I/O pattern discussed in Part 1 as being dramatically faster than random writes. This lets the database defer the more expensive, randomly-scattered writes to the actual data pages, batching and reordering them for efficiency, while still guaranteeing durability, because if a crash happens before those data pages are flushed, the log has enough information to reconstruct the correct state.

<<<SECTION 12>>>
### Recovery

When a database restarts after a crash, it needs to bring itself back to a consistent state, correctly applying all committed transactions and correctly discarding all uncommitted ones. The dominant approach used across most production relational databases is a three-phase algorithm, most famously formalized as ARIES (Algorithm for Recovery and Isolation Exploiting Semantics):

**Analysis phase**: scan the log to determine which transactions were in progress at the time of the crash, and which pages were dirty (potentially unflushed) at the time of the crash.

**Redo phase**: replay the log forward from the appropriate starting point, reapplying every logged change, including changes from transactions that ultimately never committed. This might sound counterintuitive, but it's intentional: redoing everything first restores the exact physical state the database was in at the moment of the crash, which is a simpler and more reliable target to reconstruct than trying to selectively redo only "correct" changes.

**Undo phase**: now that the physical state has been fully reconstructed, roll back any transactions that were never committed, using the undo information in the log to reverse their changes.

This redo-then-undo approach, rather than trying to cleverly redo only committed work, is what makes ARIES robust to crashes happening at literally any point, including crashes that occur during the recovery process itself, since redo and undo operations are themselves idempotent and log-driven.

**Checkpointing** is an optimization layered on top of this. Periodically, the database writes a checkpoint record to the log, along with information about which transactions and dirty pages exist at that point. During recovery, the analysis phase can start from the most recent checkpoint instead of the very beginning of the log, dramatically reducing recovery time on a long-running database with a large log history.

Concurrency control

The final major piece is making sure multiple transactions running concurrently don't corrupt each other's work or see inconsistent, partial results from one another. There are two broad families of approaches.

**Lock-based concurrency control**: transactions acquire locks (shared locks for reads, exclusive locks for writes) on the data they touch, and other transactions must wait if they need a conflicting lock. The most rigorous form, two-phase locking (2PL), requires that a transaction acquire all the locks it will need before releasing any of them, guaranteeing serializability (the execution behaves as if transactions ran one at a time in some order) at the cost of reduced concurrency, since readers and writers can block each other.

A well-known hazard with lock-based systems is **deadlock**, where two transactions each hold a lock the other needs, and neither can proceed. Databases handle this either by deadlock detection (periodically scanning for cycles in a wait-for graph and aborting one of the involved transactions) or deadlock prevention (imposing an ordering on lock acquisition, or using timeouts to abort transactions that wait too long).

**Multi-version concurrency control (MVCC)**: rather than blocking readers behind writers, MVCC keeps multiple versions of each row, and each transaction reads from a consistent snapshot corresponding to the moment its transaction began. Readers never block writers and writers never block readers, since a reader simply sees an older version of a row rather than waiting for a writer's newer version to commit. This directly connects back to the immutability concepts discussed in Part 1, MVCC is essentially immutability applied at the row-version level. The tradeoff is that old row versions accumulate and need to be cleaned up eventually (vacuuming in Postgres, purge threads in InnoDB), and write-write conflicts (two transactions trying to modify the same row concurrently) still need some form of detection and resolution, typically by aborting one of the conflicting transactions.

<<<SECTION 13>>>
### Isolation levels

Not every application needs full serializability, and stricter isolation generally costs concurrency and performance. The SQL standard defines a hierarchy of isolation levels, each permitting progressively fewer anomalies:

- **Read Uncommitted**: transactions can see uncommitted changes from other transactions (dirty reads). Rarely used in practice.
- **Read Committed**: transactions only ever see committed data, but repeated reads of the same row within one transaction might see different values if another transaction commits a change in between (non-repeatable reads). This is the default isolation level in Postgres and many other systems.
- **Repeatable Read**: a transaction sees a consistent snapshot for its entire duration, so repeated reads of the same row return the same value, but new rows matching a query's conditions might still appear if inserted by another transaction (phantom reads), depending on the specific implementation.
- **Serializable**: the strictest level, guaranteeing that concurrent transactions produce a result equivalent to some serial (one-at-a-time) execution order, eliminating all anomalies, at the highest cost to concurrency.

Choosing an isolation level is a genuine engineering tradeoff, not just a correctness switch. Stricter isolation reduces the risk of subtle application-level bugs from concurrent anomalies, but it also reduces throughput and increases the likelihood of transaction aborts or waiting under contention. Understanding what anomalies your application can actually tolerate is often more valuable than reflexively reaching for the strictest available setting.

That's all, folks...Cheers!!

Only one part is left now!!
