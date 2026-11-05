# Databases in Depth Part-1

<<<SECTION 1>>>
## Databases in Depth: Part 1 (Foundations, Storage, and B-Trees)

This is part of a backend-engineering series: a 3-article sub-series called "Databases in Depth".

Databases are the backbone of almost every system, yet most engineers understand them only at the surface: what happens when a row is written to disk, or how a query is answered in milliseconds. The goal is not to write a database engine from scratch, but to build real intuition for choices like Postgres vs Cassandra, or why a B-tree index isn't helping a query.

Part 1 covers how database systems are structured internally, the fundamental tradeoffs in how data is stored and organized, and the B-tree, the data structure behind most production database indexes.

<<<SECTION 2>>>
## DBMS Architecture

A Database Management System (DBMS) is a layered system, not a monolith. Most DBMSs have these components:

- **Query Processor:** the entry point.
  - Parser: turns SQL into an abstract syntax tree.
  - Query optimizer: picks the most efficient execution (join orders, index usage, access paths).
  - Query executor: runs the chosen plan.
- **Storage Engine:** does the physical work: data layout on disk or in memory, index structure, transaction execution, concurrent access. Usually split into:
  - Access methods (how data and indexes are read and written: B-trees, LSM trees, hash indexes)
  - Buffer manager (in-memory cache of disk pages)
  - Transaction manager (atomicity, isolation, locking, MVCC)
  - Recovery manager (write-ahead logging, checkpointing, crash recovery)
- **Client Communication Layer:** connections, authentication, and the wire protocol for clients (drivers, ORMs, applications).

Why the layering matters: most of the decisions that differentiate MySQL, Postgres, Cassandra, and RocksDB happen inside the storage engine. That is where physics meets software: disk seek times, page sizes, and cache locality don't care about SQL syntax.

A DBMS is a translator between a **logical model** (tables, rows, relationships) and a **physical model** (bytes on disk or in memory, organized for efficient reads and writes). Database internals are about managing that translation efficiently.

<<<SECTION 3>>>
## Memory vs Disk-Based DBMS

A foundational decision is whether data lives primarily in memory or primarily on disk.

### Disk-based DBMS

Most traditional systems (Postgres, MySQL, Oracle) keep data on disk (SSD or, historically, spinning HDD) and cache portions in memory as needed. This dominates because disk is cheap and durable, while memory is expensive and volatile: you can't keep terabytes in RAM for most workloads, and you can't lose data on power loss.

The core challenge: disk I/O is orders of magnitude slower than memory. A random SSD read costs tens of microseconds, a random HDD read several milliseconds, a memory access nanoseconds. Buffer pools, indexes, prefetching, sequential write patterns, and compression all exist to reduce how often and how randomly the disk is touched.

Disk-based systems read and write in fixed-size **pages** (commonly 4KB, 8KB, or 16KB), because disks are efficient at contiguous blocks and inefficient at scattered bytes. This shapes almost every other design decision, including B-trees as the default index, since B-trees are designed around page-sized nodes.

### Memory-based (in-memory) DBMS

In-memory databases (Redis, Memcached, SAP HANA, VoltDB) keep the primary copy entirely in RAM. Removing disk I/O from the hot path gives latencies in microseconds rather than milliseconds.

The problem is durability: RAM is volatile, so a crash or power loss loses data. Most solve this with one or both of:

- **Snapshotting**: periodically writing a full copy of memory to disk (Redis RDB snapshots).
- **Write-ahead logging (append-only logs)**: sequentially logging every write so state can be rebuilt by replay (Redis AOF).

Sequential disk writes are much faster than random ones, so these systems keep disk interaction sequential and infrequent.

**Tradeoff:** cost, durability, and dataset size vs speed. In-memory is extremely fast but limited by how much RAM you pay for, and durability needs extra engineering. Disk-based scales to far larger datasets economically, with higher and less predictable latency.

Most production systems are hybrids: a disk-based DBMS with a large buffer pool is "mostly in memory" for hot data and falls back to disk for cold data. Knowing where your working set sits relative to available RAM is one of the most important tuning exercises.

<<<SECTION 4>>>
## Column-Oriented vs Row-Oriented DBMS

This is about physical layout: how a table's values are arranged as bytes on disk.

### Row-oriented storage

All values of a single row are stored contiguously.

Row 1: \[id=1, name="Harry", age=24, city="Jammu"\]  
Row 2: \[id=2, name="Aditya", age=24, city="Delhi"\]

On disk: 1, Harry, 24, Jammu, 2, Aditya, 24, Delhi, ...

Good for **OLTP** (Online Transaction Processing): "fetch a user record and all fields" or "insert a new order". Reading or writing a full record usually touches one disk location. Postgres, MySQL, and most traditional relational databases default to this.

Weakness: analytics. Averaging age over a million rows still reads every full row (including name and city), wasting I/O.

### Column-oriented storage

Values of the same column across all rows are stored together.

id column:   1, 2, 3, ...  
name column: Harry, Aditya, Yash, ...  
age column:  24, 24, 22, ...

Good for **OLAP** (Online Analytical Processing): aggregations and scans over a few columns across huge numbers of rows. You read only the needed column's contiguous data.

Column stores also compress much better, since values in one column are far more similar than values across a mixed row (e.g. run-length encoding a column of repeated country codes vs compressing a jumbled row of unrelated types). Hence Redshift, ClickHouse, BigQuery, Cassandra's SSTable format, and Parquet files lean column-oriented.

Tradeoff (mirror of row-stores): reading or writing one complete row is expensive, since its values are scattered across many column files and need multiple seeks to reassemble. Poor fit for OLTP with many small single-row reads/writes.

Rule of thumb: "everything about one entity" means row-oriented; "one attribute across millions of entities" means column-oriented. Most real systems need both, which is why the OLTP/OLAP split and ETL pipelines between them exist, and why hybrid formats (HTAP systems) are an active research area.

<<<SECTION 5>>>
## Data Files and Index Files

To find specific data without scanning everything, databases separate data files from index files.

- **Data files** hold the actual records, the full rows (or columns). This is the primary, authoritative copy.
- **Index files** map a search key (primary key or indexed column) to the record's location in the data file. They store only the key plus a pointer or offset, not the full row.

### Clustered vs non-clustered indexes

A **clustered index** determines the physical order of rows on disk. Only one per table (usually the primary key), since rows can be physically sorted only one way. Queries on its key allow efficient range scans because matching rows are adjacent. InnoDB (MySQL) does this by default, storing the whole row in the leaf nodes of the primary key's B-tree.

A **non-clustered index** is a separate structure that doesn't affect row order. It stores the key plus a pointer (or, in some systems, the primary key value) to the row. A table can have many. Cost: an extra indirection, one lookup in the index then a second in the data file, unless the index is **covering** (contains every column the query needs, avoiding the second lookup).

### Primary vs secondary index files

A related framing from storage engine literature:

- **Primary index**: built on the key that determines the data file's physical sort order (similar to clustered).
- **Secondary index**: built on any other field; always needs an indirection step, since the data file isn't ordered by that field.

Key insight: indexes trade extra storage and write overhead for much faster reads. Every index must be updated on every insert, update, and delete, so over-indexing hurts write throughput while helping read latency. Choosing columns to index means choosing which query patterns to optimize at the cost of others.

<<<SECTION 6>>>
## Buffering, Immutability, and Ordering

These three concepts explain much of database engineering: why LSM trees exist, why write-ahead logs are sequential, and why immutable data structures are common in modern storage engines.

### Buffering

Almost every database places a memory buffer between the application and disk, for two purposes:

- **Reads:** a **buffer pool (page cache)** keeps recently and frequently accessed pages in memory. Eviction policies (LRU, LFU, or hybrids like Postgres's clock-sweep algorithm) decide what stays when it fills.
- **Writes:** buffering lets the database **batch and reorder writes**, turning many small random writes into fewer, larger, sequential ones. Sequential writes are much faster on both SSDs and HDDs, making this one of the biggest levers in write performance. It's the core idea behind memtables in LSM-tree systems (covered in a later part) and why write-ahead logs are sequential appends rather than in-place modifications.

Risk: durability. Data in memory before flushing can be lost in a crash. Write-ahead logging solves this: log the intent to disk sequentially and durably first, then apply the (possibly buffered, reordered) changes to data files later. After a crash, replay the log to reconstruct unflushed state.

### Immutability

Many modern storage engines use immutable data: never modified in place. An update writes a new version and marks the old one obsolete. Reasons:

- **Simpler concurrency.** Readers never see data mutated mid-read, so readers need no locks. This is the basis of MVCC (Multi-Version Concurrency Control), used by Postgres, MySQL InnoDB, and others: readers see a consistent snapshot without blocking writers.
- **Simpler crash recovery.** Immutable, append-only files can't be left half-written and corrupted like in-place updates. A new file/segment either exists or doesn't.
- **Sequential I/O by default**, since new segments are appended instead of scattered in-place updates.

Tradeoff: garbage. Old versions pile up and must be reclaimed via compaction (LSM trees) or vacuuming (Postgres MVCC). Immutability doesn't remove the cost of change; it defers and batches it into a background process instead of paying inline on every write.

### Ordering

Keeping data ordered, physically on disk or logically in an index, enables range queries, sorted scans, and efficient merging.

Because sequential access beats random access, databases keep related data adjacent and sorted: clustering rows by primary key, sorting SSTable segments by key in LSM trees, keeping sorted keys within B-tree nodes. Sorted data enables efficient merges, which is how LSM-tree compaction works: merging multiple sorted runs into one, like the merge step in merge sort.

In short: **buffering** is about when writes hit disk, **immutability** about whether existing data changes, and **ordering** about how data is arranged to be found and merged efficiently. These recur across very different storage engines.

<<<SECTION 7>>>
## Binary Search Trees: The Starting Point

B-trees are best understood as an adaptation of the binary search tree (BST) to disk.

A BST node has at most two children; the left subtree holds only smaller values, the right only larger. Applied recursively, this gives O(log n) search, insert, and delete in a balanced tree, since each comparison eliminates about half the remaining search space.

The problem with plain BSTs (and balanced variants like AVL or red-black trees) is the implicit assumption that random access to any node is equally cheap. True in memory; false on disk.

A binary tree with a million entries has about 20 levels (log2 of a million is about 20). If each node sits at an effectively random disk location, one search may need up to 20 disk seeks, each potentially milliseconds. That is disastrously slow.

This motivates B-trees: how to get logarithmic search while minimizing **disk accesses** (not just comparisons), given that disks work in fixed-size pages and reading a whole page costs about the same as reading one byte from it.

<<<SECTION 8>>>
## Disk-Based Structures and the Page Abstraction

The key physical constraint on index structures: disks (and SSDs, to a lesser extent) are inefficient at reading or writing small arbitrary amounts of data. Storage operates in fixed-size blocks, or pages, commonly 4KB, 8KB, or 16KB.

So **the meaningful cost unit isn't "nodes visited", it's "pages read from disk."** Twenty pointer hops through tiny nodes, each on a separate page, is far worse than 3 hops through large page-sized nodes, even if the latter examines more keys per step.

This leads to B-trees: instead of one key and two children per node (BST), a B-tree node fills an entire disk page with many keys and children. If a page holds, say, 100 keys and 101 child pointers, the same million-row dataset might need only 3 levels instead of 20, because the branching factor per level is huge instead of 2.

The trick: trade "few keys, many levels" (BST) for "many keys per node, few levels" (matching disk pages), minimizing expensive disk reads per operation.

<<<SECTION 9>>>
## B-Trees: The Ubiquitous Index Structure

A B-tree (specifically the **B+tree** variant, which almost every real database uses) is a self-balancing tree designed around page-based disk storage. Properties:

- Each node (page) holds multiple sorted keys plus pointers to child nodes.
- All leaves are at the same depth, so the tree is perfectly balanced and every lookup takes the same predictable number of disk reads.
- Nodes have a minimum and maximum number of keys (the tree's "order" or "fanout"). On insert overflow, a node splits in two and pushes a key up to the parent. On delete underflow, it borrows from or merges with a sibling.
- In B+trees, all data (or row pointers) lives only in leaves. Internal nodes hold only routing keys, which maximizes their fanout, fits more keys per page, and reduces tree height.
- B+tree leaves are linked in a sorted doubly (or singly) linked list, making range queries ("rows where age is between 20 and 30") efficient: find the start, then walk the leaves in order instead of re-traversing the tree.

### Why B-trees won

B-trees are the near-universal default index (Postgres, MySQL/InnoDB, Oracle, SQL Server, SQLite, and more) because of:

1. **Logarithmic height with huge fanout.** Nodes hold hundreds of keys (page-sized), so even billions of rows need only 3 to 4 levels, i.e. 3 to 4 disk reads per lookup. Top levels stay cached in memory (small, frequently accessed), so real lookups often cost just 1 or 2 disk reads.
2. **Balanced by construction.** Splits and merges keep balance automatically, with no pathological case like an unbalanced BST degenerating into a linked list.
3. **Excellent range queries** via linked leaves, critical since range scans (WHERE age BETWEEN 20 AND 30, ORDER BY created_at) are very common.
4. **In-place updatability.** Unlike LSM trees (covered later; they favor write throughput via immutable, append-only structures merged in the background), B-trees update in place. This keeps reads predictable and consistent, at some cost to raw write throughput. A strong general-purpose default for read-heavy or mixed workloads, which describes most OLTP systems.
5. **Decades of maturity.** Studied and optimized since the 1970s. Concurrency control (e.g. latch crabbing), crash recovery integration, and bulk-loading techniques are mature and well understood, which matters for production engines.

**Core tradeoff:** B-trees optimize read latency and predictable in-place updates by paying on writes (updates may cascade into page splits or merges). LSM trees are the opposite: they optimize write throughput by deferring and batching data organization (background compaction) at the cost of read amplification. B-trees vs LSM trees is one of the key dividing lines in storage engine design, and is where Part 2 picks up.

Everything here (architecture layering, memory vs disk, row vs column layout, indexing, buffering, immutability, ordering, B-trees) comes back to one theme: **physical constraints shape logical design.** A database looks the way it does because of what disks and memory are good and bad at, and decades of engineering to minimize the gap between them.
