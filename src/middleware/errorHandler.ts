import { Request, Response, NextFunction } from "express";

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  const status = err.statusCode || err.status || 500;
  if (status >= 500) console.error(err);
  // Don't leak internals (stack traces, driver messages) on server errors.
  const message = status >= 500 ? "Internal server error" : err.message;
  res.status(status).json({ error: message });
}
