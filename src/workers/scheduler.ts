import "dotenv/config";
import mongoose from "mongoose";
import { Job } from "../models/Job";
import { DELAYED_KEY, enqueueJob, redisClient } from "../config/redis";

const MONGO_URI = process.env.MONGO_URI as string;
const POLL_INTERVAL_MS = 1000;

async function tick() {
  const now = Date.now();
  const dueJobIds = await redisClient.zrangebyscore(DELAYED_KEY, 0, now);

  for (const jobId of dueJobIds) {
    const job = await Job.findById(jobId);
    if (!job) {
      await redisClient.zrem(DELAYED_KEY, jobId);
      continue;
    }

    await redisClient.zrem(DELAYED_KEY, jobId);
    await enqueueJob(jobId, job.priority);

    job.status = "QUEUED";
    await job.save();

    console.log(`[scheduler] requeued job ${jobId} with priority=${job.priority}`);
  }
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log("[scheduler] connected, polling delayed queue...");

  setInterval(() => {
    tick().catch((err) => console.error("[scheduler] tick error:", err));
  }, POLL_INTERVAL_MS);
}

main();