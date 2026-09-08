import request from "supertest";
import mongoose from "mongoose";
import { app } from "../app"; // adjust if your Express app isn't exported from app.ts
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET as string;

function makeToken(userId: string) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "1h" });
}

beforeAll(async () => {
  await mongoose.connect(process.env.MONGO_URI as string);
});

afterAll(async () => {
  await mongoose.connection.close();
});

describe("POST /jobs", () => {
  it("rejects missing type with 400", async () => {
    const token = makeToken("test-validation");
    const res = await request(app)
      .post("/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({ payload: { x: 1 } });

    expect(res.status).toBe(400);
  });

  it("rejects request with no auth header", async () => {
    const res = await request(app)
      .post("/jobs")
      .send({ type: "test", payload: {} });

    expect(res.status).toBe(401);
  });

  it("creates a job with valid auth and type", async () => {
    const token = makeToken("test-create");
    const res = await request(app)
      .post("/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "test-job", payload: { x: 1 } });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("QUEUED");
  });

  it("dedupes on idempotencyKey", async () => {
    const token = makeToken("test-idempotency");
    const key = `test-key-${Date.now()}`;

    const first = await request(app)
      .post("/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "test-job", payload: {}, idempotencyKey: key });

    const second = await request(app)
      .post("/jobs")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "test-job", payload: {}, idempotencyKey: key });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body._id).toBe(first.body._id);
  });
});