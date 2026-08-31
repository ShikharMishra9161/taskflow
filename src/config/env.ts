import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT;
const MONGO_URI = process.env.MONGO_URI;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

if (!PORT) {
  throw new Error("PORT is not defined");
}

if (!MONGO_URI) {
  throw new Error("MONGO_URI is not defined");
}

export const env = {
  PORT: Number(PORT),
  MONGO_URI,
  REDIS_URL,
};