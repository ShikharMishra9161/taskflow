import { Schema, model, Document } from "mongoose";
import { JobStatus, JobPriority } from "../types/job";

export interface JobDocument extends Document {
  type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: JobPriority;
  attempts: number;
  maxAttempts: number;
  result?: unknown;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  workerId?: string;
  lastHeartbeatAt?: Date;
  idempotencyKey?: string;

}

const jobSchema = new Schema<JobDocument>(
  {
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ["CREATED", "QUEUED", "PROCESSING", "COMPLETED", "FAILED", "RETRY_SCHEDULED", "DEAD"],
      default: "CREATED",
    },
    priority: {
      type: String,
      enum: ["high", "default", "low"],
      default: "default",
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    result: { type: Schema.Types.Mixed },
    error: { type: String },
    workerId: { type: String },
    lastHeartbeatAt: { type: Date },
    idempotencyKey: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

export const Job = model<JobDocument>("Job", jobSchema);