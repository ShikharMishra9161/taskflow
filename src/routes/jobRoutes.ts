import { Router } from "express";

import { authMiddleware } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rateLimit";

import {
  createJobHandler,
  getJobHandler,
  listJobsHandler,
  retryJobHandler,
  statsHandler,
} from "../controllers/jobController";

const router = Router();

router.post(
  "/jobs",
  authMiddleware,
  rateLimitMiddleware,
  createJobHandler
);

router.get("/jobs/:id", authMiddleware, rateLimitMiddleware, getJobHandler);

router.post("/jobs/:id/retry", authMiddleware, rateLimitMiddleware, retryJobHandler);

router.get("/jobs", authMiddleware, rateLimitMiddleware, listJobsHandler);

router.get("/stats", authMiddleware, rateLimitMiddleware, statsHandler);

export default router;
