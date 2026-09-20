import pino from "pino";
import { trace } from "@opentelemetry/api";
import { env } from "./env";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  base: { service: env.OTEL_SERVICE_NAME },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['idempotency-key']",
      "password",
      "*.password",
      "refreshToken",
      "*.refreshToken",
      "mfaToken",
      "code",
    ],
    censor: "[redacted]",
  },
  // attach the active trace id so a log line can be jumped to its trace
  mixin() {
    const ctx = trace.getActiveSpan()?.spanContext();
    return ctx ? { trace_id: ctx.traceId, span_id: ctx.spanId } : {};
  },
  ...(env.NODE_ENV === "development" && { transport: { target: "pino-pretty" } }),
});
