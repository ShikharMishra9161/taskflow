import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { createJob } from "./services/jobService";
import { Job } from "./models/Job";
import { DELAYED_KEY, QUEUE_KEY, popNextQueuedJob, redisClient } from "./config/redis";
import { recoverStaleJobs } from "./workers/recovery";
import { processJob } from "./workers/worker";

let mongoServer: MongoMemoryServer;

const cleanup = async () => {
  await redisClient.flushall();
};

test.before(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongoServer.getUri();
  process.env.HEARTBEAT_TIMEOUT_MS = "1000";
  await mongoose.connect(process.env.MONGO_URI);
});

test.after(async () => {
  await cleanup();
  await mongoose.disconnect();
  await mongoServer.stop();
});

test("recovery requeues stale PROCESSING jobs via priority queue", { concurrency: false }, async () => {
  await cleanup();

  const created = await createJob({ type: "crash-test", payload: { job: "crash-test" }, priority: "high" });
  const jobId = created.job._id.toString();

  await popNextQueuedJob();

  await Job.findByIdAndUpdate(jobId, {
    status: "PROCESSING",
    workerId: "worker-dead",
    lastHeartbeatAt: new Date(Date.now() - 5000),
  });

  const queueBefore = await redisClient.zcard(QUEUE_KEY);
  assert.equal(queueBefore, 0);

  const recovered = await recoverStaleJobs();
  assert.equal(recovered, 1);

  const updated = await Job.findById(jobId);
  assert.equal(updated?.status, "QUEUED");
  assert.equal(updated?.workerId, undefined);
  assert.equal(updated?.lastHeartbeatAt, undefined);

  const queueAfter = await redisClient.zcard(QUEUE_KEY);
  assert.equal(queueAfter, 1);

  const popped = await popNextQueuedJob();
  assert.equal(popped, jobId);

  await Job.findByIdAndDelete(jobId);
  await cleanup();
});

test("recovery is a no-op for fresh heartbeats and completed jobs", { concurrency: false }, async () => {
  await cleanup();

  const active = await createJob({ type: "active", payload: { job: "active" }, priority: "default" });
  const activeId = active.job._id.toString();
  await popNextQueuedJob();
  await Job.findByIdAndUpdate(activeId, {
    status: "PROCESSING",
    workerId: "worker-live",
    lastHeartbeatAt: new Date(),
  });

  const completed = await createJob({ type: "done", payload: { job: "done" }, priority: "default" });
  await Job.findByIdAndUpdate(completed.job._id, { status: "COMPLETED" });

  const recovered = await recoverStaleJobs();
  assert.equal(recovered, 0);

  const activeJob = await Job.findById(activeId);
  assert.equal(activeJob?.status, "PROCESSING");
  assert.equal(activeJob?.workerId, "worker-live");

  await Job.findByIdAndDelete(activeId);
  await Job.findByIdAndDelete(completed.job._id);
  await cleanup();
});

test("recovered job can be completed by a new worker", { concurrency: false }, async () => {
  await cleanup();

  process.env.JOB_SLEEP_MS = "50";
  process.env.FORCE_SUCCESS = "true";
  delete process.env.CRASH_TEST;

  const created = await createJob({ type: "recover-complete", payload: { job: "recover-complete" }, priority: "default" });
  const jobId = created.job._id.toString();

  await popNextQueuedJob();
  await Job.findByIdAndUpdate(jobId, {
    status: "PROCESSING",
    workerId: "worker-crashed",
    lastHeartbeatAt: new Date(Date.now() - 5000),
  });

  assert.equal(await recoverStaleJobs(), 1);

  await processJob(jobId);

  const finished = await Job.findById(jobId);
  assert.equal(finished?.status, "COMPLETED");
  assert.ok(finished?.result);

  delete process.env.JOB_SLEEP_MS;
  delete process.env.FORCE_SUCCESS;

  await Job.findByIdAndDelete(jobId);
  await cleanup();
});
