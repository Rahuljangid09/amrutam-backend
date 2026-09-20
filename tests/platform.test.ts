import { beforeAll, describe, expect, it } from "vitest";
import { api, makePatient, resetDb } from "./helpers";

beforeAll(resetDb);

describe("health and observability", () => {
  it("liveness and readiness", async () => {
    expect((await api().get("/health")).body).toEqual({ status: "ok" });
    const ready = await api().get("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: "ready", database: "up" });
  });

  it("exposes Prometheus metrics with the SLO histogram and business counters", async () => {
    const p = await makePatient();
    await api().get("/api/v1/auth/me").set("Authorization", `Bearer ${p.accessToken}`);
    const res = await api().get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("http_request_duration_seconds_bucket");
    expect(res.text).toContain('route="/api/v1/auth/me"'); // route templates, not raw URLs
    expect(res.text).toContain("bookings_total");
    expect(res.text).toContain("process_cpu_seconds_total");
  });

  it("propagates or generates a request id", async () => {
    const generated = await api().get("/health");
    expect(generated.headers["x-request-id"]).toMatch(/[0-9a-f-]{36}/);
    const echoed = await api().get("/health").set("X-Request-Id", "trace-me-123");
    expect(echoed.headers["x-request-id"]).toBe("trace-me-123");
  });
});

describe("HTTP hygiene", () => {
  it("sets security headers and hides the framework", async () => {
    const res = await api().get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toBeTruthy();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("answers unknown routes with a JSON 404", async () => {
    const res = await api().get("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("answers malformed JSON with 400 and oversized bodies with 413, never 500", async () => {
    const bad = await api().post("/api/v1/auth/login").set("Content-Type", "application/json").send("{not json");
    expect(bad.status).toBe(400);
    const big = await api().post("/api/v1/auth/login").send({ email: "a@b.co", password: "x".repeat(200_000) });
    expect(big.status).toBe(413);
  });

  it("validates path parameters", async () => {
    const p = await makePatient();
    const res = await api().get("/api/v1/consultations/not-a-uuid").set("Authorization", `Bearer ${p.accessToken}`);
    expect(res.status).toBe(400);
  });
});
