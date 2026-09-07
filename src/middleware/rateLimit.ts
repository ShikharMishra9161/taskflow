import { Response, NextFunction } from "express";
import { redisClient } from "../config/redis";
import { AuthedRequest } from "./auth";

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 10; // low on purpose, for easy testing

export async function rateLimitMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const userId = req.userId;
  if (!userId) return next(); // auth middleware should run first

  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const key = `ratelimit:${userId}:${window}`;

  const count = await redisClient.incr(key);
  if (count === 1) {
    await redisClient.expire(key, WINDOW_SECONDS);
  }

  if (count > MAX_REQUESTS) {
    return res.status(429).json({ error: "rate limit exceeded, try again later" });
  }

  next();
}