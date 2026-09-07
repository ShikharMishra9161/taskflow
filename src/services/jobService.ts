import { Job, JobDocument } from "../models/Job";
import { JobInput } from "../types/job";
import { redisClient, queueKeyForPriority } from "../config/redis";

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

    await redisClient.lpush(
      queueKeyForPriority(priority),
      job._id.toString()
    );

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
  return Job.findById(jobId);
}

export async function listJobs(): Promise<JobDocument[]> {
  return Job.find().sort({ createdAt: -1 }).exec();
}