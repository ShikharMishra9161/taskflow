
export type JobStatus =
  | "CREATED"
  | "QUEUED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "RETRY_SCHEDULED"
  | "DEAD";

export type JobPriority = "high" | "default" | "low";

export interface JobInput {
  type: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  priority?: JobPriority;
  idempotencyKey?: string;
}