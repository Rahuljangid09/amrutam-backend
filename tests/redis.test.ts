import { spawn, spawnSync } from "child_process";
import bcrypt from "bcryptjs";
import Redis from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// These suites load a fresh copy of the app with Redis switched on (the other suites run without it).
// They are skipped when no test Redis is configured.
const REDIS_URL = process.env.TEST_REDIS_URL;
type App = Parameters<typeof request>[0];

async function loadApp(env: Record<string, string>): Promise<{ app: App; prisma: typeof import("../src/config/prisma").prisma }> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const { app } = await import("../src/app.js");
  const { prisma } = await import("../src/config/prisma.js");
  return { app: app as App, prisma };
}

describe.skipIf(!REDIS_URL)("with Redis", () => {
  let app: App;
  let prisma: Awaited<ReturnType<typeof loadApp>>["prisma"];
  let admin: Redis;

  beforeAll(async () => {
    admin = new Redis(REDIS_URL!);
    await admin.flushdb();
    ({ app, prisma } = await loadApp({ REDIS_URL: REDIS_URL!, RATE_LIMIT_ENABLED: "true" }));
  });
  afterAll(async () => {
    await admin.flushdb();
    admin.disconnect();
    vi.unstubAllEnvs();
  });

  it("readiness reports the cache as up", async () => {
    const res = await request(app).get("/health/ready");
    expect(res.body.cache).toBe("up");
  });

  it("rate limits login attempts across requests (429 after 20 per window)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 24; i++) codes.push((await request(app).post("/api/v1/auth/login").send({ email: "brute@force.dev", password: "wrong-password" })).status);
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes.slice(20).every((c) => c === 429)).toBe(true);
    const limited = await request(app).post("/api/v1/auth/login").send({ email: "brute@force.dev", password: "x" });
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(limited.headers["ratelimit"] ?? limited.headers["ratelimit-policy"]).toBeTruthy();
    // the counter lives in Redis, so it is shared by every API instance
    expect((await admin.keys("rl:auth:*")).length).toBeGreaterThan(0);
  });

  it("caches doctor search and invalidates it when a doctor is added", async () => {
    await admin.del(...(await admin.keys("rl:*")));
    const hash = await bcrypt.hash("Passw0rd!Test", 4);
    const adminUser = await prisma.user.create({ data: { email: `cache-admin-${Date.now()}@test.dev`, passwordHash: hash, role: "ADMIN" } });
    const patientUser = await prisma.user.create({ data: { email: `cache-patient-${Date.now()}@test.dev`, passwordHash: hash, role: "PATIENT" } });
    const login = async (email: string) => (await request(app).post("/api/v1/auth/login").send({ email, password: "Passw0rd!Test" })).body.accessToken as string;
    const adminToken = await login(adminUser.email);
    const patientToken = await login(patientUser.email);

    const search = () => request(app).get("/api/v1/doctors?specialization=Dermatology").set("Authorization", `Bearer ${patientToken}`);
    const before = await search();
    expect(before.status).toBe(200);
    const cachedKeys = async () => (await admin.keys("doctors:*")).length;
    expect(await cachedKeys()).toBeGreaterThan(0); // first call populated the cache
    expect((await search()).body).toEqual(before.body);
    const metrics = (await request(app).get("/metrics")).text;
    expect(metrics).toMatch(/cache_requests_total\{result="hit"\} [1-9]/);

    const created = await request(app).post("/api/v1/doctors").set("Authorization", `Bearer ${adminToken}`).send({
      email: `derm-${Date.now()}@test.dev`, password: "Passw0rd!Test", fullName: "Dr. Skin", specialization: "Dermatology", licenseNumber: `D-${Date.now()}`, consultationFee: 400,
    });
    expect(created.status).toBe(201);
    const after = await search();
    expect(JSON.stringify(after.body)).toContain("Dr. Skin"); // no stale list
  });
});

describe.skipIf(!REDIS_URL)("when Redis is down", () => {
  it("the API keeps serving: rate limiting fails open, caching falls back to the database", async () => {
    // nothing listens on this port
    const { app, prisma } = await loadApp({ REDIS_URL: "redis://127.0.0.1:6390", RATE_LIMIT_ENABLED: "true" });
    const ready = await request(app).get("/health/ready");
    expect(ready.status).toBe(200); // Redis is an accelerator, not a dependency
    expect(ready.body.cache).toBe("down");

    const hash = await bcrypt.hash("Passw0rd!Test", 4);
    const u = await prisma.user.create({ data: { email: `down-${Date.now()}@test.dev`, passwordHash: hash, role: "PATIENT" } });
    const login = await request(app).post("/api/v1/auth/login").send({ email: u.email, password: "Passw0rd!Test" });
    expect(login.status).toBe(200);
    const list = await request(app).get("/api/v1/doctors").set("Authorization", `Bearer ${login.body.accessToken}`);
    expect(list.status).toBe(200);
    vi.unstubAllEnvs();
  });
});

// Needs a redis-server binary on the machine running the tests (skipped otherwise).
const hasRedisServer = spawnSync("redis-server", ["--version"]).status === 0;

describe.skipIf(!REDIS_URL || !hasRedisServer)("when Redis starts AFTER the API", () => {
  it("rate limiting switches on by itself once Redis becomes reachable", async () => {
    const PORT = "6391";
    const { app } = await loadApp({ REDIS_URL: `redis://127.0.0.1:${PORT}`, RATE_LIMIT_ENABLED: "true" }); // Redis not running yet
    const attempt = async () => (await request(app).post("/api/v1/auth/login").send({ email: "late@redis.dev", password: "wrong-password" })).status;

    // Redis is down: requests are answered normally (fail open)
    for (let i = 0; i < 3; i++) expect(await attempt()).toBe(401);

    const server = spawn("redis-server", ["--port", PORT, "--save", "", "--appendonly", "no"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 1500)); // let it boot; ioredis reconnects on its own
      const codes: number[] = [];
      for (let i = 0; i < 24; i++) codes.push(await attempt());
      expect(codes).toContain(429); // the limiter is enforcing again without a restart
    } finally {
      server.kill();
      vi.unstubAllEnvs();
    }
  }, 30_000);
});
