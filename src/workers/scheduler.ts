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
    // ZREM is the claim: only the scheduler that removes the entry requeues it,
    // so running more than one scheduler replica is safe.
    const claimed = await redisClient.zrem(DELAYED_KEY, jobId);
    if (claimed === 0) continue;

    const job = await Job.findByIdAndUpdate(
      jobId,
      { $set: { status: "QUEUED" } },
      { returnDocument: "after" }
    );
    if (!job) continue;

    await enqueueJob(jobId, job.priority);

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