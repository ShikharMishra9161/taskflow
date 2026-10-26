# TaskFlow — Distributed Job Queue & Background Job Processing System

A backend-focused distributed job queue built to explore concurrency, fault tolerance,
and reliability patterns used in real production queue systems (SQS, Sidekiq, BullMQ),
with a live web dashboard for monitoring and operating it.

## Overview

TaskFlow accepts jobs via a REST API, queues them in Redis, and processes them with
multiple concurrent worker processes. It handles worker crashes, transient failures,
priority ordering, and duplicate submission — the core problems any distributed job
system has to solve.

## Architecture

```
            ┌──────────────┐  POST /jobs   ┌───────────────┐
 clients ──►│  API + UI    │──────────────►│   MongoDB     │  job documents (source of truth)
            │  (Express)   │               └───────────────┘
            └──────┬───────┘                       ▲
                   │ ZADD jobs:queue (priority)    │ status, attempts, heartbeats
                   ▼                               │
            ┌──────────────┐  pop (Lua, atomic) ┌──┴──────────┐
            │    Redis     │◄───────────────────│  Workers ×N │──► fail → jobs:delayed (backoff)
            │ queue/delay/ │                    └─────────────┘──► exhausted → jobs:dlq (DEAD)
            │ dlq/workers  │◄── Scheduler: moves due retries from jobs:delayed back to jobs:queue
            └──────────────┘◄── Recovery: requeues PROCESSING jobs whose heartbeat went stale
```

| Process | Entry point | Role |
|---|---|---|
| API | `src/server.ts` | REST API, JWT auth, rate limiting, serves the dashboard |
| All-in-one | `src/all.ts` | Runs all four roles in one container (single-service hosting) |
| Worker | `src/workers/worker.ts` | Claims jobs atomically, heartbeats, retries / dead-letters |
| Scheduler | `src/workers/scheduler.ts` | Requeues retries once their backoff expires |
| Recovery | `src/workers/recovery.ts` | Requeues jobs orphaned by crashed workers |

All four run from the same Docker image and scale horizontally.

## Tech Stack

- **Backend**: Node.js, TypeScript, Express
- **Queue**: Redis (`ioredis`): a sorted set for the priority queue, a sorted set for delayed/retry scheduling, a list for the DLQ
- **Database**: MongoDB (Mongoose), the source of truth for job state
- **Auth**: JWT (+ optional API key gate on token issuance)
- **Dashboard**: static HTML/CSS/JS served by the API, no build step
- **Testing**: Jest, Supertest, mongodb-memory-server, crash-recovery e2e script
- **Infra**: Docker, Docker Compose, GitHub Actions → GHCR, Render Blueprint
- **Load testing**: autocannon

## Core Features

- Job creation, status, listing (filter + pagination), stats, and manual DLQ retry APIs
- Redis-backed priority queue (high / default / low) with an atomic Lua pop
- Multiple concurrent workers, safe against double-processing: each job is claimed with an atomic MongoDB `findOneAndUpdate`
- Job lifecycle state machine: `CREATED → QUEUED → PROCESSING → COMPLETED / RETRY_SCHEDULED → DEAD`
- Exponential backoff retries (2s base delay, doubling per attempt)
- Dead Letter Queue for permanently failed jobs, retryable from the API or dashboard
- Worker heartbeat + recovery process that reclaims jobs from crashed workers
- Idempotent job submission via client-supplied `idempotencyKey`
- Per-user Redis rate limiting (fixed window)
- Live worker registry and a monitoring dashboard
- Graceful shutdown: workers finish the in-flight job on `SIGTERM`
- Dockerized, horizontally scalable via `--scale worker=N`; CI on every push

## Quick start (Docker)

```bash
cp .env.example .env
# set JWT_SECRET (and AUTH_API_KEY for anything internet-facing)
docker compose up -d --build
```

Open **http://localhost:3000/dashboard/** and sign in with any user ID. You only need the API key if you set `AUTH_API_KEY`.

```bash
docker compose up -d --scale worker=5   # more workers
docker compose logs -f worker           # watch them
docker compose down                     # stop (data persists in volumes)
```

If ports 6379 or 27017 are already in use, set `REDIS_HOST_PORT` / `MONGO_HOST_PORT` in `.env`. Both are bound to 127.0.0.1 only.

## Dashboard

The dashboard lives at `/dashboard/` and auto-refreshes every 5 seconds. It shows:

- **KPIs**: ready queue depth, processing, retry-scheduled, completed (with success rate), dead-letter size, workers online
- **Throughput**: completed jobs vs failed attempts per minute over the last hour, with a hover tooltip
- **Job types**: the top 8 by volume
- **Workers**: live registry (current job, processed/failed counts, uptime). A worker drops off after 3 missed heartbeats.
- **Jobs**: filter by status or type, paginate, and click a row for payload, result, error and heartbeat. **Retry** DEAD/FAILED jobs from there.
- **New job**: enqueue one or many jobs with a chosen priority, max attempts, payload and idempotency key

It supports light and dark themes and works on mobile.

## Local development

```bash
npm install
docker compose up -d mongo redis      # just the infrastructure
cp .env.example .env
npm run dev                           # API on :3000 (watch mode)
npm run worker                        # in other terminals…
npm run scheduler
npm run recovery
```

## API Reference

Every endpoint except `/health` and `/auth/token` needs `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/token` | `{ "userId": "..." }` → `{ token }` (1h). Requires an `x-api-key` header when `AUTH_API_KEY` is set. |
| `POST` | `/jobs` | `{ type, payload?, priority?: high\|default\|low, maxAttempts?: 1-20, idempotencyKey? }`. Returns `201` for a new job, or `200` with the existing job when the `idempotencyKey` matches one. |
| `GET` | `/jobs` | Newest first. Query: `status`, `type`, `page`, `limit` (default 50, max 200). Total count is in the `X-Total-Count` header. |
| `GET` | `/jobs/:id` | The job document, including status, attempts, and result/error |
| `POST` | `/jobs/:id/retry` | Requeue a `DEAD`/`FAILED` job (resets attempts, removes it from the DLQ). `409` for other states. |
| `GET` | `/stats` | Status counts, queue depths, per-minute throughput (60 min), top types, live workers |
| `GET` | `/health` | `200` when MongoDB and Redis are both reachable, `503` otherwise |

Job endpoints are rate-limited per user: `RATE_LIMIT_MAX` requests (default 300) per `RATE_LIMIT_WINDOW_SECONDS` (default 60). Responses carry `X-RateLimit-Limit` / `X-RateLimit-Remaining`; going over returns `429`.

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/token -H 'Content-Type: application/json' \
  -d '{"userId":"me"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -X POST localhost:3000/jobs -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"send-email","priority":"high","payload":{"to":"a@b.c"}}'
```

## Design Decisions

**Priority queue**: a single Redis sorted set (`jobs:queue`). The score is `priorityWeight × 10¹² + sequence`, where `sequence` is a global `INCR` counter. Jobs therefore come out strictly by priority, and FIFO within a priority. Workers pop with a small Lua script (`ZRANGE 0 0` + `ZREM`), which is atomic, so two workers can never pop the same entry. One sorted set is simpler to inspect and count than three lists. The tradeoff is the same starvation risk (see Limitations).

**One worker per claim**: Redis atomicity alone isn't enough. A job can be enqueued twice, for example by recovery and the scheduler racing. So a worker also claims the job in MongoDB with a conditional `findOneAndUpdate` (`status ∉ {PROCESSING, COMPLETED, DEAD}` → `PROCESSING`). Losers of that race skip the job.

**Retry backoff**: `delay = 2000ms * 2^(attempts - 1)`, which gives 2s, 4s, 8s… Delayed jobs live in a Redis sorted set (`jobs:delayed`) scored by execution timestamp. The scheduler polls it every second. A `ZREM` return value of 1 acts as its claim, so multiple scheduler replicas are safe.

**Crash recovery**: while a job is processing, its worker writes `lastHeartbeatAt` to Mongo every `HEARTBEAT_INTERVAL_MS` (5s). The recovery process polls every `RECOVERY_POLL_INTERVAL_MS` (2s) for `PROCESSING` jobs whose heartbeat is older than `HEARTBEAT_TIMEOUT_MS` (15s), and requeues them. This gives at-least-once delivery. A job can run twice if a worker stalls past the timeout without dying, which is why job handlers should be idempotent.

**Idempotency**: uses MongoDB's unique+sparse index on `idempotencyKey` rather than a check-then-insert pattern, which avoids a race between two concurrent requests with the same key. The insert is attempted directly. A duplicate-key error (code `11000`) triggers a lookup and returns the existing job instead.

**Worker registry**: every worker writes `workers:<id>` to Redis with a TTL of 3 heartbeat intervals. The dashboard lists live workers with `SCAN`, and dead workers expire on their own. IDs include the hostname, so they stay unique across containers.

## Configuration

| Variable | Default | Used by | Notes |
|---|---|---|---|
| `MONGO_URI` | — (required) | all | |
| `REDIS_URL` | `redis://localhost:6379` | all | |
| `JWT_SECRET` | — (required) | API | |
| `AUTH_API_KEY` | empty | API | Gates token issuance. **Set it in production.** |
| `PORT` | `3000` | API | |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` | `300` / `60` | API | Per user |
| `JOB_SLEEP_MS` | `30000` (compose: `2000`) | worker | Simulated work duration |
| `FAILURE_RATE` | `0.5` (compose: `0.2`) | worker | Simulated transient-failure probability |
| `FORCE_SUCCESS` | `false` | worker | Disables simulated failures |
| `HEARTBEAT_INTERVAL_MS` | `5000` | worker | |
| `HEARTBEAT_TIMEOUT_MS` | `15000` | recovery | |
| `RECOVERY_POLL_INTERVAL_MS` | `2000` | recovery | |

The job handler (`processJob` in `src/workers/worker.ts`) is a simulation: it sleeps, then succeeds or fails at random. Replace that block with real work, dispatching on `job.type`.

## Deployment

### Render (managed)

`render.yaml` is a Render Blueprint covering the API, a worker, the scheduler, recovery, and a Redis-compatible Key Value instance. MongoDB comes from **MongoDB Atlas**.

1. In Atlas, go to *Network Access* and allow `0.0.0.0/0` (Render has no fixed outbound IPs on starter plans). Copy the connection string, and include a database name, e.g. `…mongodb.net/taskflow?…`.
2. In Render, choose **New → Blueprint**, pick this repo, and paste the Atlas URI when prompted for `MONGO_URI`.
3. Open `https://<taskflow-api>.onrender.com/dashboard/` and sign in. Use the generated `AUTH_API_KEY` from the API service's *Environment* tab.

Render background workers need a paid instance type, which is why the blueprint uses `starter`. Render redeploys automatically on every push to `main`.

**Free tier (single service, $0):** Render's free plan has no background workers. Instead, create one free *Web Service* (Docker runtime) with start command `node dist/all.js` and health check path `/health`, plus a free *Key Value* instance. `src/all.ts` runs the API, worker, scheduler and recovery as child processes in one container, restarts any that crash, and forwards `SIGTERM`. The tradeoffs: the service sleeps after 15 minutes without traffic (workers pause with it, and the first request takes about a minute to wake it), and free Key Value isn't persisted, so jobs still waiting in the Redis queue are lost if it restarts.

### Any VM with Docker

```bash
git clone https://github.com/ShikharMishra9161/taskflow.git && cd taskflow
cp .env.example .env    # set JWT_SECRET and AUTH_API_KEY to long random values
docker compose up -d --build
```

Put a TLS-terminating reverse proxy in front of port 3000 (Caddy: `your.domain { reverse_proxy localhost:3000 }`). To use the CI-built image, set `TASKFLOW_IMAGE=ghcr.io/shikharmishra9161/taskflow:latest`.

### CI/CD

`.github/workflows/ci.yml` runs typecheck, build, the API tests, and the crash-recovery e2e test against a real Redis on every push and PR. Pushes to `main` also publish `ghcr.io/<owner>/taskflow:latest` and `:sha-<commit>`.

## Testing

```bash
npm test                    # Jest API tests (in-memory MongoDB; needs Redis on REDIS_URL)
npm run test:crash-recovery # spawns real workers, crashes one, verifies recovery (FLUSHALLs Redis!)
npm run loadtest            # autocannon against a running API (needs LOAD_TEST_TOKEN)
```

## Known Limitations

- **Load test scaling was non-linear**: across 1/3/5 workers (4,000 requests, 20s, 10 connections each), completed-job counts were 3100 / 3733 / 3590. Throughput did not scale linearly with worker count, and 5 workers slightly underperformed 3. This isn't conclusively root-caused yet. The likely causes are Mongo write contention (every status and heartbeat update is a write) or Docker host CPU contention, rather than the queue mechanism itself.
- **Priority starvation**: under sustained high-priority load, low-priority jobs may never be dequeued. There's no aging or fairness mechanism.
- **Crash-recovery attempt accounting**: a job reclaimed by recovery does *not* increment its `attempts` counter, because a crash is not treated as the job's fault. A job that deterministically crashes its worker would loop. This is a deliberate but debatable tradeoff.
- **Fixed-window rate limiting** allows bursts of up to 2× the limit across a window boundary.

## Load Test Results

| Workers | Avg Req/Sec | p50 Latency | p99 Latency | Jobs Completed (of 4,000) | Dead |
|---|---|---|---|---|---|
| 1 | 196.4 | 48ms | 84ms | 3,100 | 0 |
| 3 | 186.2 | 51ms | 89ms | 3,733 | 0 |
| 5 | 179.0 | 53ms | 99ms | 3,590 | 0 |

Measured with `autocannon` (10 connections, 20s duration) against a Dockerized deployment. API latency stayed flat or rose slightly as workers scaled. That suggests the API's own write to Mongo, not worker count, was closer to the limiting factor for that part of the pipeline.

## Future Work

- Priority aging/fairness to prevent starvation
- Sliding-window or token-bucket rate limiting
- Per-job-type handlers and per-type concurrency limits
- Metrics export (Prometheus) alongside the dashboard
