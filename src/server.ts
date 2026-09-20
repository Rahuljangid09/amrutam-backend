import "./tracing"; // must stay first
import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { prisma } from "./config/prisma";
import { redis } from "./config/redis";
import { ensureAuditPartitions } from "./jobs/maintenance";

// audit_logs is partitioned by month: make sure the upcoming months exist (idempotent, the worker also does this)
ensureAuditPartitions().catch((err: unknown) => logger.warn({ err }, "could not ensure audit partitions"));

const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, "API listening"));
// keep-alive longer than typical load-balancer idle timeouts, or clients see random connection resets
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// Graceful shutdown: stop accepting connections, let in-flight requests finish, then close the pools.
function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(async () => {
    await prisma.$disconnect().catch(() => undefined);
    redis?.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => logger.error({ reason }, "unhandled rejection"));
