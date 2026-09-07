import { Router } from "express";

import { authMiddleware } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rateLimit";

import {
  createJobHandler,
  getJobHandler,
  listJobsHandler,
} from "../controllers/jobController";

const router = Router();

router.post(
  "/jobs",
  authMiddleware,
  rateLimitMiddleware,
  createJobHandler
);

router.get("/jobs/:id", authMiddleware, rateLimitMiddleware, getJobHandler);

router.get("/jobs", authMiddleware, rateLimitMiddleware, listJobsHandler);

export default router;