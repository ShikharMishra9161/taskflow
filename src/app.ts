import express from "express";
import jobRoutes from "./routes/jobRoutes";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

app.use(express.json());
app.use(jobRoutes);

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    redis: "unavailable",
  });
});

app.use(errorHandler);

export default app;