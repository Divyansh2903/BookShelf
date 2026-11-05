# Design Leetcode

<<<SECTION 1>>>
## 1. Requirements

### Functional Requirements

- Problem catalog (list, filter by difficulty, category, company tag, paginated)
- Code editor with multi-language support
- Run Code against visible test cases
- Code submission and judging against hidden test cases
- Contest management (timed submissions, real-time leaderboard)
- User profile (submission history, solved problems, rating, streak, contest history)
- Discussion forum per problem (comments and solutions)

### Out of Scope

- Premium subscription management
- Mock interviews
- Study plans
- Video explanations
- Company-specific question sets
- Judge0 internals (treated as a black box)

### Non-Functional Requirements

- Strong isolation for arbitrary code execution, user code must never affect host infrastructure
- Low latency for Run Code, results within 1-2 seconds
- Acceptable latency for Submit, verdict within 2-5 seconds
- Real-time leaderboard updates during contests
- High availability for problem catalog and editor, read-heavy and latency-sensitive
- Handle contest write spikes of ~170 submissions per second
- Exactly once submission processing, a submission must never be judged twice

<<<SECTION 2>>>
## 2. Capacity Estimation

- **DAU:** 5 million
- **Active problems:** 4000
- **Submission rate:** ~20% of DAU submit at least once = 1 million submissions per day
- **Run Code rate:** ~5x submissions = 5 million run executions per day
- **Code size per submission:** ~10 KB
- **Submission storage per day:** 1M x 10 KB = ~10 GB per day
- **Test cases:** average 50 test cases per problem x 4000 problems = 200,000 test case files in S3
- **Contest participants:** ~50,000 concurrent users per major contest
- **Contest submission rate:** 50,000 users submitting once every 5 minutes = ~170 submissions per second at peak
- **Leaderboard size:** 50,000 entries per contest sorted set in Redis

The dominant systems challenges are code execution isolation and the contest write spike. Storage numbers are modest compared to media platforms. The hardest problem is running untrusted arbitrary code safely and returning verdicts in near real-time.

## 3. API Gateway

All client requests enter through the API Gateway which handles authentication, rate limiting, and routing. LeetCode's API Gateway has an important additional responsibility during contests: **contest-specific rate limiting**. A user should not be able to spam submissions to game the judge queue. A per-user rate limit of one submission per problem per 30 seconds prevents queue flooding without affecting legitimate usage.

<<<SECTION 3>>>
## 4. User Profile Service

Manages user identity, submission history, solved problem tracking, contest participation history, and rating.

Data Model

### Users Table (PostgreSQL)

Users  
  
user_id           UUID, primary key  
username          VARCHAR, unique  
email             VARCHAR, unique  
password_hash     VARCHAR  
profile_pic_url   TEXT  
rating            INTEGER (starts at 1500, Elo-style)  
max_rating        INTEGER  
problems_solved   INTEGER  
easy_solved       INTEGER  
medium_solved     INTEGER  
hard_solved       INTEGER  
submission_count  INTEGER  
acceptance_rate   FLOAT  
streak_days       INTEGER  
last_active       TIMESTAMP  
created_at        TIMESTAMP

problems_solved, easy_solved, medium_solved, hard_solved, submission_count, and acceptance_rate are all denormalized counters updated asynchronously via Kafka consumers when submissions are judged. Counting solved problems by scanning the Submissions table on every profile load would be too slow.

### ContestHistory Table (PostgreSQL)

ContestHistory  
  
history_id        UUID, primary key  
user_id           UUID, foreign key -> Users  
contest_id        UUID, foreign key -> Contests  
rank              INTEGER  
problems_solved   INTEGER  
total_penalty     INTEGER  
rating_change     INTEGER  
attended_at       TIMESTAMP

### SolvedProblems Table (PostgreSQL)

SolvedProblems  
user_id       UUID, foreign key -> Users  
problem_id    UUID, foreign key -> Problems  
solved_at     TIMESTAMP  
language      VARCHAR  
PRIMARY KEY (user_id, problem_id)

The UNIQUE primary key on (user_id, problem_id) ensures a problem is only marked solved once regardless of how many accepted submissions a user has for it.

### Caching Strategy

User profiles are cached in Redis with a short TTL. Profile pages are among the most frequently viewed pages on LeetCode. Solved problem sets are also cached per user since they are checked on every problem list page to show the green checkmark on previously solved problems.

<<<SECTION 4>>>
## 5. Problem Catalog Service

The Problem Catalog Service is the most read-heavy service in the system. Users browse problems constantly (filtering, sorting, searching ), far more often than they submit solutions.

Data Model

### Problems Table (PostgreSQL)

Problems  
problem_id          UUID, primary key  
problem_number      INTEGER, unique  
title               VARCHAR  
slug                VARCHAR, unique  
description         TEXT  
difficulty          ENUM('easy', 'medium', 'hard')  
acceptance_rate     FLOAT  
submission_count    INTEGER  
accepted_count      INTEGER  
is_premium          BOOLEAN  
is_active           BOOLEAN  
created_at          TIMESTAMP

### ProblemTopics Table (PostgreSQL)

ProblemTopics  
problem_id    UUID, foreign key -> Problems  
topic         ENUM('array', 'string', 'dp', 'graph', 'tree', 'binary_search', ...)  
PRIMARY KEY (problem_id, topic)

### ProblemCompanies Table (PostgreSQL)

ProblemCompanies  
problem_id    UUID, foreign key -> Problems  
company       VARCHAR  
frequency     ENUM('very_high', 'high', 'medium', 'low')  
PRIMARY KEY (problem_id, company)

### TestCases Table (S3 + PostgreSQL reference)

TestCases  
testcase_id     UUID, primary key  
problem_id      UUID, foreign key -> Problems  
input_s3_url    TEXT  
output_s3_url   TEXT  
is_visible      BOOLEAN (true for example test cases shown to users)  
order_index     INTEGER

Test case content is stored in S3 as files. The TestCases table stores references (S3 URLs) not the actual content. Large inputs (graph problems with 100,000 nodes) can be megabytes, storing them in PostgreSQL as text would bloat the database unnecessarily.

### Pagination and Filtering

Problem list requests follow the pattern:

GET /v1/problems?page=1&limit=50&difficulty=medium&topic=dp&company=google&status=unsolved

A composite index on (difficulty, is_active, is_premium) covers the most common filter combinations. Topic and company filters use the join tables with indexed foreign keys.

For the paginated problem list, the full result set is cached in Redis with a short TTL since the problem list changes rarely (new problems added infrequently):

Key: problems:list:{filter_hash}:{page}  
Value: serialized list of problem metadata  
TTL: 10 minutes

filter_hash is a hash of the filter parameters so different filter combinations get separate cache keys.

### Test Case Caching

Hot problems (daily challenge, contest problems, NeetCode 150, Blind 75) have their test cases preloaded into Redis:

Key: testcases:{problem_id}  
Value: \[{input: "...", expected_output: "..."}, ...\]  
TTL: 24 hours for hot problems, 1 hour for cold problems

On cache miss, the Judge Worker fetches test cases from S3 and populates Redis. Subsequent submissions for the same problem hit Redis directly. Cold problems (obscure hard problems rarely attempted) are fetched from S3 on demand.

### Bottlenecks in the Catalog Service

The problem list is read-heavy and rarely changes. Redis caching at the list level absorbs the vast majority of catalog read traffic. The main concern is cache invalidation when a problem is updated (description fix, new test case added), a problem.updated Kafka event triggers cache invalidation for all cached list pages containing that problem.

<<<SECTION 5>>>
## 6. Code Execution Pipeline

This is the most unique service across all nine systems we have designed. User-submitted code must be executed safely, correctly, and quickly on shared infrastructure.

Security Isolation Stack

Running arbitrary user code on your servers is one of the most dangerous operations a system can perform. A multi-layer security stack is applied to every execution:

**Layer 1 - Non-root process:** Code runs as a non-privileged user with no sudo access inside the container.

**Layer 2 - seccomp syscall filter:** A Linux kernel feature that restricts which system calls the process can make. Dangerous syscalls are blocked at the kernel level:

- fork blocked (prevents fork bombs)
- socket blocked (prevents network connections at kernel level)
- exec blocked (prevents spawning child processes)
- ptrace blocked (prevents debugging other processes)

**Layer 3 - No network interface:** The container has zero network connectivity. No outbound, no inbound. Code cannot call external APIs or exfiltrate data.

<<<SECTION 6>>>
### Layer 4 - CPU and memory hard limits:

--memory="256m"     max 256MB RAM  
--cpus="0.5"        max 50% of one CPU core

If the submission exceeds these, the container is killed and returns Memory Limit Exceeded.

**Layer 5 - Wall clock timeout:** A hard execution time limit (typically 2-5 seconds depending on problem). Infinite loops are killed and return Time Limit Exceeded.

**Layer 6 - Read-only filesystem:** Container filesystem is read-only except for a single /tmp scratch directory with a size cap. Code cannot write to system directories or accumulate disk usage.

**Layer 7 - gVisor sandbox (optional, highest security):** Google's gVisor is a sandboxed container runtime that intercepts all syscalls in userspace rather than passing them to the host kernel. This eliminates container escape risk entirely for maximum security.

Two Separate Pipelines: Run Code vs Submit

Run Code and Submit have fundamentally different requirements and must not share the same pipeline.

### Run Code Pipeline (lightweight, interactive):

- Triggered when user clicks "Run" in the editor
- Only runs against 3-5 visible example test cases
- Test cases are hardcoded in the Problems metadata cache in Redis, no S3 fetch needed
- Users expect results within 1-2 seconds
- Separate Kafka topic: [code.run](https://x.com//code.run)
- Dedicated Run Workers with lighter resource limits and faster container spinup
- Results returned via WebSocket

### Submit Pipeline (heavyweight, authoritative):

- Triggered when user clicks "Submit"
- Runs against all hidden test cases (50-100+ per problem)
- Test cases fetched from Redis cache (hot problems) or S3 (cold problems)
- Users expect results within 2-5 seconds
- Separate Kafka topic: code.submitted
- Dedicated Judge Workers with full security stack
- Full verdict (Accepted, Wrong Answer, TLE, MLE, Runtime Error) + runtime ms + memory KB
- Results returned via WebSocket

<<<SECTION 7>>>
### Full Submit Flow

**Step 1 - Submission Received**  
User clicks Submit. Client sends POST /submissions with { user_id, problem_id, language, source_code, contest_id (if in contest) } to the Code Service via API Gateway.

**Step 2 - Server-side Validation**  
Code Service validates:

- Language is supported
- Source code size is within limits (max 50 KB)
- If in contest: submission timestamp is within contest window (server-side check, not client-side)
- User is not rate-limited (one submission per problem per 30 seconds)

**Step 3 - Submission Persisted**  
Submission record created in PENDING state in the Submissions Table. Submission ID returned to client immediately.

**Step 4 - Kafka Event Published**  
 code.submitted event published to Kafka with submission ID, problem ID, language, and S3 URL of the source code.

**Step 5 - WebSocket Connection Opened**  
Client opens a WebSocket connection subscribed to submission:{submission_id} channel via Redis Pub/Sub. The user sees a spinner while waiting.

**Step 6 - Judge Worker Picks Up Job**  
Judge Worker consumes the Kafka event. Fetches:

- Source code from S3
- Test cases from Redis (cache hit) or S3 (cache miss, then populates Redis)

**Step 7 - Container Spun Up**  
Judge Worker spins up a language-specific Docker container with the full security stack applied. The container image is pre-warmed (not pulled fresh on each submission) to minimize startup latency.

**Step 8 - Compilation**  
For compiled languages (C++, Java), source code is compiled first. Compilation error terminates immediately without running any test cases. Compile Error verdict returned.

**Step 9 - Test Case Execution**  
Test cases are run sequentially. On first failure (Wrong Answer, TLE, MLE, Runtime Error), execution stops and the failing test case is reported. On all test cases passing, verdict is Accepted.

**Step 10 - Container Destroyed**  
Container is destroyed immediately after execution completes. No state persists between submissions.

**Step 11 - Result Published**  
Judge Worker publishes submission.judged event to Kafka with full verdict details.

**Step 12 - Result Delivered to User**  
Kafka consumer publishes result to Redis Pub/Sub channel submission:{submission_id}. WebSocket Server subscribed to that channel receives the result and pushes it to the user's open WebSocket connection. Spinner disappears, verdict appears.

**Step 13 - Async Database Update**  
Kafka consumer updates the Submissions Table with final verdict. If Accepted, publishes problem.solved event which triggers:

- User profile counter updates (problems_solved, acceptance_rate)
- SolvedProblems table insert
- If in contest: leaderboard update

<<<SECTION 8>>>
### WebSocket Multi-Server Problem

WebSocket connections are stateful. A user connected to WebSocket Server 1 cannot receive a push from WebSocket Server 3. The solution is Redis Pub/Sub:

Judge Worker -> Kafka (submission.judged)  
Kafka consumer -> Redis PUBLISH submission:{submission_id} {verdict}  
WebSocket Server (subscribed to submission:{submission_id}) -> push to user connection

Every WebSocket server subscribes to Redis Pub/Sub channels for all active submissions on that server. When the verdict lands in Redis Pub/Sub, the correct server instance receives it and pushes to the user. No direct server-to-server communication needed.

Submissions Table (PostgreSQL)

Submissions  
submission_id     UUID, primary key  
user_id           UUID, foreign key -> Users  
problem_id        UUID, foreign key -> Problems  
contest_id        UUID (null if not in contest)  
language          VARCHAR  
source_code_url   TEXT (S3 URL)  
status            ENUM('pending', 'running', 'accepted', 'wrong_answer',  
                       'time_limit_exceeded', 'memory_limit_exceeded',  
                       'runtime_error', 'compile_error')  
runtime_ms        INTEGER  
memory_kb         INTEGER  
test_cases_passed INTEGER  
total_test_cases  INTEGER  
submitted_at      TIMESTAMP  
judged_at         TIMESTAMP

Source code is stored in S3, not in the database. Storing code as text in PostgreSQL would bloat the database and make it slow. The Submissions Table stores only the S3 reference URL.

<<<SECTION 9>>>
### Bottlenecks in the Code Execution Pipeline

Container startup latency is the primary bottleneck. Pulling a Docker image from scratch takes seconds. This is mitigated by pre-warming a pool of language-specific containers on each Judge Worker node. When a submission arrives, a pre-warmed container is used immediately and a new one is started to replace it in the background. Container startup latency goes from seconds to milliseconds.

The second bottleneck is Judge Worker autoscaling during contests. At 170 submissions per second, the worker pool must scale horizontally. Kafka decouples the submission rate from the processing rate — submissions queue in Kafka and workers process at their own pace. Kubernetes horizontal pod autoscaling adds Judge Worker pods based on Kafka consumer lag.

## 7. Contest Service

The Contest Service manages contest lifecycle, problem sets, and the real-time leaderboard.

Data Model

### Contests Table (PostgreSQL)

Contests  
contest_id      UUID, primary key  
title           VARCHAR  
start_time      TIMESTAMP  
end_time        TIMESTAMP  
duration_mins   INTEGER  
status          ENUM('upcoming', 'active', 'ended')  
participant_count INTEGER  
created_at      TIMESTAMP

### ContestProblems Table (PostgreSQL)

ContestProblems  
contest_id    UUID, foreign key -> Contests  
problem_id    UUID, foreign key -> Problems  
position      INTEGER (1st, 2nd, 3rd, 4th problem in contest)  
points        INTEGER  
PRIMARY KEY (contest_id, problem_id)

### ContestParticipants Table (PostgreSQL)

ContestParticipants  
contest_id      UUID, foreign key -> Contests  
user_id         UUID, foreign key -> Users  
registered_at   TIMESTAMP  
final_rank      INTEGER (null until contest ends)  
PRIMARY KEY (contest_id, user_id)

### Contest Start - Handling the Read Spike

When a contest starts, 50,000 users simultaneously request the contest problems. This is a coordinated read spike similar to Netflix's new season release.

The mitigation is proactive cache warming, not reactive scaling:

1. 30 minutes before contest start, Contest Service pre-loads all contest problems and their visible test cases into Redis
1. All 50,000 users hit Redis on contest start, zero spike reaches PostgreSQL
1. Additional API server pods are pre-scaled before the contest based on registered participant count

Key: contest:{contest_id}:problems  
Value: full problem data including descriptions and visible test cases  
TTL: contest duration + 1 hour

Real-time Leaderboard with Redis Sorted Set

The contest leaderboard is powered by a Redis Sorted Set:

Key: leaderboard:{contest_id}  
Member: user_id  
Score: (problems_solved \* 10000) - total_penalty_minutes

Multiplying problems solved by 10000 ensures solving more problems always outranks a faster time on fewer problems. Penalty minutes (5 minutes per wrong submission) are subtracted within that band.

### Score operations:

ZINCRBY leaderboard:contest_123 10000 user_A    (problem solved)  
ZINCRBY leaderboard:contest_123 -5 user_A       (wrong answer penalty)  
ZREVRANGE leaderboard:contest_123 0 49          (top 50 users)  
ZREVRANK leaderboard:contest_123 user_A         (user's current rank)

All operations are O(log N), extremely fast even with 50,000 participants.

Submission Flow During Contest

When user A solves problem 3 at 47 minutes into the contest:

1. Submission received by Code Service with contest_id attached
1. Server-side validation: submitted_at <= contest.end_time (enforced server-side, not client-side)
1. Judge Worker processes submission normally
1. On Accepted verdict: submission.judged event published to Kafka with contest_id
1. Contest Leaderboard Consumer picks up event:Checks if this problem was already solved by this user (idempotency check in Redis)  
If not already solved: ZINCRBY leaderboard:contest_123 10000 user_A  
Records wrong answer penalties accumulated before this accepted submission  
ZINCRBY leaderboard:contest_123 -{penalty_minutes} user_A
1. User sees green checkmark on problem 3 via WebSocket
1. Leaderboard updates visible to all participants within seconds

### Wrong Answer Penalty Tracking

Key: contest:{contest_id}:penalties:{user_id}:{problem_id}  
Value: wrong_answer_count  
TTL: contest duration + 1 hour

When a submission is judged Wrong Answer: INCR contest:123:penalties:user_A:problem_3

When the problem is eventually solved, penalty minutes = wrong_answer_count \* 5 are applied to the leaderboard score.

### Contest End Flow

When the contest ends:

1. contest.ended event published to Kafka
1. Contest Service updates contest status to ended in PostgreSQL
1. Final leaderboard snapshot taken from Redis and persisted to ContestHistory Table in PostgreSQL
1. **Rating Calculation Worker** computes new Elo-style ratings for all participants based on final rankings and pre-contest ratings
1. User ratings updated in PostgreSQL Users Table
1. Redis leaderboard key TTL set to 7 days (for viewing past results) then evicted
1. Notification Service sends contest results summary to all participants
1. User Profile Service updates contest history, badges, and rating change display

### Bottlenecks in the Contest Service

**The leaderboard Redis Sorted Set han**dles 170 score updates per second comfortably since each ZINCRBY is O(log N). The read spike at contest start is handled by proactive cache warming. The rating calculation after contest end is a batch job and its latency (a few minutes) is acceptable. The main risk is Redis availability during the contest — if Redis goes down mid-contest, the leaderboard is unavailable. This is mitigated by Redis Sentinel or Redis Cluster with automatic failover.

<<<SECTION 10>>>
## 8. Discussion Service

Each problem has a discussion forum where users post solutions, ask questions, and comment. This is architecturally similar to Reddit's comment system.

Data Model

### Posts Table (PostgreSQL)

Posts  
post_id       UUID, primary key  
problem_id    UUID, foreign key -> Problems  
user_id       UUID, foreign key -> Users  
title         VARCHAR  
content       TEXT  
post_type     ENUM('solution', 'question', 'discussion')  
language      VARCHAR (null for non-solution posts)  
upvotes       INTEGER  
view_count    INTEGER  
created_at    TIMESTAMP

### Comments Table (PostgreSQL)

Comments  
comment_id    UUID, primary key  
post_id       UUID, foreign key -> Posts  
parent_id     UUID, foreign key -> Comments (null for top-level)  
user_id       UUID, foreign key -> Users  
content       TEXT  
upvotes       INTEGER  
created_at    TIMESTAMP

Same Adjacency List pattern as Reddit for nested comments. parent_id = NULL means top-level comment on a post. Non-null parent_id means reply to another comment. Lazy loading with depth limits prevents unbounded recursive fetches.

Hot posts and top comments for popular problems are cached in Redis with a short TTL. The daily challenge problem's discussion section sees enormous traffic and benefits heavily from caching.

<<<SECTION 11>>>
## 9. Full Data Flow Summary

Problem Catalog Read Flow:  
Client -> API Gateway -> Catalog Service  
    -> Redis (paginated list cache with filter hash key)  
    -> PostgreSQL (cache miss, query with composite index)  
    -> Redis MGET (hydrate problem metadata)  
    -> Redis (solved problems per user for green checkmarks)  
  
Run Code Flow:  
Client clicks Run -> Code Service  
    -> Validate input (size, language, rate limit)  
    -> Publish to Kafka ([code.run](https://x.com//code.run) topic)  
    -> WebSocket connection opened (subscription to run:{run_id} Redis channel)  
    -> Run Worker picks up job  
        -> Spin up lightweight container  
        -> Fetch visible test cases from Redis metadata cache (hardcoded, no S3)  
        -> Execute code against 3-5 visible test cases  
        -> Destroy container  
    -> Publish result to Redis Pub/Sub (run:{run_id})  
    -> WebSocket Server pushes result to user (1-2 seconds total)  
  
Submit Flow:  
Client clicks Submit -> Code Service  
    -> Validate input + rate limit check + contest timing check (server-side)  
    -> Create Submission record (PENDING) in PostgreSQL  
    -> Upload source code to S3  
    -> Publish to Kafka (code.submitted topic)  
    -> WebSocket connection opened (subscription to submission:{submission_id} Redis channel)  
    -> Judge Worker picks up job  
        -> Fetch source code from S3  
        -> Fetch test cases from Redis (hot) or S3 (cold, then populate Redis)  
        -> Spin up language-specific container with full security stack  
        -> Compile (if compiled language) -> Compile Error if fails  
        -> Run all test cases sequentially -> stop on first failure  
        -> Destroy container  
    -> Publish submission.judged to Kafka  
    -> Kafka consumer -> Redis PUBLISH submission:{submission_id} {verdict}  
    -> WebSocket Server pushes verdict to user (2-5 seconds total)  
    -> Async Kafka consumers:  
        -> Update Submissions Table (PostgreSQL)  
        -> If Accepted: insert SolvedProblems, update user counters  
        -> If contest submission: update leaderboard sorted set in Redis  
  
Contest Flow:  
30 mins before start -> Contest Service pre-warms Redis cache with all contest problems  
Contest starts -> 50,000 users hit Redis (zero DB pressure)  
User submits -> Code Service (with contest_id) -> same Submit pipeline  
Accepted verdict -> Contest Leaderboard Consumer  
    -> Idempotency check (already solved this problem?)  
    -> ZINCRBY leaderboard:{contest_id} 10000 user_id  
    -> Apply penalty minutes: ZINCRBY leaderboard:{contest_id} -{penalties} user_id  
    -> User sees green checkmark via WebSocket  
Contest ends -> contest.ended event -> Kafka  
    -> Snapshot leaderboard from Redis -> PostgreSQL ContestHistory  
    -> Rating Calculation Worker -> update user ratings  
    -> Notification Service -> results email to all participants  
    -> Redis leaderboard TTL set to 7 days  
  
Discussion Flow:  
Client loads problem discussion -> Discussion Service  
    -> Redis (hot posts cache for popular problems)  
    -> PostgreSQL (top posts WHERE problem_id = X ORDER BY upvotes DESC LIMIT 20)  
    -> Lazy load comments (top-level first, replies on demand)

<<<SECTION 12>>>
## 10. Resilience and Fault Tolerance

**Kafka submission queue** absorbs contest write spikes. At 170 submissions per second, the queue depth grows during peaks and Judge Workers process at their own pace. No submissions are lost even if workers are temporarily overloaded. Kubernetes autoscaling adds Judge Worker pods based on Kafka consumer lag.

**Pre-warmed container pools** on Judge Worker nodes eliminate container startup latency. A pool of idle containers per language is maintained on each worker node. Used containers are destroyed and replaced in the background.

**Redis Pub/Sub for verdict delivery** ensures results reach the correct WebSocket server regardless of which server the user is connected to. WebSocket servers are stateless from the perspective of verdict routing.

**Proactive contest cache warming** eliminates the read spike at contest start. All 50,000 users hit Redis simultaneously with no database pressure.

**Idempotency checks for contest scoring** prevent a single accepted submission from being counted multiple times even if the Kafka consumer retries the event. Once a problem is marked solved for a user in a contest, subsequent processing of the same event is a no-op.

**seccomp + no-network + resource limits** provide defense in depth for code execution. Even if one isolation layer is bypassed, others prevent damage to the host system.

**PostgreSQL read replicas** for problem catalog and user profiles ensure high availability for the read-heavy browsing experience. A primary failure does not affect problem catalog reads.

**Redis Cluster with automatic failover** for the contest leaderboard ensures the leaderboard remains available even if a Redis node fails mid-contest.

<<<SECTION 13>>>
## 11. Technology Choices Summary

**API Gateway** -> Kong / AWS API Gateway (Auth, rate limiting, per-user submission rate limiting)

**Problem Catalog DB** -> PostgreSQL sharded + replicas (Problem metadata, composite indexes for filtering)

**Problem List Cache** -> Redis (Paginated filtered lists, short TTL, invalidated on problem updates)

**Test Case Storage** -> AWS S3 (Hidden test case files, fetched by Judge Workers)

**Test Case Cache** -> Redis (Hot problem test cases preloaded, cold problems cached on first fetch)

**Submissions DB** -> PostgreSQL (Submission records, verdict history, contest submission tracking)

**Source Code Storage** -> AWS S3 (Submitted source code files, referenced by S3 URL in Submissions Table)

**Run Code Queue** -> Apache Kafka ([code.run](https://x.com//code.run) topic, separate lightweight pipeline)

**Submit Queue** -> Apache Kafka (code.submitted topic, full judge pipeline)

**Run Workers** -> Docker containers with lightweight security stack (visible test cases only, 1-2s latency)

**Judge Workers** -> Docker containers with full seccomp + gVisor security stack (all hidden test cases, 2-5s latency)

**Container Orchestration** -> Kubernetes with horizontal pod autoscaling based on Kafka consumer lag

**Verdict Delivery** -> Redis Pub/Sub + WebSockets (multi-server verdict routing to correct client connection)

**Contest Leaderboard** -> Redis Sorted Sets (ZINCRBY for real-time score updates, ZREVRANGE for rankings)

**Penalty Tracking** -> Redis counters per user per problem per contest (wrong answer count for penalty calculation)

**Contest Problem Cache** -> Redis (pre-warmed 30 mins before contest start, absorbs 50k concurrent reads)

**User Profile Cache** -> Redis (solved problems, ratings, counters for profile page)

**Discussion DB** -> PostgreSQL Adjacency List (nested comments, lazy loaded by depth)

**Rating Calculation** -> Batch worker triggered by contest.ended Kafka event (Elo-style rating updates)

**Notification Delivery** -> APNs + FCM + AWS SES (verdict notifications, contest results, review prompts)

That's all, folks...Cheers!
