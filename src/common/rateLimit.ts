import { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { env } from "../config/env";
import { redis } from "../config/redis";

const handler = (_req: Request, res: Response) => {
  res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests, try again later" } });
};

// rate-limit-redis loads its Lua scripts once, at startup. If Redis is unreachable at that moment the load
// fails for good, and the limiter would keep failing open until the process restarts (e.g. API booted before
// Redis in docker compose). This subclass tolerates a failed start and reloads the scripts on demand.
class ResilientRedisStore extends RedisStore {
  override async init(options: Parameters<RedisStore["init"]>[0]): Promise<void> {
    try {
      await super.init(options);
    } catch {
      /* Redis not reachable yet: scripts are loaded lazily on first use */
    }
  }
  override async increment(key: string) {
    try {
      return await super.increment(key);
    } catch {
      this.incrementScriptSha = this.loadIncrementScript(this.prefixKey(key));
      return super.increment(key); // still failing? the error reaches passOnStoreError and the request is let through
    }
  }
  override async get(key: string) {
    try {
      return await super.get(key);
    } catch {
      this.getScriptSha = this.loadGetScript(this.prefixKey(key));
      return super.get(key);
    }
  }
}

// Shared counters in Redis so the limit holds across all API instances.
// Without Redis, each instance keeps its own in-memory counters.
const client = redis;
const store = (prefix: string) =>
  client
    ? new ResilientRedisStore({
        prefix: `rl:${prefix}:`,
        sendCommand: (command: string, ...args: string[]) => client.call(command, ...args) as Promise<never>,
      })
    : undefined;

const common = {
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  handler,
  passOnStoreError: true, // if Redis is unreachable, fail open rather than take the API down
  skip: (req: Request) => !env.RATE_LIMIT_ENABLED || req.path === "/health" || req.path === "/health/ready" || req.path === "/metrics",
};

// whole API: 300 requests per minute per IP
export const globalLimiter = rateLimit({ ...common, windowMs: 60_000, limit: 300, store: store("global") });

// register / login / refresh / mfa: 20 per 15 minutes per IP (slows password and TOTP guessing)
export const authLimiter = rateLimit({ ...common, windowMs: 15 * 60_000, limit: 20, store: store("auth") });
