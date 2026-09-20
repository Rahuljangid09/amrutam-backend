import { RequestHandler } from "express";
import client from "prom-client";
import { env } from "../config/env";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

// Buckets include 0.2s and 0.5s so the p95 SLOs (reads < 200ms, writes < 500ms) are directly measurable.
export const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
  registers: [registry],
});

const counter = (name: string, help: string, labelNames: string[]) =>
  new client.Counter({ name, help, labelNames, registers: [registry] });

export const bookingsTotal = counter("bookings_total", "Booking attempts by result", ["result"]);
export const idempotencyTotal = counter("idempotency_requests_total", "Idempotency-Key handling by outcome", ["outcome"]);
export const outboxTotal = counter("outbox_events_total", "Outbox event processing by result", ["result"]);
export const holdsExpiredTotal = counter("slot_holds_expired_total", "Slot holds released by the expiry job", []);
export const cacheTotal = counter("cache_requests_total", "Cache lookups by result", ["result"]);
export const authEventsTotal = counter("auth_events_total", "Authentication events", ["event"]);

export const metricsMiddleware: RequestHandler = (req, res, next) => {
  const end = httpDuration.startTimer();
  res.on("finish", () => {
    // route template (not the raw URL) keeps label cardinality bounded
    const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : "unmatched";
    end({ method: req.method, route, status_code: String(res.statusCode) });
  });
  next();
};

export const metricsHandler: RequestHandler = async (req, res) => {
  if (env.METRICS_TOKEN && req.get("authorization") !== `Bearer ${env.METRICS_TOKEN}`) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Invalid metrics token" } });
    return;
  }
  res.setHeader("Content-Type", registry.contentType);
  res.send(await registry.metrics());
};
