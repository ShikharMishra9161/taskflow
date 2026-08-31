import { Request, Response, NextFunction } from "express";
import * as jobService from "../services/jobService";

function normalizePriority(priority: string): "high" | "default" | "low" {
  return priority.toLowerCase() as "high" | "default" | "low";
}

export async function createJobHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { type, payload, maxAttempts, priority } = req.body;
    if (!type || typeof type !== "string") {
      return res.status(400).json({ error: "type is required and must be a string" });
    }

    if (priority !== undefined && typeof priority !== "string") {
      return res.status(400).json({ error: "priority must be a string" });
    }

    if (priority !== undefined) {
      const normalized = priority.toLowerCase();
      if (!["high", "default", "low"].includes(normalized)) {
        return res.status(400).json({ error: "priority must be one of: high, default, low" });
      }
    }

    const job = await jobService.createJob({
      type,
      payload: payload ?? {},
      maxAttempts,
      priority: priority ? normalizePriority(priority) : undefined,
    });
    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
}

export async function getJobHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const jobId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const job = await jobService.getJobById(jobId);
    if (!job) return res.status(404).json({ error: "job not found" });
    res.json(job);
  } catch (err) {
    next(err);
  }
}

export async function listJobsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const jobs = await jobService.listJobs();
    res.json(jobs);
  } catch (err) {
    next(err);
  }
}