# Taskflow

A distributed background-job queue built with Node.js, TypeScript, MongoDB and Redis. It supports priorities, retries with exponential backoff, a dead-letter queue, idempotent submission, per-user rate limiting, crash recovery via worker heartbeats, and a live web dashboard.

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
| Worker | `src/workers/worker.ts` | Claims jobs atomically, heartbeats, retries / dead-letters |
| Scheduler | `src/workers/scheduler.ts` | Requeues retries once their backoff expires |
| Recovery | `src/workers/recovery.ts` | Requeues jobs orphaned by crashed workers |

All four run from the same Docker image, so you can scale workers horizontally.

## Quick start (Docker)

```bash
cp .env.example .env
# set JWT_SECRET (and AUTH_API_KEY for anything internet-facing)
docker compose up -d --build
```

Open **http://localhost:3000/dashboard/** and sign in. Use any user ID; enter the API key only if you set `AUTH_API_KEY`.

```bash
docker compose up -d --scale worker=5   # more workers
docker compose logs -f worker           # watch them
docker compose down                     # stop (data persists in volumes)
```

If ports 6379 or 27017 are already taken on your machine, set `REDIS_HOST_PORT` / `MONGO_HOST_PORT` in `.env`. Those ports are bound to 127.0.0.1 only.

## Dashboard

The dashboard lives at `/dashboard/`. It's served by the API and is static, with no build step and no external dependencies. It auto-refreshes every 5 seconds and shows:

- **KPIs**: ready queue depth, processing, retry-scheduled, completed with success rate, dead-letter size, workers online
- **Throughput**: completed jobs vs failed attempts per minute over the last hour, with a hover tooltip
- **Job types**: the top 8 by volume
- **Workers**: live registry (current job, processed/failed counts, uptime). A worker disappears after 3 missed heartbeats.
- **Jobs**: filter by status or type, paginate, and click a row for payload, result, error and heartbeat. You can **retry** DEAD/FAILED jobs from here.
- **New job**: enqueue one or many jobs with a chosen priority, max attempts, payload and idempotency key

It supports light and dark themes (follows the OS, with a toggle) and works on mobile.

## Local development

```bash
npm install
docker compose up -d mongo redis      # just the infrastructure
cp .env.example .env                  # defaults point at localhost
npm run dev                           # API on :3000 (watch mode)
npm run worker                        # in other terminals…
npm run scheduler
npm run recovery
```

## API

Every endpoint except `/health` and `/auth/token` needs `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/token` | `{ "userId": "..." }` → `{ token }` (1h). Requires `x-api-key` when `AUTH_API_KEY` is set. |
| `POST` | `/jobs` | Create a job: `{ type, payload?, priority?: high\|default\|low, maxAttempts?: 1-20, idempotencyKey? }`. Returns `201`, or `200` with the existing job on a duplicate idempotency key. |
| `GET` | `/jobs` | List jobs. Query: `status`, `type`, `page`, `limit` (≤200). Total count is in the `X-Total-Count` header. |
| `GET` | `/jobs/:id` | Get one job |
| `POST` | `/jobs/:id/retry` | Requeue a `DEAD`/`FAILED` job (resets attempts, removes it from the DLQ). `409` for other states. |
| `GET` | `/stats` | Status counts, queue depths, per-minute throughput (60 min), top types, live workers |
| `GET` | `/health` | `200` when MongoDB and Redis are both reachable, `503` otherwise |

Rate limiting is per user, over a fixed window. Responses carry `X-RateLimit-Limit` / `X-RateLimit-Remaining`, and exceeding the limit returns `429`.

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/token -H 'Content-Type: application/json' \
  -d '{"userId":"me"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -X POST localhost:3000/jobs -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"send-email","priority":"high","payload":{"to":"a@b.c"}}'
```

### Job lifecycle

`QUEUED → PROCESSING → COMPLETED`. On failure the job goes `→ RETRY_SCHEDULED` (backoff 2s, 4s, 8s…) `→ QUEUED → …`. Once attempts are exhausted it ends `→ DEAD` and lands in the DLQ. If a worker crashes mid-job, its heartbeat stops. After `HEARTBEAT_TIMEOUT_MS` the recovery process moves the job back to `QUEUED`. Workers claim jobs with an atomic MongoDB update, so a job that gets enqueued twice is still only processed once.

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
| `FAILURE_RATE` | `0.5` (compose: `0.2`) | worker | Simulated transient failure probability |
| `FORCE_SUCCESS` | `false` | worker | Disable simulated failures |
| `HEARTBEAT_INTERVAL_MS` | `5000` | worker | |
| `HEARTBEAT_TIMEOUT_MS` | `15000` | recovery | |
| `RECOVERY_POLL_INTERVAL_MS` | `2000` | recovery | |

The worker's job handler (`processJob` in `src/workers/worker.ts`) is a simulation that sleeps and then succeeds or fails at random. Swap that block for real work, dispatching on `job.type`.

## Deployment

### Option A: any VM with Docker (simplest)

```bash
git clone https://github.com/ShikharMishra9161/taskflow.git && cd taskflow
cp .env.example .env    # set JWT_SECRET and AUTH_API_KEY to long random values
docker compose up -d --build
```

Put a TLS-terminating reverse proxy in front of port 3000 (Caddy: `your.domain { reverse_proxy localhost:3000 }`). To run the CI-built image instead of building on the server, set `TASKFLOW_IMAGE=ghcr.io/shikharmishra9161/taskflow:latest` and run `docker compose pull && docker compose up -d`.

### Option B: Render (managed)

`render.yaml` is a Render Blueprint that defines the API, 2 workers, the scheduler, recovery, and a Redis-compatible Key Value instance. MongoDB comes from **MongoDB Atlas**.

1. Create an Atlas cluster. Under *Network Access*, allow Render's outbound IPs (or `0.0.0.0/0`). Copy the connection string.
2. In Render: **New → Blueprint**, pick this repo, and paste the Atlas URI when prompted for `MONGO_URI`.
3. Once deployed, open `https://<taskflow-api>.onrender.com/dashboard/` and sign in using the generated `AUTH_API_KEY` (in the API service's *Environment* tab).

Render background workers need a paid instance type, which is why the blueprint uses `starter`.

### CI/CD

`.github/workflows/ci.yml` runs on every push and PR: typecheck, build, unit/API tests, and the crash-recovery end-to-end test, against a real Redis service. On pushes to `main`, it also publishes `ghcr.io/<owner>/taskflow:latest` and `:sha-<commit>`. Render redeploys automatically on push to `main`.

## Testing

```bash
npm test                    # Jest API tests (in-memory MongoDB; needs Redis on REDIS_URL)
npm run test:crash-recovery # spawns real worker processes, crashes one, verifies recovery (FLUSHALLs Redis!)
npm run loadtest            # autocannon against a running API (needs LOAD_TEST_TOKEN)
```
