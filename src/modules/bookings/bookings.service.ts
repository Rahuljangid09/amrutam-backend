import { randomUUID } from "crypto";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { AppError, notFound } from "../../common/errors";
import { AuditContext, writeAudit } from "../../common/audit";
import { bookingsTotal } from "../../common/metrics";

const MAX_ACTIVE_HOLDS_PER_PATIENT = 3; // stops one account from locking up a doctor's calendar

/**
 * Booking = first step of a saga:
 *   1. HOLD the slot and create the consultation (PENDING_PAYMENT) + payment (INITIATED)   <- this function, one DB transaction
 *   2. pay          -> CONFIRMED, slot BOOKED                                             <- payments.service
 *   2b. pay fails / hold expires / patient cancels -> compensation: slot AVAILABLE again  <- payments / worker / consultations
 *
 * Concurrency: the "claim" is a single conditional UPDATE. Postgres row-locks the slot, so of N
 * simultaneous requests exactly one sees the slot as free; the rest match 0 rows and get 409.
 * The partial unique index uniq_active_consultation_per_slot is a second, independent safety net.
 */
export async function createBooking(patientId: string, slotId: string, ctx: AuditContext) {
  const now = new Date();
  const holdUntil = new Date(now.getTime() + env.SLOT_HOLD_MINUTES * 60_000);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const activeHolds = await tx.consultation.count({
        where: { patientId, status: "PENDING_PAYMENT", slot: { heldUntil: { gt: now } } },
      });
      if (activeHolds >= MAX_ACTIVE_HOLDS_PER_PATIENT) {
        throw new AppError(429, "Too many unpaid bookings; pay or cancel one first", "TOO_MANY_HOLDS");
      }

      const claimed = await tx.availabilitySlot.updateMany({
        where: {
          id: slotId,
          startTime: { gt: now },
          OR: [{ status: "AVAILABLE" }, { status: "HELD", heldUntil: { lt: now } }], // free, or hold expired
        },
        data: { status: "HELD", heldUntil: holdUntil, version: { increment: 1 } },
      });
      if (claimed.count === 0) {
        const exists = await tx.availabilitySlot.findUnique({ where: { id: slotId }, select: { id: true } });
        throw exists ? new AppError(409, "Slot is not available", "SLOT_UNAVAILABLE") : notFound("Slot");
      }

      // We took over an expired hold: retire the previous, never-paid consultation first.
      const stale = await tx.consultation.findMany({ where: { slotId, status: "PENDING_PAYMENT" }, select: { id: true } });
      if (stale.length > 0) {
        const ids = stale.map((s) => s.id);
        await tx.consultation.updateMany({ where: { id: { in: ids } }, data: { status: "CANCELLED", cancellationReason: "hold_expired" } });
        await tx.payment.updateMany({ where: { consultationId: { in: ids }, status: "INITIATED" }, data: { status: "FAILED" } });
      }

      const slot = await tx.availabilitySlot.findUniqueOrThrow({
        where: { id: slotId },
        include: { doctor: { select: { consultationFee: true } } },
      });

      const consultationId = randomUUID();
      const consultation = await tx.consultation.create({
        data: { id: consultationId, patientId, doctorId: slot.doctorId, slotId, scheduledAt: slot.startTime },
        select: { id: true, status: true, scheduledAt: true, doctorId: true, slotId: true },
      });
      const payment = await tx.payment.create({
        data: { consultationId, patientId, amount: slot.doctor.consultationFee, idempotencyKey: `pay:${consultationId}` },
        select: { id: true, amount: true, currency: true, status: true },
      });
      await writeAudit(tx, ctx, { action: "CONSULTATION_BOOKED", entityType: "consultation", entityId: consultationId, metadata: { slotId, doctorId: slot.doctorId } });

      return { consultation, payment: { ...payment, amount: payment.amount.toString() }, holdExpiresAt: holdUntil };
    });
    bookingsTotal.inc({ result: "created" });
    return result;
  } catch (e) {
    bookingsTotal.inc({ result: e instanceof AppError ? e.code.toLowerCase() : "error" });
    throw e;
  }
}
