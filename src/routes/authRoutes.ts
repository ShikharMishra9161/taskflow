import { Router } from "express";
import { issueToken } from "../controllers/authController";

const router = Router();
router.post("/auth/token", issueToken);
export default router;