import "dotenv/config";
import mongoose from "mongoose";
import { Job } from "../models/Job";
import { enqueueJob, getHeartbeatTimeoutMs, getRecoveryPollIntervalMs } from "../config/redis";

const MONGO_URI = process.env.MONGO_URI as string;

export async function recoverStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - getHeartbeatTimeoutMs());
  const stuckJobs = await Job.find({
    status: "PROCESSING",
    lastHeartbeatAt: { $lt: cutoff },
  });

  let recovered = 0;

  for (const job of stuckJobs) {
    const updated = await Job.findOneAndUpdate(
      {
        _id: job._id,
        status: "PROCESSING",
        lastHeartbeatAt: { $lt: cutoff },
      },
      {
        $set: { status: "QUEUED" },
        $unset: { workerId: "", lastHeartbeatAt: "" },
      },
      { new: true }
    );

    if (!updated) continue;

    await enqueueJob(updated._id.toString(), updated.priority);
    console.log(
      `[recovery] job ${updated._id} stuck (last heartbeat ${job.lastHeartbeatAt}), requeued with priority=${updated.priority}`
    );
    recovered += 1;
  }

  return recovered;
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log("[recovery] connected, watching for stuck jobs...");

  setInterval(() => {
    recoverStaleJobs().catch((err) => console.error("[recovery] tick error:", err));
  }, getRecoveryPollIntervalMs());
}

if (require.main === module) {
  main();
}
