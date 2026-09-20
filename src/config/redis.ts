import Redis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

// Redis is an accelerator, never a dependency of correctness:
// every caller must cope with `null` and with commands that fail.
export const redis: Redis | null = env.REDIS_URL
  ? new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false, // fail fast when Redis is down instead of queueing requests
      retryStrategy: (times) => Math.min(times * 200, 2000),
    })
  : null;

redis?.on("error", (err) => logger.warn({ err: err.message }, "redis error"));
