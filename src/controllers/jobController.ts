import { Request, Response, NextFunction } from "express";
import * as jobService from "../services/jobService";
import { JobStatus } from "../types/job";

const PRIORITIES = ["high", "default", "low"];

function paramId(req: Request): string {
  return Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
}

export async function createJobHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const {
      type,
      payload,
      maxAttempts,
      priority,
      idempotencyKey,
    } = req.body ?? {};

    if (!type || typeof type !== "string") {
      return res.status(400).json({
        error: "type is required and must be a string",
      });
    }

    if (
      payload !== undefined &&
      (typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload))
    ) {
      return res.status(400).json({
        error: "payload must be an object",
      });
    }

    if (priority !== undefined && !PRIORITIES.includes(priority)) {
      return res.status(400).json({
        error: `priority must be one of ${PRIORITIES.join(", ")}`,
      });
    }

    if (
      maxAttempts !== undefined &&
      (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)
    ) {
      return res.status(400).json({
        error: "maxAttempts must be an integer between 1 and 20",
      });
    }

    if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
      return res.status(400).json({
        error: "idempotencyKey must be a string",
      });
    }

    const { job, deduped } = await jobService.createJob({
      type,
      payload: payload ?? {},
      maxAttempts,
      priority,
      idempotencyKey,
    });

    return res.status(deduped ? 200 : 201).json(job);
  } catch (err) {
    next(err);
  }
}

export async function getJobHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const job = await jobService.getJob(paramId(req));

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    return res.status(200).json(job);
  } catch (err) {
    next(err);
  }
}

export async function listJobsHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);

    if (status && !jobService.JOB_STATUSES.includes(status as JobStatus)) {
      return res.status(400).json({
        error: `status must be one of ${jobService.JOB_STATUSES.join(", ")}`,
      });
    }

    const filter = { status: status as JobStatus | undefined, type };
    const [jobs, total] = await Promise.all([
      jobService.listJobs({ ...filter, limit, skip: (page - 1) * limit }),
      jobService.countJobs(filter),
    ]);

    res.setHeader("X-Total-Count", total);
    return res.status(200).json(jobs);
  } catch (err) {
    next(err);
  }
}

export async function retryJobHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await jobService.retryJob(paramId(req));

    if (result === null) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (result === "not_retryable") {
      return res.status(409).json({
        error: "only DEAD or FAILED jobs can be retried",
      });
    }

    return res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function statsHandler(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    return res.status(200).json(await jobService.getStats());
  } catch (err) {
    next(err);
  }
}
