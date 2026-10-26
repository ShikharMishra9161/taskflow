/**
 * End-to-end crash-recovery test.
 * Starts in-memory MongoDB, recovery loop, crashes a worker after claim,
 * then verifies a second worker completes the requeued job.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { createJob } from "../services/jobService";
import { Job } from "../models/Job";
import { redisClient } from "../config/redis";

const ROOT = path.resolve(__dirname, "..", "..");
// Run tsx's CLI through the current node binary: portable across Windows/Linux.
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnProcess(script: string, env: Record<string, string>) {
  return spawn(process.execPath, [TSX_CLI, script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForStatus(jobId: string, status: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await Job.findById(jobId);
    if (job?.status === status) return job;
    await sleep(200);
  }
  throw new Error(`job ${jobId} did not reach status ${status} within ${timeoutMs}ms`);
}

async function main() {
  const mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  const baseEnv = {
    MONGO_URI: mongoUri,
    REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
    HEARTBEAT_TIMEOUT_MS: "2000",
    RECOVERY_POLL_INTERVAL_MS: "500",
    JOB_SLEEP_MS: "100",
    FORCE_SUCCESS: "true",
  };

  await redisClient.flushall();
  await mongoose.connect(mongoUri);

  console.log("[e2e] starting recovery process...");
  const recovery = spawnProcess("src/workers/recovery.ts", baseEnv);

  const created = await createJob({
    type: "e2e-crash",
    payload: { job: "e2e-crash" },
    priority: "high",
    maxAttempts: 3,
  });
  const jobId = created.job._id.toString();
  console.log(`[e2e] created job ${jobId}`);

  console.log("[e2e] starting crashing worker (CRASH_TEST=true)...");
  const crashWorker = spawnProcess("src/workers/worker.ts", {
    ...baseEnv,
    CRASH_TEST: "true",
  });

  const crashExit = await new Promise<number>((resolve) => {
    crashWorker.on("exit", (code) => resolve(code ?? 0));
  });
  if (crashExit !== 1) {
    throw new Error(`expected crash worker exit 1, got ${crashExit}`);
  }
  console.log("[e2e] crash worker exited as expected");

  const processing = await Job.findById(jobId);
  if (processing?.status !== "PROCESSING") {
    throw new Error(`expected PROCESSING after crash, got ${processing?.status}`);
  }
  console.log("[e2e] job remains PROCESSING after worker crash");

  console.log("[e2e] waiting for recovery to requeue job...");
  await waitForStatus(jobId, "QUEUED", 10000);
  console.log("[e2e] recovery requeued job");

  console.log("[e2e] starting healthy worker to complete job...");
  const healthyWorker = spawnProcess("src/workers/worker.ts", {
    ...baseEnv,
    CRASH_TEST: "false",
  });

  let healthyOutput = "";
  healthyWorker.stdout?.on("data", (chunk) => {
    healthyOutput += chunk.toString();
  });

  await waitForStatus(jobId, "COMPLETED", 15000);
  console.log("[e2e] job completed by new worker");

  healthyWorker.kill();
  recovery.kill();

  await mongoose.disconnect();
  await mongoServer.stop();
  await redisClient.quit();

  console.log("[e2e] PASS — crash-recovery flow verified");
  console.log(healthyOutput.trim());
}

main().catch((err) => {
  console.error("[e2e] FAIL", err);
  process.exit(1);
});
