import app from "./app";
import { connectDB } from "./config/db";
import { env } from "./config/env";
import "dotenv/config";

const startServer = async (): Promise<void> => {
  await connectDB();

  app.listen(env.PORT, () => {
    console.log(`Server running on port ${env.PORT}`);
  });
};

startServer().catch((error: Error) => {
  console.error(`API startup failed: ${error.message}`);
  console.error("Start Redis on 127.0.0.1:6379, then run npm run dev again.");
  process.exit(1);
});