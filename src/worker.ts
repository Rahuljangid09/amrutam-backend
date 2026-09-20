import "./tracing"; // must stay first
import { createServer } from "http";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { prisma } from "./config/prisma";
import { redis } from "./config/redis";
import { registry } from "./common/metrics";
import { releaseExpiredHolds } from "./jobs/holdExpiry";
import { processOutbox } from "./jobs/outbox";
import { ensureAuditPartitions, purgeStaleRows, refreshRecentDailyStats } from "./jobs/maintenance";

// Background worker: a separate process from the API so slow jobs never compete with request latency,
// and so it can be scaled independently. Every job is safe to run on several instances at once.
const HOURLY = 60 * 60 * 1000;
let running = true;
let lastHourly = 0;

async function tick() {
  await releaseExpiredHolds().catch((err) => logger.error({ err }, "hold expiry failed"));
  await processOutbox().catch((err) => logger.error({ err }, "outbox processing failed"));
  if (Date.now() - lastHourly >= HOURLY) {
    lastHourly = Date.now();
    await ensureAuditPartitions().catch((err) => logger.error({ err }, "partition maintenance failed"));
    await refreshRecentDailyStats().catch((err) => logger.error({ err }, "daily stats refresh failed"));
    await purgeStaleRows().catch((err) => logger.error({ err }, "purge failed"));
  }
}

async function loop() {
  while (running) {
    await tick();
    // sleep in small steps so shutdown is prompt
    for (let waited = 0; running && waited < env.WORKER_POLL_MS; waited += 250) await new Promise((r) => setTimeout(r, 250));
  }
}

// the worker exposes its own metrics (outbox and hold-expiry counters live in this process)
const metricsServer = createServer(async (req, res) => {
  if (req.url === "/metrics") {
    res.setHeader("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  } else {
    res.statusCode = 200;
    res.end("ok");
  }
}).listen(env.WORKER_METRICS_PORT, () => logger.info({ port: env.WORKER_METRICS_PORT }, "worker started"));

async function shutdown(signal: string) {
  logger.info({ signal }, "worker shutting down");
  running = false;
  metricsServer.close();
  setTimeout(() => process.exit(1), 10_000).unref();
  await loopDone; // let the tick in progress finish before closing the pools
  await prisma.$disconnect().catch(() => undefined);
  redis?.disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const loopDone = loop();
