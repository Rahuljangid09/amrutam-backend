import { randomUUID } from "crypto";
import express, { Request, Response } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { logger } from "./config/logger";
import { prisma } from "./config/prisma";
import { redis } from "./config/redis";
import { asyncHandler } from "./common/asyncHandler";
import { errorHandler, notFoundHandler } from "./common/errorHandler";
import { metricsHandler, metricsMiddleware } from "./common/metrics";
import { globalLimiter } from "./common/rateLimit";
import { env } from "./config/env";
import { authRouter } from "./modules/auth/auth.routes";
import { usersRouter } from "./modules/users/users.routes";
import { doctorsRouter } from "./modules/doctors/doctors.routes";
import { slotsRouter } from "./modules/slots/slots.routes";
import { bookingsRouter } from "./modules/bookings/bookings.routes";
import { paymentsRouter } from "./modules/payments/payments.routes";
import { consultationsRouter } from "./modules/consultations/consultations.routes";
import { prescriptionsRouter } from "./modules/prescriptions/prescriptions.routes";
import { adminRouter } from "./modules/admin/admin.routes";

export const app = express();

app.set("trust proxy", env.TRUST_PROXY); // so req.ip and rate limits see the real client behind a load balancer
app.use(
  pinoHttp({
    logger,
    // a request id ties together log lines, error responses and support tickets
    genReqId: (req, res) => {
      const incoming = req.headers["x-request-id"];
      const id = typeof incoming === "string" && incoming.length <= 100 ? incoming : randomUUID();
      res.setHeader("X-Request-Id", id);
      return id;
    },
    customProps: (req) => ({ userId: (req as Request).user?.id }),
    autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/health/ready" || req.url === "/metrics" },
  }),
);
app.use(metricsMiddleware);
app.use(helmet());
app.use(globalLimiter);
app.use(express.json({ limit: "100kb" }));

// liveness: the process is up (a failure restarts the container)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// readiness: can this instance serve traffic? (a failure removes it from the load balancer)
app.get(
  "/health/ready",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      res.status(503).json({ status: "unavailable", database: "down" });
      return;
    }
    // Redis is an accelerator: report it, but do not fail readiness when it is down
    let cache: "up" | "down" | "disabled" = "disabled";
    if (redis) cache = (await redis.ping().then(() => "up" as const).catch(() => "down" as const));
    res.json({ status: "ready", database: "up", cache });
  }),
);

app.get("/metrics", metricsHandler);

app.use("/api/v1/auth", authRouter);
app.use("/api/v1/users", usersRouter);
app.use("/api/v1/doctors", doctorsRouter);
app.use("/api/v1", slotsRouter);
app.use("/api/v1/bookings", bookingsRouter);
app.use("/api/v1/payments", paymentsRouter);
app.use("/api/v1/consultations", consultationsRouter);
app.use("/api/v1", prescriptionsRouter);
app.use("/api/v1/admin", adminRouter);

app.use(notFoundHandler);
app.use(errorHandler);
