import { Request, Response } from "express";
import jwt from "jsonwebtoken";

export function issueToken(req: Request, res: Response) {
  const { userId } = req.body;
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "userId is required" });
  }

  // 1. Fetch the secret dynamically inside the execution block
  const secret = process.env.JWT_SECRET;

  // 2. Add a safety guard to catch configuration mistakes early
  if (!secret) {
    console.error("CRITICAL ERROR: process.env.JWT_SECRET is undefined.");
    return res.status(500).json({ error: "Server configuration error" });
  }

  // 3. Pass the verified secret string safely
  const token = jwt.sign({ userId }, secret, { expiresIn: "1h" });
  res.json({ token });
}
