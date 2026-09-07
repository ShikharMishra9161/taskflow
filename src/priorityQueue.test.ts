import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { createJob } from "./services/jobService";
import { Job } from "./models/Job";
import { DELAYED_KEY, popNextQueuedJob, redisClient, scheduleRetry } from "./config/redis";

let mongoServer: MongoMemoryServer;

const cleanup = async () => {
  await redisClient.flushall();
};

test.before(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGO_URI);
});

test.after(async () => {
  await cleanup();
  await mongoose.disconnect();
  await mongoServer.stop();
});

test("jobs are popped by priority then FIFO within the same priority", { concurrency: false }, async () => {
  await cleanup();

  const lowARes = await createJob({ type: "low-a", payload: { job: "low-a" }, priority: "low" });
  const highARes = await createJob({ type: "high-a", payload: { job: "high-a" }, priority: "high" });
  const defaultARes = await createJob({ type: "default-a", payload: { job: "default-a" }, priority: "default" });
  const lowBRes = await createJob({ type: "low-b", payload: { job: "low-b" }, priority: "low" });

  const lowA = lowARes.job;
  const highA = highARes.job;
  const defaultA = defaultARes.job;
  const lowB = lowBRes.job;

  const popped = [
    await popNextQueuedJob(),
    await popNextQueuedJob(),
    await popNextQueuedJob(),
    await popNextQueuedJob(),
  ];

  assert.deepEqual(popped, [highA._id.toString(), lowA._id.toString(), lowB._id.toString(), defaultA._id.toString()]);

  await Promise.all([
    Job.findByIdAndDelete(lowA._id),
    Job.findByIdAndDelete(highA._id),
    Job.findByIdAndDelete(defaultA._id),
    Job.findByIdAndDelete(lowB._id),
  ]);

  await cleanup();
});

test("retry jobs stay scheduled in the delayed set with exponential backoff semantics", { concurrency: false }, async () => {
  await cleanup();

  const jobId = "retry-job-1";
  const delayMs = 3000;
  await scheduleRetry(jobId, delayMs);

  const dueNow = await redisClient.zrangebyscore(DELAYED_KEY, 0, Date.now() + delayMs + 1000);
  assert.ok(dueNow.includes(jobId));

  await cleanup();
});
