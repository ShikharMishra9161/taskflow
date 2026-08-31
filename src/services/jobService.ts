import { Job, JobDocument } from "../models/Job";
import { enqueueJob } from "../config/redis";
import { JobInput } from "../types/job";

export async function createJob(input: JobInput): Promise<JobDocument> {
  const priority = input.priority ?? "default";

  const job = await Job.create({
    type: input.type,
    payload: input.payload,
    maxAttempts: input.maxAttempts ?? 3,
    priority,
    status: "CREATED",
  });

  job.status = "QUEUED";
  await job.save();

  await enqueueJob(job._id.toString(), priority);

  return job;
}

export async function getJobById(id: string): Promise<JobDocument | null> {
  return Job.findById(id);
}

export async function listJobs(): Promise<JobDocument[]> {
  return Job.find().sort({ createdAt: -1 }).limit(100);
}