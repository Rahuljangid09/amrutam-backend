import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/config/prisma";
import { MAX_ATTEMPTS, processOutbox } from "../src/jobs/outbox";
import { resetDb } from "./helpers";

beforeAll(resetDb);
beforeEach(async () => {
  await prisma.outboxEvent.deleteMany();
});

const emit = (type: string) => prisma.outboxEvent.create({ data: { type, aggregateId: "agg-1", payload: { hello: "world" } } });

describe("outbox worker", () => {
  it("delivers pending events and marks them processed", async () => {
    const e = await emit("consultation.confirmed");
    const tally = await processOutbox();
    expect(tally.processed).toBe(1);
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: e.id } });
    expect(row.status).toBe("PROCESSED");
    expect(row.processedAt).not.toBeNull();
    expect((await processOutbox()).processed).toBe(0); // nothing left
  });

  it("retries a failing event with backoff instead of hammering it", async () => {
    const e = await emit("no.such.handler");
    const before = Date.now();
    expect((await processOutbox()).retried).toBe(1);
    const row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: e.id } });
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain("no handler");
    expect(row.availableAt.getTime()).toBeGreaterThan(before + 4000); // ~5s backoff
    expect((await processOutbox()).retried).toBe(0); // not due yet
  });

  it("moves an event to DEAD after the maximum number of attempts", async () => {
    const e = await emit("no.such.handler");
    await prisma.outboxEvent.update({ where: { id: e.id }, data: { attempts: MAX_ATTEMPTS - 1 } });
    expect((await processOutbox()).dead).toBe(1);
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("DEAD");
  });

  it("two workers never process the same event twice (SKIP LOCKED lease)", async () => {
    await Promise.all(Array.from({ length: 40 }, () => emit("consultation.confirmed")));
    const tallies = await Promise.all([processOutbox(15), processOutbox(15), processOutbox(15), processOutbox(15)]);
    const processed = tallies.reduce((n, t) => n + t.processed, 0);
    expect(processed).toBe(40);
    const rows = await prisma.outboxEvent.findMany();
    expect(rows.every((r) => r.status === "PROCESSED" && r.attempts === 1)).toBe(true);
  });

  it("a crashed worker's claimed events reappear after the lease expires", async () => {
    const e = await emit("consultation.confirmed");
    // simulate: claimed (attempts bumped, lease in the future) but never finished
    await prisma.outboxEvent.update({ where: { id: e.id }, data: { attempts: 1, availableAt: new Date(Date.now() + 60_000) } });
    expect((await processOutbox()).processed).toBe(0);
    await prisma.outboxEvent.update({ where: { id: e.id }, data: { availableAt: new Date(Date.now() - 1000) } }); // lease over
    expect((await processOutbox()).processed).toBe(1);
  });
});
