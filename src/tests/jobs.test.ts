import "dotenv/config";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app";
import jwt from "jsonwebtoken";
import { redisClient } from "../config/redis";

let mongoServer: MongoMemoryServer;

function makeToken(userId: string) {
  const secret = process.env.JWT_SECRET || "test-secret";
  return jwt.sign({ userId }, secret, { expiresIn: "1h" });
}

beforeAll(async () => {
  process.env.JWT_SECRET ??= "test-secret";

  mongoServer = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongoServer.getUri();

  await mongoose.connect(process.env.MONGO_URI as string);
});

afterAll(async () => {
  await mongoose.connection.close();
  redisClient.disconnect();
});


describe("POST /jobs", () => {
  it("rejects missing type with 400", async () => {
    const token = makeToken("test-validation");

    const res = await request(app)
      .post("/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        payload: { x: 1 },
      });

    expect(res.status).toBe(400);
  });

  it("rejects request with no auth header", async () => {
    const res = await request(app)
      .post("/jobs")
      .send({
        type: "test",
        payload: {},
      });

    expect(res.status).toBe(401);
  });

  it("creates a job with valid auth and type", async () => {
    const token = makeToken("test-create");

    const res = await request(app)
      .post("/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "test-job",
        payload: { x: 1 },
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("QUEUED");
  });

  it("dedupes on idempotencyKey", async () => {
    const token = makeToken("test-idempotency");
    const key = `test-key-${Date.now()}`;

    const first = await request(app)
      .post("/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "test-job",
        payload: {},
        idempotencyKey: key,
      });

    const second = await request(app)
      .post("/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "test-job",
        payload: {
          different: "payload",
        },
        idempotencyKey: key,
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body._id).toBe(first.body._id);
  });
});