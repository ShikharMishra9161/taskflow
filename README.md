# TaskFlow — Distributed Job Queue & Background Job Processing System

A backend-focused distributed job queue built to explore concurrency, fault tolerance,
and reliability patterns used in real production queue systems (SQS, Sidekiq, BullMQ).

## Overview

TaskFlow accepts jobs via a REST API, queues them in Redis, and processes them with
multiple concurrent worker processes. It handles worker crashes, transient failures,
priority ordering, and duplicate submission — the core problems any distributed job
system has to solve.

## Architecture

                 Client
                   |
                   v
             Node.js API (Express)
              |            |
              v            v
          MongoDB        Redis
       (source of truth)  |
                           v
                Priority Queues (3 Redis Lists:
                 high / default / low)
                           |
          +----------------+----------------+
          v                v                v
      Worker 1         Worker 2         Worker 3
          |                |                |
          +----------------+----------------+
                           |
                SUCCESS ---+--- FAILURE
                                   |
                          attempts < maxAttempts?
                           /                \
                         YES                 NO
                          |                    |
                Backoff delay (ZSET)      Dead Letter Queue
                          |
                Scheduler requeues
                into priority list


## Tech Stack

- **Backend**: Node.js, TypeScript, Express
- **Queue**: Redis (`ioredis`) — Lists for FIFO/priority queues, Sorted Set for delayed/retry scheduling
- **Database**: MongoDB (Mongoose) — source of truth for job state
- **Auth**: JWT
- **Testing**: Jest, Supertest
- **Infra**: Docker, Docker Compose
- **Load testing**: autocannon

## Core Features (implemented and verified)

- Job creation, status, and listing APIs
- Redis-backed priority queue (3 tiers: high / default / low) with atomic `BRPOP` dequeue
- Multiple concurrent workers, safe against double-processing via Redis atomicity
- Job lifecycle state machine: `CREATED → QUEUED → PROCESSING → COMPLETED / RETRY_SCHEDULED → DEAD`
- Exponential backoff retries (2s base delay, doubling per attempt, 3-attempt max)
- Dead Letter Queue for permanently failed jobs
- Worker heartbeat (every 5s while processing) + recovery process (polls every 10s,
  reclaims jobs with heartbeat stale >20s) — recovers jobs from crashed workers
- Idempotent job submission via client-supplied `idempotencyKey` (MongoDB unique
  sparse index) — duplicate submissions return the original job (`200`) instead of
  creating a new one (`201`)
- JWT authentication on job endpoints
- Redis-based rate limiting (fixed window, per-user, atomic `INCR`)
- Dockerized: API, workers, scheduler, and recovery process all run as separate
  containers via Docker Compose, horizontally scalable via `--scale worker=N`
- Automated tests for validation, auth, and idempotency (Jest + Supertest)
- Load tested at 1/3/5 concurrent workers with autocannon

## Setup

```bash
# Environment variables needed (.env):
# MONGO_URI=mongodb://mongo:27017/taskflow
# REDIS_URL=redis://redis:6379
# JWT_SECRET=<random-string>

docker compose up --build
```

Scale workers:
```bash
docker compose up -d --scale worker=3
```

## API Reference

### `POST /auth/token`
Issues a JWT for testing purposes.
```json
{ "userId": "some-user" }
```

### `POST /jobs` (auth required)
```json
{
  "type": "email",
  "payload": { "to": "user@example.com" },
  "priority": "high",       // optional: "high" | "default" | "low"
  "maxAttempts": 3,          // optional, default 3
  "idempotencyKey": "abc123" // optional
}
```
Returns `201` for a new job, `200` if `idempotencyKey` matches an existing job.

### `GET /jobs/:id` (auth required)
Returns the job document, including status, attempts, and result/error.

### `GET /jobs` (auth required)
Returns the 100 most recent jobs.

All job endpoints require `Authorization: Bearer <token>` and are rate-limited
(10 requests/60s per user, fixed window).

## Design Decisions

**Priority queue**: implemented as three separate Redis Lists (`jobs:queue:high`,
`jobs:queue:default`, `jobs:queue:low`), with workers calling `BRPOP` across all
three — Redis returns from the first non-empty list, checked in priority order.
Chosen over a single ZSET-with-score design for simplicity; tradeoff is a known
starvation risk under sustained high-priority load (see Limitations).

**Retry backoff**: `delay = 2000ms * 2^(attempts - 1)` — 2s, 4s, 8s for a
3-attempt job. Implemented via a Redis Sorted Set (`jobs:delayed`) scored by
execution timestamp; a separate scheduler process polls it every second and
requeues due jobs.

**Crash recovery**: workers write a `lastHeartbeatAt` timestamp to Mongo every
5s while processing a job. A separate recovery process polls every 10s for jobs
`PROCESSING` with a heartbeat older than 20s, and requeues them. This provides
at-least-once delivery, not exactly-once — a job could theoretically be
processed twice in a narrow race window, which is why idempotent job
*creation* is handled separately via `idempotencyKey`.

**Idempotency**: uses MongoDB's unique+sparse index on `idempotencyKey` rather
than a pre-check-then-insert pattern, to avoid a race between two concurrent
requests with the same key. Insert is attempted directly; a duplicate-key error
(code `11000`) triggers a lookup and returns the existing job instead.

## Known Limitations

- **Load test scaling was non-linear**: across 1/3/5 workers (4,000 requests,
  20s, 10 connections each), completed-job counts were 3100 / 3733 / 3590 —
  throughput did not scale linearly with worker count, and 5 workers slightly
  underperformed 3. Not yet root-caused conclusively; likely candidates are
  Mongo write contention (every status/heartbeat update is a write) or
  Docker host CPU contention across containers, rather than the queue
  mechanism itself.
- **Priority queue starvation**: under sustained high-priority load, low
  priority jobs could theoretically never be dequeued, since `BRPOP` always
  checks `high` first. No aging/fairness mechanism implemented.
- **Crash-recovery attempt accounting**: currently, a job reclaimed by the
  recovery process does *not* increment its `attempts` counter (a crash
  is not treated as the job's fault). This is a deliberate but debatable
  choice — an intentionally chosen tradeoff, not an oversight.
- **No dashboard/UI** — deferred as out of scope; project is backend-focused
  by design.

## Load Test Results

| Workers | Avg Req/Sec | p50 Latency | p99 Latency | Jobs Completed (of 4,000) | Dead |
|---|---|---|---|---|---|
| 1 | 196.4 | 48ms | 84ms | 3,100 | 0 |
| 3 | 186.2 | 51ms | 89ms | 3,733 | 0 |
| 5 | 179.0 | 53ms | 99ms | 3,590 | 0 |

Measured with `autocannon` (10 connections, 20s duration) against a Dockerized
deployment. API-level latency stayed flat/slightly rising as workers scaled,
suggesting the API layer's own write to Mongo — not worker count — was closer
to the limiting factor for that portion of the pipeline.

## Not Built (OPTIONAL — future work)

- React dashboard
- ZSET-scored priority queue (as opposed to 3-list approach)
- CI pipeline (GitHub Actions)
- Priority-queue fairness/aging to prevent starvation                
                
