import Redis from "ioredis";
import { JobPriority } from "../types/job";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const redisClient = new Redis(REDIS_URL);

redisClient.on("connect", () => console.log("Redis connected"));
redisClient.on("error", (err) => console.error("Redis error:", err));

export const QUEUE_KEY = "jobs:queue";
export const QUEUE_HIGH = QUEUE_KEY;
export const QUEUE_DEFAULT = QUEUE_KEY;
export const QUEUE_LOW = QUEUE_KEY;
export const DELAYED_KEY = "jobs:delayed";
export const DLQ_KEY = "jobs:dlq";
export const JOB_QUEUE_SEQUENCE_KEY = "jobs:queue:sequence";

const PRIORITY_WEIGHT: Record<JobPriority, number> = {
  high: 0,
  default: 1,
  low: 2,
};

const PRIORITY_BUCKET = 1_000_000_000_000;

export function queueKeyForPriority(_priority: string): string {
  return QUEUE_KEY;
}

export function priorityScore(priority: JobPriority | string, sequence: number): number {
  const normalized = (priority ?? "default").toLowerCase() as JobPriority;
  const weight = PRIORITY_WEIGHT[normalized] ?? PRIORITY_WEIGHT.default;
  return weight * PRIORITY_BUCKET + sequence;
}

export async function enqueueJob(jobId: string, priority: JobPriority | string): Promise<void> {
  const normalized = (priority ?? "default").toLowerCase() as JobPriority;
  const sequence = await redisClient.incr(JOB_QUEUE_SEQUENCE_KEY);
  const score = priorityScore(normalized, sequence);
  await redisClient.zadd(QUEUE_KEY, score, jobId);
}

export async function popNextQueuedJob(): Promise<string | null> {
  const script = `
    local members = redis.call('ZRANGE', KEYS[1], 0, 0)
    if #members == 0 then
      return nil
    end

    local member = members[1]
    redis.call('ZREM', KEYS[1], member)
    return member
  `;

  const result = (await redisClient.eval(script, 1, QUEUE_KEY)) as string | null;
  return result ?? null;
}

export async function scheduleRetry(jobId: string, delayMs: number): Promise<void> {
  const executeAt = Date.now() + delayMs;
  await redisClient.zadd(DELAYED_KEY, executeAt, jobId);
}

export const WORKER_KEY_PREFIX = "workers:";

export interface WorkerInfo {
  id: string;
  host: string;
  pid: number;
  startedAt: string;
  lastSeenAt: string;
  currentJobId: string | null;
  processed: number;
  failed: number;
}

export async function registerWorker(info: WorkerInfo, ttlSeconds: number): Promise<void> {
  await redisClient.set(`${WORKER_KEY_PREFIX}${info.id}`, JSON.stringify(info), "EX", ttlSeconds);
}

export async function unregisterWorker(workerId: string): Promise<void> {
  await redisClient.del(`${WORKER_KEY_PREFIX}${workerId}`);
}

export async function listWorkers(): Promise<WorkerInfo[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redisClient.scan(cursor, "MATCH", `${WORKER_KEY_PREFIX}*`, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");

  if (keys.length === 0) return [];

  const values = await redisClient.mget(keys);
  return values
    .filter((v): v is string => v !== null)
    .map((v) => JSON.parse(v) as WorkerInfo)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getHeartbeatIntervalMs(): number {
  return Number(process.env.HEARTBEAT_INTERVAL_MS ?? 5000);
}

export function getHeartbeatTimeoutMs(): number {
  return Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 15000);
}

export function getRecoveryPollIntervalMs(): number {
  return Number(process.env.RECOVERY_POLL_INTERVAL_MS ?? 2000);
}