import "dotenv/config";
import mongoose from "mongoose";

import { Job } from "../models/Job";
import {
  DLQ_KEY,
  getHeartbeatIntervalMs,
  popNextQueuedJob,
  redisClient,
  scheduleRetry,
} from "../config/redis";

const WORKER_ID = `worker-${process.pid}`;
const MONGO_URI = process.env.MONGO_URI as string;

const JOB_SLEEP_MS = Number(process.env.JOB_SLEEP_MS ?? 30000);
const CRASH_TEST = process.env.CRASH_TEST === "true";
const FORCE_SUCCESS = process.env.FORCE_SUCCESS === "true";

function computeBackoffMs(attempts: number): number {
  const baseDelay = 2000;
  return baseDelay * Math.pow(2, attempts - 1);
}

export async function processJob(jobId: string): Promise<void> {
  const job = await Job.findById(jobId);

  if (!job) {
    console.log(`[${WORKER_ID}] job ${jobId} not found, skipping`);
    return;
  }

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

  // Claim the job
  job.status = "PROCESSING";
  job.workerId = WORKER_ID;
  job.lastHeartbeatAt = new Date();

  await job.save();

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
    if (!FORCE_SUCCESS && Math.random() < 0.5) {
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

  while (true) {
    const jobId = await popNextQueuedJob();

    if (!jobId) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 100)
      );

      continue;
    }

    await processJob(jobId);
  }
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