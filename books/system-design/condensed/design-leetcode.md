# Design Leetcode

<<<SECTION 1>>>
## 1. Requirements

**Functional:**
- Problem catalog (list; filter by difficulty, category, company tag; paginated)
- Multi-language code editor
- Run Code against visible test cases
- Submit and judge against hidden test cases
- Contests (timed submissions, real-time leaderboard)
- User profile (submission history, solved problems, rating, streak, contest history)
- Per-problem discussion forum (comments, solutions)

**Out of scope:** premium subscriptions, mock interviews, study plans, video explanations, company-specific question sets, Judge0 internals (black box).

**Non-functional:**
- Strong isolation: user code must never affect host infrastructure
- Run Code results within 1-2 s
- Submit verdict within 2-5 s
- Real-time contest leaderboard
- High availability for the read-heavy, latency-sensitive catalog and editor
- Handle contest spikes of ~170 submissions/s
- Exactly-once submission processing: never judged twice

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 5 million
- **Active problems:** 4000
- **Submissions:** ~20% of DAU submit at least once = 1M/day
- **Run Code:** ~5x submissions = 5M/day
- **Code size:** ~10 KB per submission, so ~10 GB/day (1M x 10 KB)
- **Test cases:** avg 50 per problem x 4000 = 200,000 files in S3
- **Contest participants:** ~50,000 concurrent per major contest
- **Contest peak:** 50,000 users submitting once per 5 minutes = ~170 submissions/s
- **Leaderboard:** 50,000 entries per contest sorted set in Redis

Storage is modest versus media platforms. The dominant challenges are code execution isolation and the contest write spike; hardest is running untrusted code safely with near-real-time verdicts.

## 3. API Gateway

Handles authentication, rate limiting, and routing. During contests it adds **contest-specific rate limiting**: one submission per problem per 30 seconds per user, preventing users from flooding/gaming the judge queue without affecting legitimate use.

<<<SECTION 3>>>
## 4. User Profile Service

Manages identity, submission history, solved problems, contest history, and rating.

### Users Table (PostgreSQL)

- user_id UUID, PK
- username VARCHAR, unique
- email VARCHAR, unique
- password_hash VARCHAR
- profile_pic_url TEXT
- rating INTEGER (starts at 1500, Elo-style)
- max_rating INTEGER
- problems_solved, easy_solved, medium_solved, hard_solved, submission_count INTEGER
- acceptance_rate FLOAT
- streak_days INTEGER
- last_active, created_at TIMESTAMP

problems_solved, easy/medium/hard_solved, submission_count, and acceptance_rate are **denormalized counters** updated asynchronously by Kafka consumers when submissions are judged. Scanning Submissions on every profile load would be too slow.

### ContestHistory Table (PostgreSQL)

- history_id UUID, PK
- user_id UUID, FK -> Users
- contest_id UUID, FK -> Contests
- rank, problems_solved, total_penalty, rating_change INTEGER
- attended_at TIMESTAMP

### SolvedProblems Table (PostgreSQL)

- user_id UUID, FK -> Users
- problem_id UUID, FK -> Problems
- solved_at TIMESTAMP
- language VARCHAR
- PRIMARY KEY (user_id, problem_id)

The unique PK on (user_id, problem_id) marks a problem solved only once, regardless of how many accepted submissions exist.

### Caching Strategy

Profiles (among the most viewed pages) are cached in Redis with a short TTL. Per-user solved sets are also cached, since every problem list page checks them to show green checkmarks.

<<<SECTION 4>>>
## 5. Problem Catalog Service

The most read-heavy service: users browse (filter, sort, search) far more than they submit.

### Problems Table (PostgreSQL)

- problem_id UUID, PK
- problem_number INTEGER, unique
- title VARCHAR
- slug VARCHAR, unique
- description TEXT
- difficulty ENUM('easy', 'medium', 'hard')
- acceptance_rate FLOAT
- submission_count, accepted_count INTEGER
- is_premium, is_active BOOLEAN
- created_at TIMESTAMP

### ProblemTopics Table (PostgreSQL)

- problem_id UUID, FK -> Problems
- topic ENUM('array', 'string', 'dp', 'graph', 'tree', 'binary_search', ...)
- PRIMARY KEY (problem_id, topic)

### ProblemCompanies Table (PostgreSQL)

- problem_id UUID, FK -> Problems
- company VARCHAR
- frequency ENUM('very_high', 'high', 'medium', 'low')
- PRIMARY KEY (problem_id, company)

### TestCases Table (S3 + PostgreSQL reference)

- testcase_id UUID, PK
- problem_id UUID, FK -> Problems
- input_s3_url, output_s3_url TEXT
- is_visible BOOLEAN (true for example cases shown to users)
- order_index INTEGER

Content lives in S3; the table stores S3 URLs. Large inputs (e.g. graphs with 100,000 nodes) can be megabytes and would bloat PostgreSQL.

### Pagination and Filtering

GET /v1/problems?page=1&limit=50&difficulty=medium&topic=dp&company=google&status=unsolved

A composite index on (difficulty, is_active, is_premium) covers the common filters. Topic and company filters use the join tables with indexed foreign keys.

The list changes rarely, so full result pages are cached in Redis:
- Key: problems:list:{filter_hash}:{page}
- Value: serialized problem metadata list
- TTL: 10 minutes

filter_hash hashes the filter parameters so each combination gets its own key.

### Test Case Caching

Hot problems (daily challenge, contest problems, NeetCode 150, Blind 75) have test cases preloaded in Redis:
- Key: testcases:{problem_id}
- Value: \[{input: "...", expected_output: "..."}, ...\]
- TTL: 24 hours hot, 1 hour cold

On a miss, the Judge Worker fetches from S3 and populates Redis; later submissions hit Redis. Cold problems (obscure, rarely attempted) are fetched from S3 on demand.

### Bottlenecks in the Catalog Service

List-level Redis caching absorbs most read traffic. The concern is invalidation on problem updates (description fix, new test case): a `problem.updated` Kafka event invalidates all cached list pages containing that problem.

<<<SECTION 5>>>
## 6. Code Execution Pipeline

The most distinctive service among the nine systems in this series: user code must run safely, correctly, and quickly on shared infrastructure.

**Security Isolation Stack.** Running arbitrary code is among the most dangerous things a system does, so every execution gets multiple layers:

**Layer 1 - Non-root process:** runs as an unprivileged user, no sudo, inside the container.

**Layer 2 - seccomp syscall filter:** Linux kernel feature restricting allowed syscalls. Blocked:
- fork (prevents fork bombs)
- socket (no network connections at kernel level)
- exec (no child processes)
- ptrace (no debugging other processes)

**Layer 3 - No network interface:** zero inbound/outbound connectivity; code can't call external APIs or exfiltrate data.

<<<SECTION 6>>>
### Layer 4 - CPU and memory hard limits:

- `--memory="256m"`: max 256MB RAM
- `--cpus="0.5"`: max 50% of one CPU core

Exceeding them kills the container: Memory Limit Exceeded.

**Layer 5 - Wall clock timeout:** hard limit (typically 2-5 s per problem). Infinite loops are killed: Time Limit Exceeded.

**Layer 6 - Read-only filesystem:** except a size-capped /tmp scratch directory. Code can't write to system directories or accumulate disk usage.

**Layer 7 - gVisor sandbox (optional, highest security):** Google's sandboxed runtime intercepts all syscalls in userspace instead of passing them to the host kernel, eliminating container escape risk.

**Two Separate Pipelines: Run Code vs Submit.** Their requirements differ fundamentally, so they must not share a pipeline.

### Run Code Pipeline (lightweight, interactive):

- Triggered by "Run"
- Only 3-5 visible example test cases
- Test cases hardcoded in the Problems metadata cache in Redis; no S3 fetch
- Results expected in 1-2 s
- Kafka topic: `code.run`
- Dedicated Run Workers: lighter limits, faster container spinup
- Results via WebSocket

### Submit Pipeline (heavyweight, authoritative):

- Triggered by "Submit"
- All hidden test cases (50-100+ per problem)
- Test cases from Redis (hot) or S3 (cold)
- Results expected in 2-5 s
- Kafka topic: `code.submitted`
- Dedicated Judge Workers with full security stack
- Full verdict (Accepted, Wrong Answer, TLE, MLE, Runtime Error) + runtime ms + memory KB
- Results via WebSocket

<<<SECTION 7>>>
### Full Submit Flow

1. **Received:** client sends POST /submissions with { user_id, problem_id, language, source_code, contest_id (if in contest) } to the Code Service via API Gateway.
2. **Server-side validation:** language supported; source ≤ 50 KB; if in contest, timestamp within the contest window (server-side, not client-side); user not rate-limited (one submission per problem per 30 s).
3. **Persisted:** Submission record created in PENDING state; submission ID returned immediately.
4. **Kafka event:** `code.submitted` published with submission ID, problem ID, language, and S3 URL of the source.
5. **WebSocket opened:** client subscribes to `submission:{submission_id}` via Redis Pub/Sub; user sees a spinner.
6. **Judge Worker picks up job:** fetches source from S3; test cases from Redis (hit) or S3 (miss, then populates Redis).
7. **Container spun up:** language-specific Docker container with full security stack. Image is pre-warmed, not pulled per submission, to cut startup latency.
8. **Compilation:** compiled languages (C++, Java) compile first; an error ends immediately with Compile Error, no tests run.
9. **Execution:** tests run sequentially; first failure (Wrong Answer, TLE, MLE, Runtime Error) stops execution and reports the failing case. All pass: Accepted.
10. **Container destroyed** immediately; no state persists between submissions.
11. **Result published:** `submission.judged` event to Kafka with full verdict.
12. **Delivered:** a Kafka consumer publishes to Redis Pub/Sub `submission:{submission_id}`; the subscribed WebSocket Server pushes it to the user's connection. Spinner gives way to verdict.
13. **Async DB update:** consumer writes the final verdict to Submissions. If Accepted, publishes `problem.solved`, which triggers profile counter updates (problems_solved, acceptance_rate), a SolvedProblems insert, and, in a contest, a leaderboard update.

<<<SECTION 8>>>
### WebSocket Multi-Server Problem

WebSocket connections are stateful: a user on Server 1 can't receive a push from Server 3. Solution, Redis Pub/Sub:

1. Judge Worker -> Kafka (submission.judged)
2. Kafka consumer -> Redis PUBLISH submission:{submission_id} {verdict}
3. WebSocket Server (subscribed to submission:{submission_id}) -> push to user connection

Each WebSocket server subscribes to channels for its active submissions, so the right instance receives the verdict. No server-to-server communication needed.

**Submissions Table (PostgreSQL)**

- submission_id UUID, PK
- user_id UUID, FK -> Users
- problem_id UUID, FK -> Problems
- contest_id UUID (null if not in contest)
- language VARCHAR
- source_code_url TEXT (S3 URL)
- status ENUM('pending', 'running', 'accepted', 'wrong_answer', 'time_limit_exceeded', 'memory_limit_exceeded', 'runtime_error', 'compile_error')
- runtime_ms, memory_kb, test_cases_passed, total_test_cases INTEGER
- submitted_at, judged_at TIMESTAMP

Source code lives in S3; storing it as text would bloat and slow PostgreSQL. The table keeps only the S3 URL.

<<<SECTION 9>>>
### Bottlenecks in the Code Execution Pipeline

**Container startup** is the main bottleneck; pulling an image from scratch takes seconds. Each Judge Worker node keeps a pre-warmed pool of language-specific containers; one is used immediately and a replacement starts in the background. Startup drops from seconds to milliseconds.

**Judge Worker autoscaling** during contests: at 170 submissions/s the pool must scale horizontally. Kafka decouples submission rate from processing rate (submissions queue; workers go at their own pace). Kubernetes horizontal pod autoscaling adds pods based on Kafka consumer lag.

## 7. Contest Service

Manages contest lifecycle, problem sets, and the real-time leaderboard.

### Contests Table (PostgreSQL)

- contest_id UUID, PK
- title VARCHAR
- start_time, end_time TIMESTAMP
- duration_mins INTEGER
- status ENUM('upcoming', 'active', 'ended')
- participant_count INTEGER
- created_at TIMESTAMP

### ContestProblems Table (PostgreSQL)

- contest_id UUID, FK -> Contests
- problem_id UUID, FK -> Problems
- position INTEGER (1st, 2nd, 3rd, 4th problem)
- points INTEGER
- PRIMARY KEY (contest_id, problem_id)

### ContestParticipants Table (PostgreSQL)

- contest_id UUID, FK -> Contests
- user_id UUID, FK -> Users
- registered_at TIMESTAMP
- final_rank INTEGER (null until contest ends)
- PRIMARY KEY (contest_id, user_id)

### Contest Start - Handling the Read Spike

50,000 users request contest problems at once, a coordinated spike like Netflix's new season release. Mitigation is proactive cache warming, not reactive scaling:

1. 30 minutes before start, the Contest Service preloads all contest problems and visible test cases into Redis.
2. On start, all 50,000 users hit Redis; no spike reaches PostgreSQL.
3. Extra API server pods are pre-scaled based on registered participant count.

- Key: contest:{contest_id}:problems
- Value: full problem data incl. descriptions and visible test cases
- TTL: contest duration + 1 hour

**Real-time Leaderboard with Redis Sorted Set**

- Key: leaderboard:{contest_id}
- Member: user_id
- Score: (problems_solved \* 10000) - total_penalty_minutes

The 10000 multiplier ensures more problems solved always outranks faster time on fewer. Penalty minutes (5 per wrong submission) are subtracted within that band.

### Score operations:

- `ZINCRBY leaderboard:contest_123 10000 user_A` (problem solved)
- `ZINCRBY leaderboard:contest_123 -5 user_A` (wrong answer penalty)
- `ZREVRANGE leaderboard:contest_123 0 49` (top 50)
- `ZREVRANK leaderboard:contest_123 user_A` (user's rank)

All O(log N), very fast even with 50,000 participants.

**Submission Flow During Contest** (user A solves problem 3 at minute 47):

1. Code Service receives the submission with contest_id.
2. Server-side check: submitted_at <= contest.end_time (not client-side).
3. Judge Worker processes it normally.
4. On Accepted: `submission.judged` published to Kafka with contest_id.
5. Contest Leaderboard Consumer: checks in Redis whether the user already solved this problem (idempotency). If not: `ZINCRBY leaderboard:contest_123 10000 user_A`. Then applies penalties accumulated before this acceptance: `ZINCRBY leaderboard:contest_123 -{penalty_minutes} user_A`.
6. User sees a green checkmark on problem 3 via WebSocket.
7. Leaderboard updates reach all participants within seconds.

### Wrong Answer Penalty Tracking

- Key: contest:{contest_id}:penalties:{user_id}:{problem_id}
- Value: wrong_answer_count
- TTL: contest duration + 1 hour

On Wrong Answer: `INCR contest:123:penalties:user_A:problem_3`. When solved, penalty minutes = wrong_answer_count \* 5 are applied to the score.

### Contest End Flow

1. `contest.ended` event published to Kafka
2. Contest status set to ended in PostgreSQL
3. Final leaderboard snapshot from Redis persisted to ContestHistory
4. **Rating Calculation Worker** computes new Elo-style ratings from final rankings and pre-contest ratings
5. Ratings updated in the Users Table
6. Redis leaderboard TTL set to 7 days (for past results), then evicted
7. Notification Service sends results summaries to all participants
8. User Profile Service updates contest history, badges, and rating change display

### Bottlenecks in the Contest Service

The sorted set handles 170 updates/s comfortably (ZINCRBY is O(log N)). The start spike is handled by cache warming. Post-contest rating calculation is a batch job; a few minutes' latency is acceptable. Main risk: Redis going down mid-contest makes the leaderboard unavailable; mitigated by Redis Sentinel or Redis Cluster with automatic failover.

<<<SECTION 10>>>
## 8. Discussion Service

Per-problem forums for solutions, questions, and comments; architecturally like Reddit's comment system.

### Posts Table (PostgreSQL)

- post_id UUID, PK
- problem_id UUID, FK -> Problems
- user_id UUID, FK -> Users
- title VARCHAR
- content TEXT
- post_type ENUM('solution', 'question', 'discussion')
- language VARCHAR (null for non-solution posts)
- upvotes, view_count INTEGER
- created_at TIMESTAMP

### Comments Table (PostgreSQL)

- comment_id UUID, PK
- post_id UUID, FK -> Posts
- parent_id UUID, FK -> Comments (null for top-level)
- user_id UUID, FK -> Users
- content TEXT
- upvotes INTEGER
- created_at TIMESTAMP

Same **Adjacency List** pattern as Reddit: parent_id NULL is a top-level comment; non-null is a reply. Lazy loading with depth limits prevents unbounded recursive fetches.

Hot posts and top comments for popular problems are cached in Redis with a short TTL; the daily challenge discussion gets enormous traffic and benefits most.

<<<SECTION 11>>>
## 9. Full Data Flow Summary

**Catalog read:** Client -> API Gateway -> Catalog Service -> Redis list cache (filter hash key) -> PostgreSQL on miss (composite index) -> Redis MGET (hydrate metadata) -> Redis solved set (green checkmarks).

**Run Code:** Client -> Code Service:
1. Validate (size, language, rate limit); publish to Kafka `code.run`
2. WebSocket subscribes to run:{run_id} Redis channel
3. Run Worker: lightweight container -> visible cases from Redis metadata cache (no S3) -> run 3-5 cases -> destroy container
4. Result to Redis Pub/Sub run:{run_id} -> WebSocket push (1-2 s total)

**Submit:** Client -> Code Service:
1. Validate + rate limit + server-side contest timing
2. Submission record (PENDING) in PostgreSQL; source to S3; publish `code.submitted`
3. WebSocket subscribes to submission:{submission_id}
4. Judge Worker: source from S3 -> test cases from Redis (hot) or S3 (cold, then populate Redis) -> container with full security stack -> compile if needed (Compile Error on failure) -> run cases sequentially, stop on first failure -> destroy container
5. `submission.judged` to Kafka -> consumer does Redis PUBLISH submission:{submission_id} {verdict} -> WebSocket push (2-5 s total)
6. Async consumers: update Submissions; if Accepted, insert SolvedProblems + update counters; if contest, update leaderboard sorted set

**Contest:**
1. 30 min before: pre-warm Redis with contest problems; at start 50,000 users hit Redis (zero DB pressure)
2. Submissions carry contest_id through the same Submit pipeline
3. Accepted -> Leaderboard Consumer: idempotency check -> `ZINCRBY leaderboard:{contest_id} 10000 user_id` -> `ZINCRBY leaderboard:{contest_id} -{penalties} user_id` -> green checkmark via WebSocket
4. End: `contest.ended` -> Kafka -> leaderboard snapshot to ContestHistory -> Rating Calculation Worker -> Notification Service emails results -> leaderboard TTL 7 days

**Discussion:** Client -> Discussion Service -> Redis hot posts cache -> PostgreSQL (top posts WHERE problem_id = X ORDER BY upvotes DESC LIMIT 20) -> lazy-load comments (top-level first, replies on demand).

<<<SECTION 12>>>
## 10. Resilience and Fault Tolerance

- **Kafka submission queue** absorbs contest spikes: at 170 submissions/s queue depth grows at peak while Judge Workers go at their own pace. Nothing is lost if workers are temporarily overloaded. Kubernetes autoscales Judge Worker pods on consumer lag.
- **Pre-warmed container pools** per language on each worker node eliminate startup latency; used containers are destroyed and replaced in the background.
- **Redis Pub/Sub verdict delivery** reaches the correct WebSocket server wherever the user is connected; servers are stateless for verdict routing.
- **Proactive contest cache warming** removes the start-of-contest read spike; 50,000 users hit Redis with no DB pressure.
- **Idempotent contest scoring:** an accepted submission isn't counted twice even if the Kafka consumer retries; once marked solved, reprocessing is a no-op.
- **seccomp + no-network + resource limits** give defense in depth; if one layer is bypassed, others protect the host.
- **PostgreSQL read replicas** for catalog and profiles keep browsing available; a primary failure doesn't affect catalog reads.
- **Redis Cluster with automatic failover** keeps the leaderboard available if a node fails mid-contest.

<<<SECTION 13>>>
## 11. Technology Choices Summary

- **API Gateway:** Kong / AWS API Gateway (auth, rate limits incl. per-user submissions)
- **Catalog DB:** PostgreSQL sharded + replicas, composite filter indexes
- **Problem List Cache:** Redis (filtered pages, short TTL, invalidated on updates)
- **Test Cases:** S3 files; Redis cache (hot preloaded, cold cached on first fetch)
- **Submissions DB:** PostgreSQL (records, verdicts, contest tracking)
- **Source Code:** S3, referenced by URL
- **Queues:** Kafka `code.run` (lightweight) and `code.submitted` (full judge)
- **Run Workers:** Docker, lightweight security, visible cases only, 1-2 s
- **Judge Workers:** Docker, full seccomp + gVisor, all hidden cases, 2-5 s
- **Orchestration:** Kubernetes HPA on Kafka consumer lag
- **Verdict Delivery:** Redis Pub/Sub + WebSockets (multi-server routing)
- **Leaderboard:** Redis Sorted Sets (ZINCRBY, ZREVRANGE)
- **Penalty Tracking:** Redis wrong-answer counters per user/problem/contest
- **Contest Problem Cache:** Redis, pre-warmed 30 min ahead, absorbs 50k concurrent reads
- **Profile Cache:** Redis (solved problems, ratings, counters)
- **Discussion DB:** PostgreSQL Adjacency List, lazy loaded by depth
- **Rating Calculation:** batch worker on `contest.ended` (Elo-style)
- **Notifications:** APNs + FCM + AWS SES (verdicts, contest results, review prompts)
