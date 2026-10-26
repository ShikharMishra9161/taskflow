import { Request, Response } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

function apiKeyMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function issueToken(req: Request, res: Response) {
  const { userId } = req.body ?? {};
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "userId is required" });
  }

  // In production, token issuance is gated behind a shared API key.
  const apiKey = process.env.AUTH_API_KEY;
  if (apiKey && !apiKeyMatches(req.headers["x-api-key"], apiKey)) {
    return res.status(401).json({ error: "invalid api key" });
  }

  const secret = process.env.JWT_SECRET;

  if (!secret) {
    console.error("CRITICAL ERROR: process.env.JWT_SECRET is undefined.");
    return res.status(500).json({ error: "Server configuration error" });
  }

  const token = jwt.sign({ userId }, secret, { expiresIn: "1h" });
  res.json({ token, expiresIn: 3600 });
}
