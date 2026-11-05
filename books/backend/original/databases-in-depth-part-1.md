# Databases in Depth Part-1

<<<SECTION 1>>>
## Databases in Depth: Part 1 (Foundations, Storage, and B-Trees)

Hey, legends! I'm finally continuing my backend-engineering series. So, this will be a sub-series called "Databases in Depth"(It'll have 3 articles). Hopefully you'll find this helpful!

As we know, databases are the quiet backbone of almost every system we build. We interact with them constantly, we tune them, we curse them at 3 AM during an incident, yet most engineers carry only a surface-level understanding of what actually happens when a row gets written to disk or a query gets answered in milliseconds. This series is an attempt to go deeper. This series is an attempt to go deeper and understand the internals of our very own Databases. Perhaps not deep enough to write a database engine from scratch (although that is a fun exercise too), but deep enough that the next time you pick Postgres over Cassandra, or wonder why your B-tree index isn't helping your query, you have real intuition instead of folklore.

This part 1 covers the groundwork like how database systems are structured internally, the fundamental tradeoffs in how data is stored and organized, and the data structure that underpins the vast majority of database indexes in production today, the B-tree.

<<<SECTION 2>>>
## DBMS Architecture

A Database Management System (DBMS) is not a monolith. It is a layered system, and understanding those layers is the first step to understanding everything else.

At a high level, most DBMSs are organized into the following components:

**Query Processor:** This is the entry point. It includes the parser (turns your SQL into an abstract syntax tree), the query optimizer (decides the most efficient way to execute that query, choosing join orders, index usage, and access paths), and the query executor (actually runs the chosen plan).

**Storage Engine:** This is where the real physical work happens. It manages how data is laid out on disk or in memory, how indexes are structured, how transactions are executed, and how concurrent access is handled. The storage engine is usually further split into:

- Access methods (how data and indexes are read and written, B-trees, LSM trees, hash indexes)
- Buffer manager (manages the in-memory cache of disk pages)
- Transaction manager (handles atomicity, isolation, locking, MVCC)
- Recovery manager (write-ahead logging, checkpointing, crash recovery)

**Client Communication Layer:** Handles connections, authentication, and the wire protocol used to talk to clients (drivers, ORMs, applications).

Now, you can ask "why all of this layering"? Because most of the interesting engineering decisions and tradeoffs, the ones that actually differentiate MySQL from Postgres from Cassandra from RocksDB, happen inside the storage engine. The query processor is important, but the storage engine is where physics meets software. Disk seek times, page sizes, cache locality, none of that cares about your SQL syntax.

You can think of a DBMS as a translator between a logical model (tables, rows, relationships, the mental model your application cares about) and a physical model (bytes on a disk or in memory, organized to be read and written efficiently). Everything in database internals is really about managing that translation as efficiently as possible.

<<<SECTION 3>>>
## Memory vs Disk-Based DBMS

One of the most foundational architectural decisions a database makes is where the data actually lives, primarily in memory, or primarily on disk.

### Disk-based DBMS

Most traditional systems (Postgres, MySQL, Oracle) are disk-based. Data lives on disk (SSD or, historically, spinning HDD), and portions of it are cached in memory as needed. The reason this model dominates is simple: disk is cheap and durable, memory is expensive and volatile. You cannot afford to keep terabytes of data in RAM for most workloads, and you cannot afford to lose data when the power goes out.

The core challenge for disk-based systems is that disk I/O is orders of magnitude slower than memory access. A random read from SSD might cost tens of microseconds, a random read from spinning disk might cost several milliseconds, while a memory access costs nanoseconds. This gap is the reason so much database engineering exists purely to minimize disk I/O: buffer pools, indexes, prefetching, sequential write patterns, and compression all exist to reduce how often and how randomly we touch the disk.

Disk-based systems typically read and write data in fixed-size chunks called pages (commonly 4KB, 8KB, or 16KB), because disks are efficient at reading contiguous blocks and inefficient at reading scattered individual bytes. This page-based thinking cascades through almost every other design decision in the system, including the choice of B-trees as the default index structure, since B-trees are explicitly designed around page-sized nodes.

### Memory-based (in-memory) DBMS

In-memory databases (Redis, Memcached, SAP HANA, VoltDB) keep the primary copy of data entirely in RAM. This eliminates disk I/O from the read/write hot path entirely, which is why in-memory systems can achieve latencies in microseconds rather than milliseconds.

The obvious problem is durability. RAM is volatile, so a crash or power loss means data loss unless the system does something about it. Most in-memory databases solve this with one or both of:

- **Snapshotting**: periodically writing a full copy of memory to disk (Redis RDB snapshots).
- **Write-ahead logging (append-only logs)**: logging every write operation to disk sequentially, so state can be reconstructed by replaying the log (Redis AOF).

Sequential disk writes are much faster than random ones, so even in-memory systems that need durability try to make disk interaction as sequential and infrequent as possible.

The tradeoff is fundamentally about cost, durability, and dataset size versus speed. In-memory systems are extremely fast but limited by how much RAM you're willing to pay for, and durability requires extra engineering. Disk-based systems can scale to far larger datasets economically, at the cost of higher and less predictable latency.

In practice, most production systems are hybrids. A disk-based DBMS with a large buffer pool cache is functionally "mostly in memory" for hot data, while falling back to disk for cold data. Understanding where your working set sits relative to your available RAM is one of the most important tuning exercises you can do.

<<<SECTION 4>>>
## Column-Oriented vs Row-Oriented DBMS

This is about physical layout: given a table with rows and columns, how do you actually arrange those values as bytes on disk?

### Row-oriented storage

In a row-store, all the values belonging to a single row are stored contiguously.

Row 1: \[id=1, name="Harry", age=24, city="Jammu"\]  
Row 2: \[id=2, name="Aditya", age=24, city="Delhi"\]

On disk, this looks like: 1, Harry, 24, Jammu, 2, Alice, 24, Delhi, ...

This layout is excellent for OLTP (Online Transaction Processing) workloads, the classic "fetch a user record and all their fields" or "insert a new order" type queries. Since an entire row is stored together, reading or writing a full record typically requires touching just one location on disk. This is why Postgres, MySQL, and most traditional relational databases default to row-oriented storage.

The weakness shows up in analytical queries. If you want to compute the average age across a million rows, a row-store still has to read every row in full (including name and city, which you don't care about) just to extract the age column. That is a lot of wasted I/O.

### Column-oriented storage

In a column-store, values from the same column across all rows are stored together.

id column:   1, 2, 3, ...  
name column: Harry, Aditya, Yash, ...  
age column:  24, 24, 22, ...

This layout is excellent for OLAP (Online Analytical Processing) workloads, aggregations, scans over a small subset of columns across huge numbers of rows. If you only need the age column, you read only the age column's data, contiguous on disk, and skip everything else entirely.

Column stores also compress dramatically better than row stores, because values within a single column tend to be far more similar to each other than values across a mixed row (imagine run-length encoding a column of repeated country codes versus trying to compress a jumbled row of unrelated types). This is why systems like Redshift, ClickHouse, BigQuery, Cassandra's SSTable format, and Parquet files lean column-oriented.

The tradeoff is the mirror image of row-stores: writing or reading a single complete row in a column-store is expensive, because that row's values are scattered across many separate column files, requiring multiple seeks to reassemble. This is why column-stores are a poor fit for OLTP workloads with lots of small single-row reads and writes.

If your access pattern is "give me everything about this one entity," think row-oriented. If your access pattern is "give me one attribute across millions of entities," think column-oriented. Most real systems eventually need both, which is part of why the OLTP/OLAP split and ETL pipelines between them exist in the first place, and why hybrid formats (HTAP systems) are an active area of database research.

<<<SECTION 5>>>
## Data Files and Index Files

Once you decide how rows and columns are physically laid out, you need a way to actually find a specific piece of data without scanning the entire dataset. This is where the distinction between data files and index files comes in.

Data files hold the actual records, the full rows (or columns) of your table. Think of this as the primary, authoritative copy of your data.

Index files are auxiliary structures that map a search key (like a primary key, or an indexed column) to the location of the corresponding record in the data file. An index does not store the full row; it stores just enough information (the key, plus a pointer or offset) to jump directly to where the full record lives.

Two important variants show up here:

### Clustered vs non-clustered indexes

A clustered index determines the actual physical order in which rows are stored on disk. There can only be one clustered index per table (usually the primary key), because rows can only be physically sorted one way at a time. When you query using the clustered index's key, the database can do a very efficient range scan, since the rows you want are physically adjacent on disk. InnoDB (MySQL) organizes tables this way by default, storing the whole row directly in the leaf nodes of the primary key's B-tree.

A non-clustered index is a separate structure that does not affect physical row order. It stores the index key alongside a pointer (or in some systems, the primary key value) that lets you look up the actual row elsewhere. You can have many non-clustered indexes on a table. The cost is an extra indirection: finding a row via a non-clustered index typically means one lookup in the index structure, followed by a second lookup in the data file to fetch the actual row, unless the index is "covering" (contains every column the query needs, avoiding the second lookup entirely).

### Primary vs secondary index files

This is a closely related but slightly different framing, common in storage engine literature. A **primary index** is built on the same key that determines the data file's physical sort order (similar to a clustered index). A **secondary index** is built on any other field, and always requires an indirection step to get from the indexed key to the actual record, since the data file isn't ordered by that field.

The core insight to take away is this: indexes trade extra storage and write overhead for dramatically faster reads. Every index you add has to be updated on every insert, update, and delete to the underlying table, which is why over-indexing hurts write throughput even though it helps read latency. Choosing which columns to index is really choosing which query patterns you're willing to optimize for at the cost of others.

<<<SECTION 6>>>
## Buffering, Immutability, and Ordering

These three concepts are less visible than "B-tree" or "column store," but they quietly explain a huge amount of database engineering, from why LSM trees exist to why write-ahead logs are sequential to why "immutable" data structures are suddenly everywhere in modern storage engines.

### Buffering

Disk I/O is expensive, and RAM is fast, so almost every database sits a memory buffer between the application and the disk. This buffer serves two purposes.

On the read side, a **buffer pool (or page cache)** keeps recently and frequently accessed disk pages in memory, so repeated reads don't have to hit disk again. Eviction policies (LRU, LFU, or hybrids like Postgres's clock-sweep algorithm) decide what stays in memory when it fills up.

On the write side, buffering lets a database **batch and reorder writes** before they hit disk, converting what would otherwise be many small random writes into fewer, larger, sequential writes. Since sequential writes are dramatically faster than random writes on both SSDs and HDDs, this batching is one of the single biggest levers in database write performance. This is essentially the core idea behind memtables in LSM-tree based systems (more on this in a future part), and it's also why write-ahead logs are structured as simple sequential append operations rather than in-place modifications.

The obvious risk buffering introduces is durability: if data sits in memory before being flushed to disk, a crash can lose it. This is precisely why write-ahead logging exists, log the intent to disk sequentially and durably first, then apply the actual (possibly buffered, possibly reordered) changes to the data files later. If a crash happens, the log can be replayed to reconstruct any state that hadn't yet been flushed.

### Immutability

A growing number of modern storage engines lean heavily on immutable data structures, data that, once written, is never modified in place. Instead of updating a value, you write a new version and mark the old one as obsolete.

A few reasons for this:

- **Concurrency becomes dramatically simpler.** If data never changes after being written, readers never need to worry about a writer mutating something out from under them mid-read. No locking is needed for readers, since there's nothing to race with. This is the foundation of MVCC (Multi-Version Concurrency Control), used by Postgres, MySQL InnoDB, and many others, where readers see a consistent snapshot without blocking writers.
- **Crash recovery becomes simpler.** Immutable, append-only files can't be left in a "half-written, corrupted" state the way in-place updates can. Either a whole new file/segment exists, or it doesn't.
- **Sequential I/O becomes the default write pattern**, since new immutable segments are appended rather than scattered updates being made in place, again playing directly into the disk performance characteristics discussed earlier.

The tradeoff is that immutability creates garbage: old versions of data pile up and need to be reclaimed eventually, through processes like compaction (in LSM trees) or vacuuming (in Postgres's MVCC implementation). Immutability doesn't eliminate the cost of change, it defers and batches that cost into a background process instead of paying it inline on every write.

### Ordering

Keeping data in some defined order, whether physically on disk or logically within an index, is what makes range queries, sorted scans, and efficient merging possible.

Ordering interacts directly with the previous two ideas. Because sequential access is so much faster than random access, databases go out of their way to keep related data physically adjacent and sorted, whether that's clustering rows by primary key, sorting SSTable segments by key in an LSM tree, or maintaining sorted keys within B-tree nodes. Sorted data also enables efficient merge operations, which is exactly how LSM-tree compaction works, merging multiple sorted runs into one, similar in spirit to a merge step in merge sort.

Put simply: buffering deals with when writes hit disk, immutability deals with whether existing data changes, and ordering deals with how data is arranged so it can be found and merged efficiently. These three ideas recur constantly across very different storage engines, and once you see them clearly, a lot of "why does this database work this way" questions start answering themselves.

<<<SECTION 7>>>
## Binary Search Trees: The Starting Point

Before we can appreciate why B-trees dominate database indexing, it's worth revisiting binary search trees (BSTs), because B-trees are best understood as an adaptation of the same core idea to a very different environment: disk.

A BST is a tree where each node has at most two children, the left subtree contains only values less than the node, and the right subtree contains only values greater than the node. This invariant, applied recursively, gives you O(log n) search, insert, and delete in a balanced tree, since each comparison eliminates roughly half the remaining search space.

The problem with plain BSTs (and even balanced variants like AVL trees or red-black trees) is that they're designed with an implicit assumption: that random access to any node is roughly equally cheap. That assumption holds true in memory, where jumping between arbitrary memory addresses is fast. It falls apart completely on disk.

A binary tree with a million entries has roughly 20 levels (log2 of a million is about 20). If each node lives at a different, effectively random location on disk, then a single search could require up to 20 separate disk seeks, each potentially costing milliseconds. Twenty random disk seeks for a single lookup is disastrously slow compared to what a well-designed disk-based structure should achieve.

This is the core motivating problem for B-trees: how do you get logarithmic search behavior while minimizing the number of disk accesses (not just the number of comparisons), given that disks are read and written in fixed-size pages, and a single disk read of a whole page costs roughly the same as reading a single byte from that page?

<<<SECTION 8>>>
## Disk-Based Structures and the Page Abstraction

The single most important physical constraint shaping index structures is this: disks (and even SSDs, to a lesser extent) are not efficient at reading or writing arbitrary small amounts of data. Instead, storage systems operate in terms of fixed-size blocks, or pages, commonly 4KB, 8KB, or 16KB.

This has a direct consequence for data structure design: **the meaningful unit of cost for a disk-based structure isn't "how many nodes did I visit," it's "how many pages did I read from disk."** A structure that requires 20 pointer hops through tiny individual nodes, each a separate disk page, is far worse than a structure that requires 3 hops through large, page-sized nodes, even if the second structure examines more individual keys per step.

This reframing leads directly to the design of B-trees: instead of a node holding just one key and two children (as in a BST), a B-tree node is sized to fill an entire disk page, holding many keys and many children at once. If a page can hold, say, 100 keys and 101 child pointers, then a B-tree of the same million-row dataset might need only 3 levels instead of 20, because the "branching factor" per level is enormous instead of just 2.

This is the fundamental trick: B-trees trade "few keys, many levels" (as in a BST) for "many keys per node, few levels" (matching the page-based reality of disk), directly minimizing the number of expensive disk reads needed per operation.

<<<SECTION 9>>>
## B-Trees: The Ubiquitous Index Structure

A B-tree (specifically, the B+tree variant, which is what almost every real database actually uses) is a self-balancing tree structure designed explicitly around the page-based nature of disk storage. Its properties:

- Each node (page) holds multiple keys, sorted in order, along with pointers to child nodes.
- All leaf nodes are at the same depth, keeping the tree perfectly balanced, so every lookup takes the same, predictable number of disk reads.
- Nodes have a minimum and maximum number of keys they can hold (often called the "order" or "fanout" of the tree). When a node overflows past its maximum on insert, it splits into two nodes and pushes a key up to the parent. When a node underflows past its minimum on delete, it borrows from or merges with a sibling.
- In the B+tree variant specifically, all actual data (or pointers to actual rows) lives only in the leaf nodes. Internal (non-leaf) nodes hold only keys used for routing/navigation, not data. This maximizes the fanout of internal nodes, since they don't waste space storing row data, letting more keys fit per page and further reducing tree height.
- Leaf nodes in a B+tree are additionally linked together in a sorted, doubly (or singly) linked list. This makes range queries ("find all rows where age is between 20 and 30") extremely efficient, since after finding the starting point, you simply walk the linked leaves in order rather than re-traversing the tree.

This most interesting question : "Why B-trees specifically won?"

It's worth being explicit about why B-trees, rather than some other disk-friendly structure, became the near-universal default for database indexes (used by Postgres, MySQL/InnoDB, Oracle, SQL Server, SQLite, and many more):

1. **Logarithmic height with a huge fanout.** Because each node holds hundreds of keys (sized to a disk page), even datasets with billions of rows typically need only 3 to 4 levels of tree traversal, meaning 3 to 4 disk reads for any lookup. In practice, the top levels of the tree stay cached in memory (they're small and frequently accessed), so a real-world lookup often costs just 1 or 2 actual disk reads.
1. **Balanced by construction.** Splits and merges during inserts and deletes automatically maintain balance, so there's never a pathological worst case like an unbalanced BST degenerating into a linked list.
1. **Excellent range query support**, thanks to the linked-leaf structure of B+trees, which is critical since range scans (WHERE age BETWEEN 20 AND 30, ORDER BY created_at) are extremely common in real workloads.
1. **In-place updatability.** Unlike LSM trees (which we'll cover in a later part, and which favor write throughput via immutable, append-only structures merged in the background), B-trees update data in place, which keeps read performance highly predictable and consistent, at some cost to raw write throughput compared to LSM-based designs. This makes B-trees a strong general-purpose default, particularly for read-heavy or mixed workloads, which describes the majority of OLTP systems.
1. **Decades of maturity.** B-trees have been studied and optimized since the 1970s. The engineering around them, concurrency control (latch crabbing, for instance), crash recovery integration, and bulk-loading techniques, is extremely mature and well understood, which matters enormously for production-grade database engines.

The core tradeoff to internalize: B-trees optimize for read latency and predictable, in-place updates by paying a cost on writes (since updates may cascade into page splits or merges). This is the mirror opposite of LSM trees, which optimize heavily for write throughput by deferring and batching the cost of organizing data (via background compaction) at the expense of read amplification. That contrast, B-trees versus LSM trees, is one of the most important dividing lines in modern storage engine design, and it's exactly where Part 2 of this series will pick up.

Everything covered here, architecture layering, memory versus disk tradeoffs, row versus column layout, indexing, buffering, immutability, ordering, and finally B-trees, all comes back to one recurring theme: **physical constraints shape logical design.** The reason your database looks the way it does isn't arbitrary. It's a direct consequence of what disks are good and bad at, what memory is good and bad at, and decades of engineering aimed at minimizing the gap between the two.

Stay Tuned for the next 2 parts and my other articles!

Like, comment, repost and share if you found it useful!

That's all, folks...Cheers!!
