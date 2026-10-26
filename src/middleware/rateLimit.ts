import { Response, NextFunction } from "express";
import { redisClient } from "../config/redis";
import { AuthedRequest } from "./auth";

export async function rateLimitMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
  const userId = req.userId;
  if (!userId) return next(); // auth middleware should run first

  const windowSeconds = Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60);
  const maxRequests = Number(process.env.RATE_LIMIT_MAX ?? 300);

  try {
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `ratelimit:${userId}:${window}`;

    const [[, count]] = (await redisClient
      .multi()
      .incr(key)
      .expire(key, windowSeconds)
      .exec()) as [[Error | null, number]];

    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - count));

    if (count > maxRequests) {
      return res.status(429).json({ error: "rate limit exceeded, try again later" });
    }

    next();
  } catch (err) {
    next(err);
  }
}
