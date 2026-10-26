import "dotenv/config";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import jwt from "jsonwebtoken";
import app from "../app";
import { Job } from "../models/Job";
import { DLQ_KEY, redisClient, registerWorker, unregisterWorker } from "../config/redis";

let mongoServer: MongoMemoryServer;

function auth(userId = "api-test") {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET as string, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  process.env.JWT_SECRET ??= "test-secret";
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.connection.close();
  await mongoServer.stop();
  redisClient.disconnect();
});

describe("GET /health", () => {
  it("reports mongo and redis status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", mongo: "ok", redis: "ok" });
  });
});

describe("POST /auth/token", () => {
  afterEach(() => {
    delete process.env.AUTH_API_KEY;
  });

  it("issues a token without an api key when AUTH_API_KEY is unset", async () => {
    const res = await request(app).post("/auth/token").send({ userId: "u1" });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
  });

  it("requires a matching x-api-key when AUTH_API_KEY is set", async () => {
    process.env.AUTH_API_KEY = "s3cret";

    const missing = await request(app).post("/auth/token").send({ userId: "u1" });
    expect(missing.status).toBe(401);

    const wrong = await request(app).post("/auth/token").set("x-api-key", "nope").send({ userId: "u1" });
    expect(wrong.status).toBe(401);

    const ok = await request(app).post("/auth/token").set("x-api-key", "s3cret").send({ userId: "u1" });
    expect(ok.status).toBe(200);
  });
});

describe("POST /jobs validation", () => {
  it.each([
    [{ type: "t", priority: "urgent" }, "priority"],
    [{ type: "t", maxAttempts: 0 }, "maxAttempts"],
    [{ type: "t", payload: [1, 2] }, "payload"],
  ])("rejects %j", async (body, field) => {
    const res = await request(app).post("/jobs").set(auth()).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(field);
  });
});

describe("GET /jobs", () => {
  beforeAll(async () => {
    await Job.deleteMany({});
    await Job.create([
      { type: "list-a", status: "COMPLETED" },
      { type: "list-a", status: "DEAD" },
      { type: "list-b", status: "COMPLETED" },
    ]);
  });

  it("filters by status and type and reports X-Total-Count", async () => {
    const res = await request(app).get("/jobs?status=COMPLETED&type=list-a").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.headers["x-total-count"]).toBe("1");
  });

  it("paginates", async () => {
    const res = await request(app).get("/jobs?limit=2&page=2").set(auth());
    expect(res.body).toHaveLength(1);
    expect(res.headers["x-total-count"]).toBe("3");
  });

  it("rejects an unknown status", async () => {
    const res = await request(app).get("/jobs?status=BOGUS").set(auth());
    expect(res.status).toBe(400);
  });

  it("returns 404 for a malformed id", async () => {
    const res = await request(app).get("/jobs/not-an-object-id").set(auth());
    expect(res.status).toBe(404);
  });
});

describe("POST /jobs/:id/retry", () => {
  it("requeues a DEAD job and removes it from the DLQ", async () => {
    const job = await Job.create({ type: "retry-me", status: "DEAD", attempts: 3, error: "boom" });
    const id = job._id.toString();
    await redisClient.lpush(DLQ_KEY, id);

    const res = await request(app).post(`/jobs/${id}/retry`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect(res.body.error).toBeUndefined();

    const dlq = await redisClient.lrange(DLQ_KEY, 0, -1);
    expect(dlq).not.toContain(id);
  });

  it("refuses to retry a job that is not DEAD or FAILED", async () => {
    const job = await Job.create({ type: "busy", status: "PROCESSING" });
    const res = await request(app).post(`/jobs/${job._id}/retry`).set(auth());
    expect(res.status).toBe(409);
  });

  it("returns 404 for an unknown job", async () => {
    const res = await request(app).post(`/jobs/${new mongoose.Types.ObjectId()}/retry`).set(auth());
    expect(res.status).toBe(404);
  });
});

describe("GET /stats", () => {
  const workerId = "worker-test-stats";

  afterAll(async () => {
    await unregisterWorker(workerId);
  });

  it("requires auth", async () => {
    const res = await request(app).get("/stats");
    expect(res.status).toBe(401);
  });

  it("returns status counts, queue depths, throughput and workers", async () => {
    await registerWorker(
      {
        id: workerId,
        host: "test",
        pid: 1,
        startedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        currentJobId: null,
        processed: 0,
        failed: 0,
      },
      30
    );

    const res = await request(app).get("/stats").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.byStatus.COMPLETED).toBeGreaterThanOrEqual(2);
    expect(res.body.queues).toEqual(
      expect.objectContaining({ ready: expect.any(Number), delayed: expect.any(Number), dlq: expect.any(Number) })
    );
    expect(res.body.throughput).toHaveLength(60);
    expect(res.body.throughput.at(-1).completed).toBeGreaterThanOrEqual(2);
    expect(res.body.workers.map((w: { id: string }) => w.id)).toContain(workerId);
  });
});

describe("dashboard", () => {
  it("serves the dashboard and redirects / to it", async () => {
    const page = await request(app).get("/dashboard/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Taskflow");

    const root = await request(app).get("/");
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe("/dashboard/");
  });
});
