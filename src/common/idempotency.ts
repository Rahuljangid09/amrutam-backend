import { createHash } from "crypto";
import { Request, RequestHandler, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { AppError } from "./errors";
import { idempotencyTotal } from "./metrics";

const KEY_TTL_MS = 24 * 60 * 60 * 1000;
const IN_FLIGHT_TIMEOUT_MS = 60_000; // a request that "never finished" (crash) can be retaken after this
const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;

// Same JSON with a different key order must hash the same.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function requestFingerprint(method: string, path: string, body: unknown): string {
  return createHash("sha256").update(`${method} ${path}\n${canonicalJson(body ?? null)}`).digest("hex");
}

type Claim = { kind: "new"; id: string } | { kind: "replay"; status: number; body: unknown };

// The unique (user_id, key) constraint is the lock: of N simultaneous requests with the same
// key exactly one INSERT succeeds; the rest see the row and either replay or get 409.
async function claim(userId: string, key: string, hash: string, attempt = 0): Promise<Claim> {
  try {
    const row = await prisma.idempotencyKey.create({
      data: { userId, key, requestHash: hash, expiresAt: new Date(Date.now() + KEY_TTL_MS) },
      select: { id: true },
    });
    return { kind: "new", id: row.id };
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }

  const existing = await prisma.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
  if (!existing) {
    // deleted between our insert and our read (expired / released): try again
    if (attempt < 3) return claim(userId, key, hash, attempt + 1);
    throw new AppError(409, "Idempotency conflict, retry", "IDEMPOTENCY_IN_PROGRESS");
  }

  if (existing.expiresAt < new Date()) {
    await prisma.idempotencyKey.deleteMany({ where: { id: existing.id } });
    if (attempt < 3) return claim(userId, key, hash, attempt + 1);
  }

  if (existing.requestHash !== hash) {
    idempotencyTotal.inc({ outcome: "mismatch" });
    throw new AppError(422, "Idempotency-Key was already used with a different request", "IDEMPOTENCY_KEY_REUSED");
  }

  if (existing.responseStatus !== null) {
    idempotencyTotal.inc({ outcome: "replay" });
    return { kind: "replay", status: existing.responseStatus, body: existing.responseBody };
  }

  // same key, same request, first attempt still running
  if (Date.now() - existing.createdAt.getTime() > IN_FLIGHT_TIMEOUT_MS && attempt < 3) {
    const freed = await prisma.idempotencyKey.deleteMany({ where: { id: existing.id, responseStatus: null } });
    if (freed.count > 0) return claim(userId, key, hash, attempt + 1);
  }
  idempotencyTotal.inc({ outcome: "in_progress" });
  throw new AppError(409, "A request with this Idempotency-Key is still being processed", "IDEMPOTENCY_IN_PROGRESS");
}

/**
 * Idempotent writes. Mount AFTER authenticate + validation, right before the handler.
 *  - first request with a key: runs the handler, stores status + body, then sends the response
 *  - repeat with same key + same request: replays the stored response (header Idempotent-Replayed: true)
 *  - same key, different request: 422
 *  - same key while the first is still running: 409 + Retry-After
 *  - 5xx responses are not stored, so the client can safely retry
 */
export function idempotency(opts: { required: boolean }): RequestHandler {
  return async (req: Request, res: Response, next) => {
    try {
      const key = req.get("Idempotency-Key");
      if (!key) {
        if (opts.required) {
          throw new AppError(400, "Idempotency-Key header is required for this endpoint", "IDEMPOTENCY_KEY_REQUIRED");
        }
        return next();
      }
      if (!KEY_PATTERN.test(key)) {
        throw new AppError(400, "Idempotency-Key must be 8-128 characters of letters, digits, - _ : .", "IDEMPOTENCY_KEY_INVALID");
      }
      if (!req.user) throw new AppError(401, "Missing token", "UNAUTHENTICATED");

      const hash = requestFingerprint(req.method, `${req.baseUrl}${req.path}`, req.body);
      const result = await claim(req.user.id, key, hash);

      if (result.kind === "replay") {
        res.setHeader("Idempotent-Replayed", "true");
        res.status(result.status).json(result.body);
        return;
      }

      idempotencyTotal.inc({ outcome: "first" });
      const { id } = result;
      let settled = false;
      const originalJson = res.json.bind(res);

      // Persist the outcome BEFORE the client sees it, so an immediate retry always finds it.
      res.json = ((body: unknown) => {
        if (settled) return originalJson(body);
        settled = true;
        const status = res.statusCode;
        const persist =
          status >= 500
            ? prisma.idempotencyKey.delete({ where: { id } })
            : prisma.idempotencyKey.update({
                where: { id },
                data: { responseStatus: status, responseBody: JSON.parse(JSON.stringify(body ?? null)) as Prisma.InputJsonValue },
              });
        persist
          .catch((err: unknown) => req.log.error({ err }, "idempotency persist failed"))
          .finally(() => originalJson(body));
        return res;
      }) as Response["json"];

      // client hung up / handler never produced JSON: free the key so a retry can run
      res.on("close", () => {
        if (settled) return;
        settled = true;
        prisma.idempotencyKey.deleteMany({ where: { id, responseStatus: null } }).catch(() => undefined);
      });

      next();
    } catch (err) {
      if (err instanceof AppError && err.code === "IDEMPOTENCY_IN_PROGRESS") res.setHeader("Retry-After", "1");
      next(err);
    }
  };
}
