import "dotenv/config";
import mongoose from "mongoose";
import app from "./app";
import { connectDB } from "./config/db";
import { env } from "./config/env";
import { redisClient } from "./config/redis";

const startServer = async (): Promise<void> => {
  await connectDB();

  const server = app.listen(env.PORT, () => {
    console.log(`Server running on port ${env.PORT}`);
    console.log(`Dashboard: http://localhost:${env.PORT}/dashboard/`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    server.close(async () => {
      await mongoose.disconnect();
      redisClient.disconnect();
      process.exit(0);
    });
    // Force exit if connections don't drain in time.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

startServer().catch((error: Error) => {
  console.error(`API startup failed: ${error.message}`);
  process.exit(1);
});
