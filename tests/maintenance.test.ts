import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/config/prisma";
import { purgeStaleRows } from "../src/jobs/maintenance";
import { makePatient, resetDb } from "./helpers";

beforeAll(resetDb);
const days = (n: number) => new Date(Date.now() + n * 86400_000);

describe("housekeeping", () => {
  it("purges expired idempotency keys, old refresh tokens and old delivered events; keeps everything still useful", async () => {
    const p = await makePatient();
    await prisma.idempotencyKey.createMany({
      data: [
        { userId: p.id, key: "expired-key", requestHash: "h", expiresAt: days(-1) },
        { userId: p.id, key: "live-key", requestHash: "h", expiresAt: days(1) },
      ],
    });
    await prisma.refreshToken.createMany({
      data: [
        { userId: p.id, tokenHash: "old-expired", expiresAt: days(-40) },
        { userId: p.id, tokenHash: "old-revoked", expiresAt: days(10), revokedAt: days(-31) },
        { userId: p.id, tokenHash: "recently-revoked", expiresAt: days(10), revokedAt: days(-1) },
      ],
    });
    await prisma.outboxEvent.createMany({
      data: [
        { type: "x", payload: {}, status: "PROCESSED", processedAt: days(-15) },
        { type: "x", payload: {}, status: "PROCESSED", processedAt: days(-1) },
        { type: "x", payload: {}, status: "DEAD" },
        { type: "x", payload: {}, status: "PENDING" },
      ],
    });

    const result = await purgeStaleRows();
    expect(result).toEqual({ idempotencyKeys: 1, refreshTokens: 2, outboxEvents: 1 });

    expect((await prisma.idempotencyKey.findMany({ where: { userId: p.id } })).map((k) => k.key)).toEqual(["live-key"]);
    const tokens = (await prisma.refreshToken.findMany({ where: { tokenHash: { in: ["old-expired", "old-revoked", "recently-revoked"] } } })).map((t) => t.tokenHash);
    expect(tokens).toEqual(["recently-revoked"]);
    expect(await prisma.outboxEvent.count({ where: { status: "DEAD" } })).toBe(1); // a human must look at these
    expect(await prisma.outboxEvent.count({ where: { status: "PENDING" } })).toBe(1);

    expect(await purgeStaleRows()).toEqual({ idempotencyKeys: 0, refreshTokens: 0, outboxEvents: 0 }); // idempotent
  });
});
