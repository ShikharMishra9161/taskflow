import "dotenv/config";
import mongoose from "mongoose";
import { Job } from "../models/Job";
import { DLQ_KEY, popNextQueuedJob, redisClient, scheduleRetry } from "../config/redis";

const WORKER_ID = `worker-${process.pid}`;
const MONGO_URI = process.env.MONGO_URI as string;

function computeBackoffMs(attempts: number): number {
  const baseDelay = 2000;
  return baseDelay * Math.pow(2, attempts - 1);
}

async function processJob(jobId: string) {
  const job = await Job.findById(jobId);
  if (!job) {
    console.log(`[${WORKER_ID}] job ${jobId} not found, skipping`);
    return;
  }

  const priority = (job.priority || "default").toUpperCase();
  const payloadJob = typeof job.payload?.job === "string" ? job.payload.job : "unknown";

  console.log(`[picked up] job=${jobId} priority=${priority} payloadJob=${payloadJob} attempt=${job.attempts + 1}/${job.maxAttempts}`);
  job.status = "PROCESSING";
  await job.save();

  try {
    if (Math.random() < 0.5) {
      throw new Error("simulated transient failure");
    }

    job.status = "COMPLETED";
    job.result = {
      message: "processed successfully",
      type: job.type,
      payload: job.payload,
    };
    await job.save();
    console.log(`[${WORKER_ID}] completed job ${jobId}`);
  } catch (err: any) {
    job.attempts += 1;
    job.error = err?.message || "Unknown job failure";

    if (job.attempts < job.maxAttempts) {
      const delayMs = computeBackoffMs(job.attempts);
      job.status = "RETRY_SCHEDULED";
      await job.save();
      await scheduleRetry(jobId, delayMs);

      console.log(`[${WORKER_ID}] job ${jobId} failed, retry ${job.attempts}/${job.maxAttempts} scheduled in ${delayMs}ms`);
    } else {
      job.status = "DEAD";
      await job.save();
      await redisClient.lpush(DLQ_KEY, jobId);

      console.log(`[${WORKER_ID}] job ${jobId} exhausted retries, moved to DLQ`);
    }
  }
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log(`[${WORKER_ID}] connected, waiting for jobs...`);

  while (true) {
    const jobId = await popNextQueuedJob();
    if (!jobId) continue;

    await processJob(jobId);
  }
}

main().catch((err) => {
  console.error(`[${WORKER_ID}] fatal error:`, err);
  process.exit(1);
});