import { redis } from "../config/redis";
import { cacheTotal } from "./metrics";

// Read-through cache. Any Redis problem falls back to the loader: the cache can be
// down or cold without changing what the API returns.
export async function cached<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  if (!redis) return loader();
  try {
    const hit = await redis.get(key);
    if (hit !== null) {
      cacheTotal.inc({ result: "hit" });
      return JSON.parse(hit) as T;
    }
  } catch {
    cacheTotal.inc({ result: "error" });
    return loader();
  }
  cacheTotal.inc({ result: "miss" });
  const value = await loader();
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    /* ignore: cache is best-effort */
  }
  return value;
}

// Invalidation by version: bumping the namespace version makes every old key unreachable
// (they simply expire), so we never need to scan and delete keys.
export async function cacheVersion(namespace: string): Promise<string> {
  if (!redis) return "0";
  try {
    return (await redis.get(`ver:${namespace}`)) ?? "0";
  } catch {
    return "0";
  }
}

export async function bumpCacheVersion(namespace: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.incr(`ver:${namespace}`);
  } catch {
    /* ignore */
  }
}
