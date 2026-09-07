import { Request, Response, NextFunction } from "express";
import * as jobService from "../services/jobService";

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
    } = req.body;

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
    const jobId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const job = await jobService.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    return res.status(200).json(job);
  } catch (err) {
    next(err);
  }
}

export async function listJobsHandler(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const jobs = await jobService.listJobs();
    return res.status(200).json(jobs);
  } catch (err) {
    next(err);
  }
}