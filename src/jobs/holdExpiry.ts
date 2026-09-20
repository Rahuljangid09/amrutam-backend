import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { lockSlot } from "../common/db";
import { writeAudit } from "../common/audit";
import { emitEvent } from "../common/outbox";
import { holdsExpiredTotal } from "../common/metrics";
import { releaseHold } from "../modules/payments/payments.service";

// Releases slots whose payment window has passed (saga compensation, timeout branch).
//
// Correctness never depends on this job: booking takes over an expired hold, and payment rejects an expired
// one. The job exists so expired holds do not linger, and so the unpaid consultation is closed and the
// patient is told. Each slot is handled in its own short transaction using the same lock order as every
// other slot mutation (slot row first), so it can run on many instances at once.
export async function releaseExpiredHolds(batchSize = 100): Promise<number> {
  const candidates = await prisma.availabilitySlot.findMany({
    where: { status: "HELD", heldUntil: { lt: new Date() } },
    select: { id: true },
    orderBy: { heldUntil: "asc" },
    take: batchSize,
  });

  let released = 0;
  for (const { id: slotId } of candidates) {
    try {
      const done = await prisma.$transaction(async (tx) => {
        await lockSlot(tx, slotId);
        // re-check under the lock: the patient may have paid a moment ago
        const slot = await tx.availabilitySlot.findUnique({ where: { id: slotId } });
        if (!slot || slot.status !== "HELD" || !slot.heldUntil || slot.heldUntil >= new Date()) return false;

        const pending = await tx.consultation.findFirst({ where: { slotId, status: "PENDING_PAYMENT" }, select: { id: true, slotId: true, status: true, patientId: true } });
        if (pending) {
          await releaseHold(tx, pending, "hold_expired");
          await emitEvent(tx, "consultation.cancelled", pending.id, { consultationId: pending.id, reason: "hold_expired" });
          await writeAudit(tx, { actorRole: null }, { action: "SLOT_HOLD_EXPIRED", entityType: "consultation", entityId: pending.id });
        } else {
          // a HELD slot with nothing waiting on it: just free it
          await tx.availabilitySlot.updateMany({ where: { id: slotId, status: "HELD" }, data: { status: "AVAILABLE", heldUntil: null, version: { increment: 1 } } });
        }
        return true;
      });
      if (done) {
        released++;
        holdsExpiredTotal.inc();
      }
    } catch (err) {
      // one bad slot must not block the rest of the batch
      logger.error({ err, slotId }, "failed to release expired hold");
    }
  }
  if (released > 0) logger.info({ released }, "released expired slot holds");
  return released;
}
