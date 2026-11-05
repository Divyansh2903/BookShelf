# Databases in Depth Part-3

<<<SECTION 1>>>
## Databases in Depth: Part 3 (B-Tree Variants and Log-Structured Storage)

Hey, legends! Parts 1 and 2 built up the classical B-tree from first principles: why disk forces page-based thinking, how slotted pages and cells work, and how splits, merges, and rebalancing keep the tree height-balanced. That classical B-tree, however, is not the end of the story (unfortunately). It has real weaknesses, particularly around write amplification, concurrency contention, and cache behavior, and decades of systems research have produced both refinements of the B-tree itself and an entirely different storage paradigm built around logs instead of in-place trees.

Part 3 covers both sides of that story. First, the major B-tree variants that address specific weaknesses in the classical design. Then, log-structured storage, the LSM tree and its ecosystem, which represents the other major branch of modern storage engine design, and closes the loop on the tradeoffs we've been circling since Part 1.

## B-Tree Variants

The classical B-tree, as implemented in Part 2, updates pages in place and relies on write-ahead logging for crash safety. This works well, but it has costs: in-place updates create random writes, concurrent access requires careful latching, and naive implementations don't always play nicely with CPU cache hierarchies. Each variant below exists to address one or more of these specific pain points.

<<<SECTION 2>>>
### Copy-on-write B-trees

We touched on this briefly in Part 2, but it's worth expanding. In a copy-on-write (COW) B-tree, a modification never touches an existing page in place. Instead, the modified page is written as a brand new copy, and this change propagates upward, every ancestor on the path from that page to the root is also copied and rewritten, since each ancestor's child pointer now needs to reference the new page instead of the old one. Once the new root is fully constructed, it is installed atomically, a single pointer swap, and the entire previous tree remains untouched and fully valid until that swap happens.

This gives extremely strong crash consistency almost for free. If a crash happens mid-write, the old root still points to a completely intact, valid tree, since nothing about the old structure was ever modified. There is no need for undo logging on the tree structure itself, because there is nothing to undo, the old version simply still exists.

The cost is write amplification along the root-to-leaf path. A single-key change to a deep tree can require rewriting every page from that leaf up to the root, even though only one leaf-level value actually changed. Systems like LMDB use this design, betting that the crash-safety simplicity and read performance (readers never need locks, since they simply read from whichever root was valid when their transaction started) outweigh the extra write cost. This also creates a natural connection to MVCC, since old tree versions can be kept around briefly to serve long-running read transactions a consistent snapshot, similar in spirit to row-level MVCC but applied at the level of entire tree structures.

<<<SECTION 3>>>
### Abstracting node updates (indirection layers)

A more incremental alternative to full copy-on-write is to introduce an indirection layer between logical node identity and physical page location, without necessarily copying the entire tree on every write. Instead of a parent node storing a direct disk offset to its child, it stores a logical page ID, which is resolved through a separate mapping table (sometimes called a page table or a translation layer) to find the child's actual physical location.

This abstraction unlocks a few useful capabilities. A page can be relocated on disk (for compaction, defragmentation, or wear-leveling on SSDs) by updating a single entry in the mapping table, rather than rewriting every ancestor that pointed to it. It also enables techniques like partial copy-on-write, where only the mapping table entry changes on an update, rather than propagating a new physical page reference all the way up through every ancestor. This is the conceptual seed behind more advanced designs like the Bw-tree, discussed below, where this indirection is taken much further.

<<<SECTION 4>>>
### Lazy B-trees

Lazy B-trees are built around a simple observation: propagating every single structural change (splits, merges, rebalancing) immediately and synchronously is often more work than necessary, especially under high write throughput. A lazy B-tree defers some of this work, batching structural maintenance rather than performing it eagerly on every operation.

A common technique here is buffering inserts and deletes at each internal node (sometimes called a "buffer tree" approach) rather than always traversing all the way down to a leaf. Writes accumulate in a node's local buffer, and only when that buffer fills up are the buffered operations pushed down to the appropriate children in a batch. This amortizes the cost of tree traversal across many writes, rather than paying the full root-to-leaf traversal cost for every single individual insert. The tradeoff is added complexity in the read path, since a read now potentially needs to check buffered operations at multiple levels on the way down, in addition to the target leaf itself, to make sure it isn't missing a more recent buffered write.

Lazy update strategies also show up in simpler forms, like deferring leaf rebalancing after a delete (leaving a temporarily underfull leaf rather than immediately triggering a merge), on the bet that a subsequent insert into the same region will arrive soon and make the merge unnecessary. This avoids "thrashing" behavior where a leaf repeatedly splits and merges under an interleaved insert/delete workload.

<<<SECTION 5>>>
### FD-Trees (Flash Disk Trees)

FD-trees were designed specifically around the characteristics of flash storage (SSDs), which behaves very differently from spinning disks. SSDs handle random reads reasonably well, but random writes are comparatively expensive and contribute to write amplification and flash wear, since flash storage must erase and rewrite entire blocks rather than modifying individual bytes in place.

An FD-tree addresses this by combining a small, in-memory write buffer (similar in spirit to a memtable, discussed below in the LSM section) with a series of read-only, sorted runs on disk, organized into levels of exponentially increasing size, conceptually similar to LSM tree levels. New writes accumulate in the memory buffer, and once full, are merged down into the on-disk levels using sequential, batch-friendly writes rather than scattered random writes. Each on-disk level also maintains a small in-memory index (a "fence pointer" structure, or in the original design, a fractional cascading structure), so that a search can be routed efficiently to the correct level and location without scanning every level linearly.

The key insight of the FD-tree is essentially the same insight underlying LSM trees more generally: convert random writes into sequential writes by buffering and batch-merging, at some cost to read complexity, since a lookup potentially has to check multiple levels. FD-trees are historically important as one of the structures that helped establish this tradeoff as a serious alternative to in-place B-trees, specifically motivated by flash hardware characteristics.

<<<SECTION 6>>>
### Bw-Trees (Buzzword: Latch-free B-trees)

The Bw-tree, developed at Microsoft Research and used in early versions of Hekaton and later in some SQL Server and Azure storage components, tackles a different problem: latch contention. Classical B-trees require latching (short-duration locks protecting in-memory page structures during concurrent modification) to keep concurrent readers and writers from corrupting a page mid-update. Under high concurrency, this latching becomes a serious bottleneck, especially on modern multi-core hardware where dozens or hundreds of threads might be hammering the same hot pages.

The Bw-tree's core idea is to eliminate latches entirely by using atomic compare-and-swap (CAS) operations on a mapping table, very similar in spirit to the indirection layer described above, but taken to its logical extreme. Instead of modifying a page in place, an update is represented as a small delta record, describing just the change, which is atomically prepended (via CAS) to a linked list of deltas associated with that page's logical ID in the mapping table. Readers traverse the delta chain along with the base page to reconstruct the current logical state.

Periodically, when a delta chain grows too long, it gets consolidated, the base page and its accumulated deltas are merged into a fresh base page, and the mapping table entry is atomically updated to point at the new consolidated page, again via CAS, with no locks involved at any point.

This design achieves genuinely latch-free concurrent access, a meaningful win on highly parallel hardware, at the cost of significant implementation complexity (correctly reasoning about lock-free data structures is notoriously difficult) and some read-path overhead from traversing delta chains. The Bw-tree also naturally supports log-structured storage underneath it, since pages are never modified in place, their delta-based updates can be flushed to disk in an append-only, sequential fashion, connecting it conceptually to the log-structured storage techniques discussed later in this article.

<<<SECTION 7>>>
### Cache-oblivious B-trees

Everything discussed so far has focused on the disk/memory boundary. Cache-oblivious B-trees instead target a different, though structurally similar, problem: the multi-level cache hierarchy within a single machine (L1, L2, L3 CPU caches, and main memory), where each level has its own size and its own cost of accessing the level below it.

A "cache-aware" structure would be explicitly tuned for specific cache line and cache size parameters. A "cache-oblivious" structure, by contrast, is designed to achieve near-optimal performance across every level of a memory hierarchy simultaneously, without being tuned to any specific cache size at all. This is achieved through recursive, self-similar layouts, most commonly the van Emde Boas layout, where a tree is recursively split into a top half and bottom halves, and each of those halves is itself laid out recursively using the same scheme, all the way down to individual elements.

The elegant property this produces is that no matter what size cache a piece of hardware happens to have, some level of this recursive subdivision will naturally align with that cache's size, meaning a contiguous cache-sized chunk of the tree will already be sitting together in memory, minimizing cache misses at every level of the hierarchy simultaneously, without the structure ever needing to know the cache size in advance.

In practice, cache-oblivious B-trees see more use in academic and specialized high-performance contexts than in mainstream production databases, since real-world engines often get comparable practical benefit from simpler, cache-aware tuning (choosing page and node sizes empirically for known common hardware). Still, the underlying idea, that structural layout should be designed with the entire memory hierarchy in mind, not just the disk/memory boundary, has influenced how engineers think about data layout more broadly.

## Log-Structured Storage

Everything covered above is still, fundamentally, a B-tree, a structure organized around in-place (or copy-on-write) updates to a tree of pages. Log-structured storage represents a genuinely different philosophy: instead of organizing data as an updatable tree, treat storage as an append-only log, and rely on background processes to keep that log searchable and space-efficient over time.

<<<SECTION 8>>>
### The core idea: LSM Trees

A Log-Structured Merge tree (LSM tree) is built around a simple insight already foreshadowed in Parts 1 and 2: sequential writes are dramatically cheaper than random writes, on both spinning disks and flash. If a storage engine could convert all its writes into sequential appends, and defer the work of organizing that data for efficient reads into a separate, batched background process, it could achieve dramatically higher write throughput than a B-tree, which pays its organizational cost synchronously, inline, on every single write via splits and merges.

The LSM tree architecture typically has these components:

**Memtable**: an in-memory, sorted structure (often a skip list, or occasionally a small in-memory B-tree or red-black tree) that absorbs all new writes. Because it's in memory, writes here are extremely fast, no disk I/O at all on the hot write path.

**Write-ahead log**: since the memtable is volatile, a write-ahead log on disk records every write as it happens, purely as a sequential append, so the memtable's contents can be reconstructed if the process crashes before that data is flushed.

**SSTables (Sorted String Tables)**: once the memtable reaches a size threshold, its contents are flushed to disk as an immutable, sorted file, an SSTable. Because the memtable was already sorted, this flush is itself a simple, efficient sequential write. Once written, an SSTable is never modified again, connecting directly back to the immutability principles discussed in Part 1.

**Levels**: over time, many SSTables accumulate on disk. LSM trees organize them into levels (commonly numbered L0, L1, L2, and so on), where each level is typically an order of magnitude larger than the one above it. Data flows from the memtable into L0, and periodically, a background compaction process merges SSTables from one level into the next, reading multiple sorted files and merging them (much like the merge step of merge sort) into new, larger, still-sorted SSTables, discarding obsolete or overwritten entries along the way.

<<<SECTION 9>>>
### Read amplification

Reads are where the LSM tree pays for its write-optimized design. Because data for a single key might exist in the memtable, in any L0 SSTable (which, unlike lower levels, can have overlapping key ranges since they're flushed independently from the memtable), or in exactly one SSTable at each lower level, a single point lookup might, in the worst case, need to check many separate locations before finding the correct, most recent version of a key, or confirming it doesn't exist at all.

This is called **read amplification**, the ratio of actual disk reads performed to the minimum number of reads theoretically needed to answer a query. LSM trees mitigate this in a few standard ways:

- **Bloom filters**: a compact, probabilistic structure attached to each SSTable that can quickly answer "this key is definitely not in this file" with no false negatives (though occasional false positives are possible). This lets a read skip the vast majority of SSTables that don't contain the target key, without needing to actually read them from disk.
- **Fence pointers / sparse indexes**: an in-memory index of key ranges per SSTable (or per block within an SSTable), allowing a read to jump directly to the relevant portion of a file rather than scanning it linearly.
- **Compaction itself**: by merging and consolidating SSTables over time, compaction directly reduces the number of files a read might need to check, trading background write work for lower future read cost.

<<<SECTION 10>>>
### Write amplification

Somewhat counterintuitively, LSM trees, despite being designed to optimize writes, still suffer from a different form of write cost: **write amplification**, the ratio of total bytes actually written to disk (across the initial flush and all subsequent compactions) versus the logical bytes the application originally wrote. A single key, once written, might be rewritten multiple times as it gets merged from L0 into L1, then L1 into L2, and so on, each compaction pass physically rewriting that key's data even though its logical value hasn't changed.

This is a real and often underestimated cost in LSM-based systems, and it's a major reason why compaction strategy (discussed below) is such an actively studied area, since different compaction strategies make very different tradeoffs between write amplification, read amplification, and space amplification.

### Space amplification

**Space amplification** refers to the extra disk space consumed by an LSM tree beyond the logical size of the data it holds. This comes from a few sources: obsolete, overwritten, or deleted entries that haven't yet been reclaimed by compaction, and the general overhead of maintaining multiple levels of potentially redundant data before it's fully merged down.

These three forms of amplification, read, write, and space, are fundamentally in tension with each other, and this tension is one of the defining engineering challenges of LSM tree design. Compacting more aggressively (merging levels sooner and more often) reduces read and space amplification, since data becomes more consolidated and obsolete entries get reclaimed faster, but it increases write amplification, since data gets rewritten more often. Compacting less aggressively does the reverse. Tuning an LSM-based system, in large part, means choosing where on this triangle a given workload should sit.

<<<SECTION 11>>>
### Implementation details: compaction strategies

Two compaction strategies dominate in production LSM implementations:

**Leveled compaction**: each level (beyond L0) holds non-overlapping, fully sorted key ranges across its SSTables, and each level is roughly a fixed multiple larger than the one above it. Compaction merges a file (or set of files) from level N into the overlapping files at level N+1. This strategy tends to minimize space amplification and read amplification (since at most one file per level needs checking, given non-overlapping ranges), at the cost of higher write amplification, since data gets rewritten at every level it passes through. RocksDB and LevelDB (as the name suggests) default to this strategy.

**Size-tiered compaction**: SSTables of similar size are grouped together and merged into a new, larger SSTable once enough similarly-sized files accumulate, without necessarily maintaining strict non-overlapping key ranges within a level. This reduces write amplification compared to leveled compaction (data is rewritten less frequently), but increases both read amplification (more files with overlapping ranges might need checking) and space amplification (more redundant, not-yet-compacted data sits around at once). Cassandra historically offered this as a common default, particularly for write-heavy workloads.

Many modern systems (RocksDB in particular) support both strategies and let operators choose based on their workload's read/write balance, and some newer designs use hybrid strategies that behave differently at different levels of the tree.

<<<SECTION 12>>>
### Unordered LSM storage

A more specialized variant relaxes the assumption that every level must be strictly sorted and mergeable via ordered comparison. In an unordered (or partially unordered) LSM design, incoming writes may be grouped by arrival time or by hash rather than sort key, deferring the cost of full sorting until compaction, or in some designs, avoiding a global sort entirely in favor of secondary indexing structures layered on top of unsorted segments. This trades slower, index-assisted point lookups for even cheaper ingestion, useful in workloads dominated by extremely high-throughput writes with comparatively rare reads, such as certain logging, telemetry, or event-ingestion systems, where write throughput dominates the cost equation far more than in a typical OLTP workload.

### Concurrency in LSM trees

LSM trees have a structural advantage for concurrency that follows directly from their immutability principles. Since SSTables, once written, are never modified, readers accessing an SSTable never need to coordinate with writers, there is nothing for a writer to be doing to that file concurrently. This eliminates an entire category of the latching complexity that motivated structures like the Bw-tree in the B-tree world.

The concurrency challenges that remain in LSM trees are concentrated in narrower places: coordinating access to the mutable memtable (typically handled with a concurrent skip list or similar lock-light structure, since the memtable is the one component that is genuinely mutated in place), and coordinating compaction (which needs to safely swap in newly merged SSTables and retire old ones without disrupting in-flight reads, typically handled via reference counting or an epoch-based reclamation scheme, so an SSTable isn't physically deleted while a read is still using it).

<<<SECTION 13>>>
### Log stacking

Log stacking refers to a subtle but important problem that arises when log-structured storage engines are layered on top of other log-structured systems, an LSM-based database running on top of a log-structured filesystem, or on top of an SSD's own internal flash translation layer (FTL), which itself manages flash storage using log-structured, copy-on-write techniques internally.

The problem is that each layer independently believes it is optimizing for sequential writes and managing its own garbage collection or compaction, but stacking several such layers together can produce compounding, redundant overhead. The database's compaction rewrites data sequentially at the logical level, the filesystem underneath may itself be doing copy-on-write relocation of that "sequential" write pattern, and the SSD's FTL underneath that is doing its own internal log-structured remapping and garbage collection for wear-leveling. Each layer's attempt to optimize can end up working against, or redundantly duplicating, the layer below or above it, a phenomenon sometimes informally called the "log on log" or "stacked log" problem, and it's a genuine source of unexpected write amplification in systems that look efficient at any single layer in isolation.

<<<SECTION 14>>>
### LLAMA and mindful stacking

LLAMA (a Latch-free, Log-structured, Access-method Aware storage engine, developed alongside the Bw-tree research at Microsoft) is a direct response to this log stacking problem. Rather than building a latch-free structure like the Bw-tree on top of a generic, unaware filesystem or block storage layer, LLAMA was designed as a storage layer specifically aware of the access method above it (the Bw-tree's delta-chain, page-mapping-table structure), allowing it to manage flushing, compaction, and space reclamation with direct knowledge of how the layer above actually uses and invalidates data.

This "mindful stacking" approach, designing adjacent layers of a storage stack with awareness of each other rather than treating each layer as a fully opaque black box, is a recurring theme in more recent storage engine research. Instead of stacking independently-optimized generic layers (database, on a generic filesystem, on a generic block device) and accepting the compounded overhead described above, mindful stacking argues for either collapsing layers together (letting the database manage raw block devices or raw flash directly, bypassing the filesystem layer entirely, an approach some specialized systems take) or at minimum making adjacent layers aware enough of each other's behavior to avoid redundant work, like duplicate garbage collection passes, or duplicate journaling of the same logical change.

That's it for Databases in Depth!!

Across these three parts, a consistent thread runs through every topic covered: physical constraints (disk versus memory latency, page-based I/O, sequential versus random access, CPU cache hierarchies) drive almost every meaningful design decision in database internals. The classical B-tree, its more exotic variants (copy-on-write, Bw-trees, cache-oblivious layouts), and the entire log-structured storage family (LSM trees, FD-trees, and the layered systems built around them) are all, ultimately, different answers to the same underlying question: given the real, physical cost of moving data, how do you organize it so that reads, writes, and space usage are each as efficient as your workload actually needs them to be.

There is no universally correct answer, only tradeoffs, read-optimized against write-optimized, simplicity against raw throughput, latch-based correctness against lock-free complexity, and understanding those tradeoffs, rather than memorizing which specific database uses which specific structure, is what actually transfers when you're evaluating unfamiliar systems or making architectural decisions of your own. That, more than any single structure covered across these three parts, is the real goal of going this deep into databases.

That's all, folks..Cheers!!
