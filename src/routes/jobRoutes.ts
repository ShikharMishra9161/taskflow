import { Router } from "express";
import { createJobHandler, getJobHandler, listJobsHandler } from "../controllers/jobController";

const router = Router();

router.post("/jobs", createJobHandler);
router.get("/jobs/:id", getJobHandler);
router.get("/jobs", listJobsHandler);

export default router;