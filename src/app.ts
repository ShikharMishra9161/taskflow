import path from "node:path";
import express from "express";
import mongoose from "mongoose";

import jobRoutes from "./routes/jobRoutes";
import authRoutes from "./routes/authRoutes";
import { errorHandler } from "./middleware/errorHandler";
import { redisClient } from "./config/redis";

export const app = express();

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// Dashboard (static, no build step). Resolves for both src/ (tsx) and dist/ (node).
app.use("/dashboard", express.static(path.join(__dirname, "..", "public", "dashboard")));
app.get("/", (_req, res) => res.redirect("/dashboard/"));

app.get("/health", async (_req, res) => {
  const mongo = mongoose.connection.readyState === 1 ? "ok" : "unavailable";

  let redis = "unavailable";
  try {
    redis = (await redisClient.ping()) === "PONG" ? "ok" : "unavailable";
  } catch {
    // reported as unavailable
  }

  const healthy = mongo === "ok" && redis === "ok";
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    mongo,
    redis,
    uptime: Math.round(process.uptime()),
  });
});

app.use(authRoutes);
app.use(jobRoutes);

app.use(errorHandler);

export default app;
