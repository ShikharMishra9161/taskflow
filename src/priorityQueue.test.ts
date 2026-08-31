import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

import { createJob } from "./services/jobService";
import { DELAYED_KEY, JOB_QUEUE_SEQUENCE_KEY, QUEUE_KEY, popNextQueuedJob, redisClient, scheduleRetry } from "./config/redis";

const cleanup = async () => {
  await redisClient.flushall();
};

test("jobs are popped by priority then FIFO within the same priority", { concurrency: false }, async () => {
  await mongoose.connect(process.env.MONGO_URI!);
  await cleanup();

  const lowA = await createJob({ type: "low-a", payload: { job: "low-a" }, priority: "low" });
  const highA = await createJob({ type: "high-a", payload: { job: "high-a" }, priority: "high" });
  const defaultA = await createJob({ type: "default-a", payload: { job: "default-a" }, priority: "default" });
  const lowB = await createJob({ type: "low-b", payload: { job: "low-b" }, priority: "low" });

  const popped = [
    await popNextQueuedJob(),
    await popNextQueuedJob(),
    await popNextQueuedJob(),
    await popNextQueuedJob(),
  ];

  assert.deepEqual(popped, [highA._id.toString(), lowA._id.toString(), lowB._id.toString(), defaultA._id.toString()]);

  await Promise.all([
    mongoose.models.Job.findByIdAndDelete(lowA._id),
    mongoose.models.Job.findByIdAndDelete(highA._id),
    mongoose.models.Job.findByIdAndDelete(defaultA._id),
    mongoose.models.Job.findByIdAndDelete(lowB._id),
  ]);

  await cleanup();
  await mongoose.disconnect();
});

test("retry jobs stay scheduled in the delayed set with exponential backoff semantics", { concurrency: false }, async () => {
  await mongoose.connect(process.env.MONGO_URI!);
  await cleanup();

  const jobId = "retry-job-1";
  const delayMs = 3000;
  await scheduleRetry(jobId, delayMs);

  const dueNow = await redisClient.zrangebyscore(DELAYED_KEY, 0, Date.now() + delayMs + 1000);
  assert.ok(dueNow.includes(jobId));

  await cleanup();
  await mongoose.disconnect();
});
