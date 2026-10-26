import mongoose from "mongoose";
import { Job, JobDocument } from "../models/Job";
import { JobInput, JobStatus } from "../types/job";
import {
  DELAYED_KEY,
  DLQ_KEY,
  QUEUE_KEY,
  enqueueJob,
  listWorkers,
  redisClient,
} from "../config/redis";

export const JOB_STATUSES: JobStatus[] = [
  "CREATED",
  "QUEUED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "RETRY_SCHEDULED",
  "DEAD",
];

export async function createJob(
  input: JobInput
): Promise<{ job: JobDocument; deduped: boolean }> {
  const priority = input.priority ?? "default";

  try {
    const job = await Job.create({
      type: input.type,
      payload: input.payload,
      maxAttempts: input.maxAttempts ?? 3,
      priority,
      status: "CREATED",
      ...(input.idempotencyKey && {
        idempotencyKey: input.idempotencyKey,
      }),
    });

    job.status = "QUEUED";
    await job.save();

    await enqueueJob(job._id.toString(), priority);

    return {
      job,
      deduped: false,
    };
  } catch (err: any) {
    // Duplicate idempotency key
    if (err.code === 11000 && input.idempotencyKey) {
      const existing = await Job.findOne({
        idempotencyKey: input.idempotencyKey,
      });

      if (existing) {
        return {
          job: existing,
          deduped: true,
        };
      }
    }

    throw err;
  }
}

export async function getJob(jobId: string): Promise<JobDocument | null> {
  if (!mongoose.isValidObjectId(jobId)) return null;
  return Job.findById(jobId);
}

export interface ListJobsOptions {
  status?: JobStatus;
  type?: string;
  limit?: number;
  skip?: number;
}

export async function listJobs(options: ListJobsOptions = {}): Promise<JobDocument[]> {
  const filter: Record<string, unknown> = {};
  if (options.status) filter.status = options.status;
  if (options.type) filter.type = options.type;

  return Job.find(filter)
    .sort({ createdAt: -1 })
    .skip(options.skip ?? 0)
    .limit(options.limit ?? 50)
    .exec();
}

export async function countJobs(options: Pick<ListJobsOptions, "status" | "type"> = {}): Promise<number> {
  const filter: Record<string, unknown> = {};
  if (options.status) filter.status = options.status;
  if (options.type) filter.type = options.type;
  return Job.countDocuments(filter);
}

/**
 * Manually re-run a DEAD or FAILED job: reset its attempt counter,
 * pull it out of the DLQ and put it back on the main queue.
 */
export async function retryJob(jobId: string): Promise<JobDocument | null | "not_retryable"> {
  if (!mongoose.isValidObjectId(jobId)) return null;

  const job = await Job.findOneAndUpdate(
    { _id: jobId, status: { $in: ["DEAD", "FAILED"] } },
    {
      $set: { status: "QUEUED", attempts: 0 },
      $unset: { error: "", workerId: "", lastHeartbeatAt: "" },
    },
    { returnDocument: "after" }
  );

  if (!job) {
    const exists = await Job.exists({ _id: jobId });
    return exists ? "not_retryable" : null;
  }

  await redisClient.lrem(DLQ_KEY, 0, jobId);
  await enqueueJob(jobId, job.priority);
  return job;
}

export interface ThroughputPoint {
  minute: string;
  completed: number;
  failed: number;
}

export async function getStats() {
  const since = new Date(Date.now() - 60 * 60 * 1000);

  const [statusAgg, throughputAgg, typeAgg, queueDepth, delayed, dlq, workers] = await Promise.all([
    Job.aggregate<{ _id: JobStatus; count: number }>([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    Job.aggregate<{ _id: { minute: Date; status: JobStatus }; count: number }>([
      { $match: { status: { $in: ["COMPLETED", "DEAD", "RETRY_SCHEDULED"] }, updatedAt: { $gte: since } } },
      {
        $group: {
          _id: {
            minute: { $dateTrunc: { date: "$updatedAt", unit: "minute" } },
            status: "$status",
          },
          count: { $sum: 1 },
        },
      },
    ]),
    Job.aggregate<{ _id: string; count: number }>([
      { $group: { _id: "$type", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ]),
    redisClient.zcard(QUEUE_KEY),
    redisClient.zcard(DELAYED_KEY),
    redisClient.llen(DLQ_KEY),
    listWorkers(),
  ]);

  const byStatus = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  for (const row of statusAgg) byStatus[row._id] = row.count;

  // One bucket per minute for the last hour, zero-filled.
  const nowMinute = Math.floor(Date.now() / 60000) * 60000;
  const buckets = new Map<number, ThroughputPoint>();
  for (let i = 59; i >= 0; i--) {
    const t = nowMinute - i * 60000;
    buckets.set(t, { minute: new Date(t).toISOString(), completed: 0, failed: 0 });
  }
  for (const row of throughputAgg) {
    const bucket = buckets.get(new Date(row._id.minute).getTime());
    if (!bucket) continue;
    if (row._id.status === "COMPLETED") bucket.completed += row.count;
    else bucket.failed += row.count;
  }

  return {
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    byStatus,
    queues: { ready: queueDepth, delayed, dlq },
    workers,
    throughput: [...buckets.values()],
    topTypes: typeAgg.map((r) => ({ type: r._id, count: r.count })),
    generatedAt: new Date().toISOString(),
  };
}
