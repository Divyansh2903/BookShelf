# Databases in Depth Part-3

<<<SECTION 1>>>
## Databases in Depth: Part 3 (B-Tree Variants and Log-Structured Storage)

Parts 1 and 2 built the classical B-tree from first principles: why disk forces page-based thinking, how slotted pages and cells work, and how splits, merges, and rebalancing keep the tree height-balanced. The classical B-tree has real weaknesses, especially write amplification, concurrency contention, and cache behavior. Research has produced both refinements of the B-tree and a different paradigm built around logs instead of in-place trees.

Part 3 covers the major B-tree variants that address specific weaknesses, then log-structured storage (the LSM tree and its ecosystem), the other major branch of modern storage engine design.

## B-Tree Variants

The classical B-tree from Part 2 updates pages in place and relies on write-ahead logging for crash safety. Costs: in-place updates create random writes, concurrent access needs careful latching, and naive implementations don't always suit CPU cache hierarchies. Each variant below addresses one or more of these.

<<<SECTION 2>>>
### Copy-on-write B-trees

In a copy-on-write (COW) B-tree, a modification never touches an existing page in place. The modified page is written as a new copy, and the change propagates upward: every ancestor on the path to the root is also copied and rewritten, since each one's child pointer must reference the new page. Once the new root is built, it is installed atomically with a single pointer swap. The previous tree stays untouched and valid until then.

This gives strong crash consistency almost for free. If a crash happens mid-write, the old root still points to an intact tree. No undo logging is needed on the tree structure, because the old version still exists.

The cost is write amplification along the root-to-leaf path: a single-key change in a deep tree can rewrite every page from leaf to root. **LMDB** uses this design, betting that crash-safety simplicity and read performance outweigh the write cost (readers never need locks; they read from whichever root was valid when their transaction started). It also connects naturally to **MVCC**: old tree versions can be kept briefly to give long-running read transactions a consistent snapshot, like row-level MVCC but applied to whole tree structures.

<<<SECTION 3>>>
### Abstracting node updates (indirection layers)

A more incremental alternative to full COW is an indirection layer between logical node identity and physical page location. Instead of storing a direct disk offset to its child, a parent stores a logical page ID, resolved through a separate mapping table (a page table or translation layer) to the child's physical location.

This enables:
- Relocating a page on disk (for compaction, defragmentation, or SSD wear-leveling) by updating one mapping-table entry, instead of rewriting every ancestor.
- Partial copy-on-write, where only the mapping-table entry changes on update, instead of propagating a new physical reference up through every ancestor.

This is the conceptual seed of the Bw-tree (below), which takes indirection much further.

<<<SECTION 4>>>
### Lazy B-trees

Lazy B-trees rest on the observation that propagating every structural change (splits, merges, rebalancing) immediately and synchronously is often more work than needed, especially under high write throughput. They defer and batch structural maintenance.

A common technique is buffering inserts and deletes at each internal node (a "buffer tree" approach) instead of always traversing to a leaf. Writes accumulate in a node's buffer; when it fills, buffered operations are pushed down to children in a batch. This amortizes traversal cost across many writes instead of paying a full root-to-leaf traversal per insert. The trade-off is a more complex read path: a read must check buffered operations at multiple levels on the way down, plus the target leaf, so it doesn't miss a newer buffered write.

Simpler lazy strategies include deferring leaf rebalancing after a delete (leaving an underfull leaf instead of merging immediately), betting a later insert into the same region will make the merge unnecessary. This avoids "thrashing", where a leaf repeatedly splits and merges under interleaved inserts and deletes.

<<<SECTION 5>>>
### FD-Trees (Flash Disk Trees)

FD-trees are designed for flash storage (SSDs). SSDs handle random reads reasonably well, but random writes are comparatively expensive and add to write amplification and flash wear, because flash must erase and rewrite whole blocks rather than modifying individual bytes in place.

An FD-tree combines a small in-memory write buffer (similar to a memtable, see the LSM section) with a series of read-only, sorted runs on disk, organized into levels of exponentially increasing size, like LSM levels. Writes accumulate in the buffer; when full, they are merged into the on-disk levels with sequential, batch-friendly writes instead of scattered random ones. Each on-disk level keeps a small in-memory index (a "fence pointer" structure, or in the original design, a fractional cascading structure) so a search is routed to the right level and location without scanning every level.

The key insight is the same as for LSM trees: convert random writes into sequential writes by buffering and batch-merging, at some cost to reads, since a lookup may check multiple levels. FD-trees helped establish this trade-off as a serious alternative to in-place B-trees, motivated by flash hardware.

<<<SECTION 6>>>
### Bw-Trees (Buzzword: Latch-free B-trees)

From Microsoft Research (used in early Hekaton, later in some SQL Server and Azure storage components), the Bw-tree targets **latch contention**. Classical B-trees need latches (short-duration locks on in-memory page structures) so concurrent readers and writers don't corrupt a page mid-update. On multi-core hardware with dozens or hundreds of threads on the same hot pages, this becomes a serious bottleneck.

It eliminates latches with atomic **compare-and-swap (CAS)** on a mapping table (indirection taken to the extreme). An update is a small **delta record** describing the change, CAS-prepended to a linked list of deltas for the page's logical ID. Readers traverse the delta chain plus base page to reconstruct current state.

When a chain grows too long it is **consolidated** into a fresh base page, and the mapping entry is CAS-updated to point to it. No locks anywhere.

Result: latch-free access on highly parallel hardware, at the cost of high implementation complexity (lock-free reasoning is notoriously hard) and read overhead from delta chains. Since pages are never modified in place, deltas can be flushed append-only and sequentially, so the Bw-tree naturally sits on log-structured storage.

<<<SECTION 7>>>
### Cache-oblivious B-trees

These target the in-machine cache hierarchy (L1, L2, L3 CPU caches, main memory), where each level has its own size and cost of accessing the level below, rather than the disk/memory boundary.

A "cache-aware" structure is tuned to specific cache line and size parameters. A "cache-oblivious" one is near-optimal at every level at once without knowing any cache size, via recursive self-similar layouts, most commonly the **van Emde Boas layout**: the tree is split into a top half and bottom halves, each laid out recursively the same way down to single elements.

Whatever the cache size, some level of subdivision matches it, so a contiguous cache-sized chunk already sits together in memory, minimizing misses at every level.

They appear more in academic and specialized high-performance work than mainstream databases, since simpler cache-aware tuning (page and node sizes chosen empirically for common hardware) gives comparable benefit. Still, the idea of designing layout for the whole memory hierarchy has influenced data layout broadly.

## Log-Structured Storage

Everything above is still a B-tree of pages updated in place (or copy-on-write). Log-structured storage instead treats storage as an append-only log, with background processes keeping it searchable and space-efficient.

<<<SECTION 8>>>
### The core idea: LSM Trees

A Log-Structured Merge tree (LSM tree) exploits the fact that sequential writes are far cheaper than random ones on both spinning disks and flash. Converting all writes into sequential appends and deferring read-oriented organization to batched background work yields much higher write throughput than a B-tree, which pays that cost synchronously on every write via splits and merges.

Typical components:

- **Memtable**: an in-memory sorted structure (often a skip list, occasionally a small in-memory B-tree or red-black tree) that absorbs all new writes. No disk I/O on the hot write path.
- **Write-ahead log**: since the memtable is volatile, an on-disk WAL records every write as a sequential append so the memtable can be rebuilt after a crash before flushing.
- **SSTables (Sorted String Tables)**: when the memtable reaches a size threshold, it is flushed to disk as an immutable sorted file. Because the memtable is already sorted, the flush is a simple sequential write. An SSTable is never modified again (the immutability principle from Part 1).
- **Levels**: SSTables are organized into levels (L0, L1, L2, ...), each typically an order of magnitude larger than the one above. Data flows from the memtable into L0; a background **compaction** process periodically merges SSTables from one level into the next, reading multiple sorted files and merging them (like merge sort's merge step) into new, larger sorted SSTables, discarding obsolete or overwritten entries.

<<<SECTION 9>>>
### Read amplification

Reads pay for the write-optimized design. A key's data might be in the memtable, in any L0 SSTable (L0 files can have overlapping key ranges because they are flushed independently), or in exactly one SSTable at each lower level. A point lookup may, in the worst case, check many locations before finding the newest version or confirming the key doesn't exist.

**Read amplification** is the ratio of actual disk reads to the minimum reads theoretically needed. Mitigations:

- **Bloom filters**: a compact probabilistic structure per SSTable that answers "this key is definitely not in this file" with no false negatives (occasional false positives possible), letting reads skip most SSTables without reading them.
- **Fence pointers / sparse indexes**: an in-memory index of key ranges per SSTable (or per block), letting a read jump to the relevant part of a file instead of scanning.
- **Compaction**: consolidating SSTables reduces the number of files a read must check, trading background write work for lower read cost.

<<<SECTION 10>>>
### Write amplification

LSM trees still suffer **write amplification**: total bytes written to disk (initial flush plus all compactions) divided by logical bytes written by the application. A key is rewritten as it merges L0 → L1 → L2 and so on, though its value is unchanged.

This often-underestimated cost is a main reason compaction strategy is actively studied, since strategies trade write, read, and space amplification very differently.

### Space amplification

**Space amplification** is disk space used beyond the logical data size, from obsolete, overwritten, or deleted entries not yet reclaimed and from redundant data across levels before it is merged down.

The three amplifications are in tension. Compacting more aggressively (sooner, more often) lowers read and space amplification (data more consolidated, obsolete entries reclaimed faster) but raises write amplification; less compaction does the reverse. Tuning an LSM system largely means picking where on this triangle a workload sits.

<<<SECTION 11>>>
### Implementation details: compaction strategies

Two strategies dominate in production:

**Leveled compaction**: each level beyond L0 holds non-overlapping, fully sorted key ranges across its SSTables, and each level is roughly a fixed multiple larger than the one above. Compaction merges a file (or files) from level N into the overlapping files at level N+1.
- Minimizes space and read amplification (at most one file per level to check, given non-overlapping ranges).
- Higher write amplification, since data is rewritten at every level.
- Default in RocksDB and LevelDB.

**Size-tiered compaction**: SSTables of similar size are grouped and merged into a larger SSTable once enough accumulate, without necessarily keeping non-overlapping ranges within a level.
- Lower write amplification (data rewritten less often).
- Higher read amplification (more overlapping files to check) and space amplification (more redundant, uncompacted data at once).
- Historically a common Cassandra default, especially for write-heavy workloads.

Many modern systems (RocksDB in particular) support both and let operators choose by read/write balance; some newer designs use hybrid strategies that behave differently at different levels.

<<<SECTION 12>>>
### Unordered LSM storage

This variant relaxes the requirement that every level be strictly sorted and mergeable by ordered comparison. Incoming writes may be grouped by arrival time or hash instead of sort key, deferring full sorting until compaction, or in some designs avoiding a global sort entirely in favor of secondary indexes layered over unsorted segments. It trades slower, index-assisted point lookups for even cheaper ingestion. Useful for workloads dominated by very high-throughput writes with rare reads, such as some logging, telemetry, or event-ingestion systems, where write throughput matters far more than in typical OLTP.

### Concurrency in LSM trees

Immutability gives LSM trees a concurrency advantage: SSTables are never modified once written, so readers never need to coordinate with writers on them. This removes a whole category of latching complexity that motivated the Bw-tree.

Remaining challenges are narrower:
- **Memtable access**: the one component mutated in place, typically handled with a concurrent skip list or similar lock-light structure.
- **Compaction coordination**: newly merged SSTables must be swapped in and old ones retired without disrupting in-flight reads, usually via reference counting or epoch-based reclamation, so an SSTable isn't physically deleted while a read is using it.

<<<SECTION 13>>>
### Log stacking

Log stacking arises when log-structured engines sit on other log-structured systems: an LSM database on a log-structured filesystem, or on an SSD's flash translation layer (FTL), which internally uses log-structured, copy-on-write techniques.

Each layer optimizes for sequential writes and runs its own garbage collection or compaction, so overhead compounds: the database's compaction rewrites data sequentially, the filesystem may copy-on-write relocate that "sequential" pattern, and the FTL does its own remapping and garbage collection for wear-leveling. Layers can work against or duplicate each other. This "log on log" or "stacked log" problem causes unexpected write amplification in systems that look efficient at each layer alone.

<<<SECTION 14>>>
### LLAMA and mindful stacking

**LLAMA** (Latch-free, Log-structured, Access-method Aware storage engine, built alongside the Bw-tree at Microsoft) answers log stacking. Rather than putting the Bw-tree on a generic, unaware filesystem or block layer, LLAMA is aware of the access method above it (the delta-chain and page-mapping-table structure), so it manages flushing, compaction, and space reclamation knowing how that layer uses and invalidates data.

**Mindful stacking**, designing adjacent layers aware of each other rather than as opaque black boxes, recurs in recent research. Instead of accepting compounded overhead from generic layers (database on generic filesystem on generic block device), it argues for either:
- collapsing layers (the database managing raw block devices or raw flash directly, bypassing the filesystem, as some specialized systems do), or
- making adjacent layers aware enough of each other to avoid redundant work, such as duplicate garbage-collection passes or duplicate journaling of the same logical change.

**Series conclusion.** Across the three parts, physical constraints (disk vs. memory latency, page-based I/O, sequential vs. random access, CPU cache hierarchies) drive almost every meaningful design decision in database internals. The classical B-tree, its variants (copy-on-write, Bw-trees, cache-oblivious layouts), and the log-structured family (LSM trees, FD-trees, and layered systems around them) are different answers to one question: given the physical cost of moving data, how do you organize it so reads, writes, and space usage are each as efficient as your workload needs?

There is no universally correct answer, only trade-offs: read-optimized vs. write-optimized, simplicity vs. raw throughput, latch-based correctness vs. lock-free complexity. Understanding those trade-offs, rather than memorizing which database uses which structure, is what transfers when evaluating unfamiliar systems or making your own architectural decisions.
