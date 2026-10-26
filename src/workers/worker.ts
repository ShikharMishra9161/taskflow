import "dotenv/config";
import os from "node:os";
import mongoose from "mongoose";

import { Job } from "../models/Job";
import {
  DLQ_KEY,
  getHeartbeatIntervalMs,
  popNextQueuedJob,
  redisClient,
  registerWorker,
  scheduleRetry,
  unregisterWorker,
  WorkerInfo,
} from "../config/redis";

// Hostname keeps IDs unique across containers (where every pid is 1).
const WORKER_ID = `worker-${os.hostname()}-${process.pid}`;
const MONGO_URI = process.env.MONGO_URI as string;

const JOB_SLEEP_MS = Number(process.env.JOB_SLEEP_MS ?? 30000);
const CRASH_TEST = process.env.CRASH_TEST === "true";
const FORCE_SUCCESS = process.env.FORCE_SUCCESS === "true";
const FAILURE_RATE = Number(process.env.FAILURE_RATE ?? 0.5);

const workerInfo: WorkerInfo = {
  id: WORKER_ID,
  host: os.hostname(),
  pid: process.pid,
  startedAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  currentJobId: null,
  processed: 0,
  failed: 0,
};

let shuttingDown = false;

async function reportPresence(): Promise<void> {
  workerInfo.lastSeenAt = new Date().toISOString();
  const ttlSeconds = Math.ceil((getHeartbeatIntervalMs() * 3) / 1000);
  await registerWorker(workerInfo, ttlSeconds);
}

function computeBackoffMs(attempts: number): number {
  const baseDelay = 2000;
  return baseDelay * Math.pow(2, attempts - 1);
}

export async function processJob(jobId: string): Promise<void> {
  // Claim atomically so a job that was enqueued twice (e.g. by recovery and
  // the scheduler) is never processed by two workers at once.
  const job = await Job.findOneAndUpdate(
    { _id: jobId, status: { $nin: ["PROCESSING", "COMPLETED", "DEAD"] } },
    {
      $set: {
        status: "PROCESSING",
        workerId: WORKER_ID,
        lastHeartbeatAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  if (!job) {
    console.log(`[${WORKER_ID}] job ${jobId} not found or already claimed, skipping`);
    return;
  }

  workerInfo.currentJobId = jobId;

  const priority = (job.priority || "default").toUpperCase();

  const payloadJob =
    typeof job.payload?.job === "string"
      ? job.payload.job
      : "unknown";

  console.log(
    `[picked up] job=${jobId} ` +
      `priority=${priority} ` +
      `payloadJob=${payloadJob} ` +
      `attempt=${job.attempts + 1}/${job.maxAttempts}`
  );

  /*
   * TEST-ONLY CRASH SIMULATION
   *
   * The job is already PROCESSING in MongoDB.
   * The worker exits before starting the heartbeat.
   *
   * This simulates:
   *
   * Worker picks job
   *       ↓
   * PROCESSING
   *       ↓
   * Worker crashes
   *       ↓
   * Heartbeat stops
   *       ↓
   * Recovery detects stale job
   */
  if (CRASH_TEST) {
    console.log(
      `[${WORKER_ID}] CRASH_TEST enabled — ` +
        `simulating worker crash for job ${jobId}`
    );

    process.exit(1);
  }

  // Start heartbeat
  const heartbeatInterval = setInterval(async () => {
    try {
      await Job.findByIdAndUpdate(jobId, {
        workerId: WORKER_ID,
        lastHeartbeatAt: new Date(),
      });
    } catch (error) {
      console.error(
        `[${WORKER_ID}] heartbeat failed for job ${jobId}`,
        error
      );
    }
  }, getHeartbeatIntervalMs());

  try {
    // Simulate actual job processing
    await new Promise<void>((resolve) =>
      setTimeout(resolve, JOB_SLEEP_MS)
    );

    // Simulated transient failure
    if (!FORCE_SUCCESS && Math.random() < FAILURE_RATE) {
      throw new Error("simulated transient failure");
    }

    // Successful completion
    job.status = "COMPLETED";

    job.result = {
      message: "processed successfully",
      type: job.type,
      payload: job.payload,
    };

    await job.save();
    workerInfo.processed += 1;

    console.log(
      `[${WORKER_ID}] completed job ${jobId}`
    );
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error
        ? err.message
        : "Unknown job failure";

    job.attempts += 1;
    job.error = errorMessage;
    workerInfo.failed += 1;

    // Retry
    if (job.attempts < job.maxAttempts) {
      const delayMs = computeBackoffMs(job.attempts);

      job.status = "RETRY_SCHEDULED";

      await job.save();

      await scheduleRetry(jobId, delayMs);

      console.log(
        `[${WORKER_ID}] job ${jobId} failed, ` +
          `retry ${job.attempts}/${job.maxAttempts} ` +
          `scheduled in ${delayMs}ms`
      );
    }

    // Dead Letter Queue
    else {
      job.status = "DEAD";

      await job.save();

      await redisClient.lpush(DLQ_KEY, jobId);

      console.log(
        `[${WORKER_ID}] job ${jobId} exhausted retries, ` +
          `moved to DLQ`
      );
    }
  } finally {
    clearInterval(heartbeatInterval);
    workerInfo.currentJobId = null;
  }
}

async function main(): Promise<void> {
  if (!MONGO_URI) {
    throw new Error("MONGO_URI is not configured");
  }

  await mongoose.connect(MONGO_URI);

  console.log(
    `[${WORKER_ID}] connected, waiting for jobs...`
  );

  await reportPresence();
  const presenceInterval = setInterval(() => {
    reportPresence().catch((err) =>
      console.error(`[${WORKER_ID}] presence update failed`, err)
    );
  }, getHeartbeatIntervalMs());

  // Finish the in-flight job, then exit (docker stop / k8s SIGTERM).
  const requestShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${WORKER_ID}] ${signal} received, finishing current job...`);
  };
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));
  process.on("SIGINT", () => requestShutdown("SIGINT"));

  while (!shuttingDown) {
    const jobId = await popNextQueuedJob();

    if (!jobId) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 100)
      );

      continue;
    }

    await processJob(jobId);
  }

  clearInterval(presenceInterval);
  await unregisterWorker(WORKER_ID);
  await mongoose.disconnect();
  redisClient.disconnect();
  console.log(`[${WORKER_ID}] shut down cleanly`);
  process.exit(0);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(
      `[${WORKER_ID}] fatal error:`,
      err
    );

    process.exit(1);
  });
}