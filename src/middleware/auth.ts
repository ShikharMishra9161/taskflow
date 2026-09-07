import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthedRequest extends Request {
  userId?: string;
}

export function authMiddleware(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "missing or malformed authorization header",
    });
  }

  const token = authHeader.split(" ")[1];

  const secret = process.env.JWT_SECRET;

  if (!secret) {
    console.error("JWT_SECRET is not configured");
    return res.status(500).json({
      error: "Server configuration error",
    });
  }

  try {
    const decoded = jwt.verify(token, secret) as { userId: string };

    req.userId = decoded.userId;

    next();
  } catch (err) {
    return res.status(401).json({
      error: "invalid or expired token",
    });
  }
}