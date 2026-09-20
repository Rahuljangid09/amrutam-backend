import { Prisma } from "@prisma/client";
import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { outboxTotal } from "../common/metrics";

export const MAX_ATTEMPTS = 8;
const LEASE_SECONDS = 60; // how long a claimed event is invisible to other workers

type Handler = (event: { id: string; type: string; aggregateId: string | null; payload: Record<string, unknown> }) => Promise<void>;

// Delivery side effects live here. In production each handler would call an email/SMS/push provider or
// publish to a broker; they must be idempotent, because delivery is at-least-once (a crash between
// "sent" and "marked processed" means the event is delivered again).
const notify = (channel: string, template: string): Handler => async (e) => {
  logger.info({ channel, template, eventId: e.id, aggregateId: e.aggregateId, payload: e.payload }, "notification dispatched");
};

export const handlers: Record<string, Handler> = {
  "consultation.confirmed": notify("email+sms", "booking_confirmed"),
  "consultation.cancelled": notify("email", "booking_cancelled"),
  "consultation.completed": notify("email", "consultation_summary"),
  "consultation.no_show": notify("email", "missed_consultation"),
  "prescription.issued": notify("email", "prescription_ready"), // deliberately carries ids only, never medical content
};

export const backoffSeconds = (attempts: number) => Math.min(5 * 2 ** (attempts - 1), 3600); // 5s, 10s, 20s ... capped at 1h

interface Claimed {
  id: string;
  type: string;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
}

// Claim = one atomic UPDATE. FOR UPDATE SKIP LOCKED lets many workers pull disjoint batches without
// blocking each other; pushing available_at forward is a lease, so a crashed worker's events reappear.
async function claim(batchSize: number): Promise<Claimed[]> {
  return prisma.$queryRaw<Claimed[]>(Prisma.sql`
    UPDATE outbox_events
       SET attempts = attempts + 1,
           available_at = now() + make_interval(secs => ${LEASE_SECONDS}::double precision)
     WHERE id IN (
       SELECT id FROM outbox_events
        WHERE status = 'PENDING' AND available_at <= now()
        ORDER BY created_at
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED)
    RETURNING id, type, aggregate_id, payload, attempts`);
}

export async function processOutbox(batchSize = 50): Promise<{ processed: number; retried: number; dead: number }> {
  const batch = await claim(batchSize);
  const tally = { processed: 0, retried: 0, dead: 0 };

  for (const row of batch) {
    try {
      const handler = handlers[row.type];
      if (!handler) throw new Error(`no handler for event type "${row.type}"`);
      await handler({ id: row.id, type: row.type, aggregateId: row.aggregate_id, payload: row.payload });
      await prisma.outboxEvent.update({ where: { id: row.id }, data: { status: "PROCESSED", processedAt: new Date(), lastError: null } });
      outboxTotal.inc({ result: "processed" });
      tally.processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message.slice(0, 500) : String(err);
      const dead = row.attempts >= MAX_ATTEMPTS;
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: dead
          ? { status: "DEAD", lastError: message }
          : { lastError: message, availableAt: new Date(Date.now() + backoffSeconds(row.attempts) * 1000) },
      });
      outboxTotal.inc({ result: dead ? "dead" : "retry" });
      dead ? tally.dead++ : tally.retried++;
      logger[dead ? "error" : "warn"]({ eventId: row.id, type: row.type, attempts: row.attempts, err: message }, dead ? "outbox event moved to DEAD" : "outbox event will be retried");
    }
  }
  return tally;
}
