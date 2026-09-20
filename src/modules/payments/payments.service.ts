import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError, notFound } from "../../common/errors";
import { AuditContext, writeAudit } from "../../common/audit";
import { lockSlot } from "../../common/db";
import { emitEvent } from "../../common/outbox";

type Tx = Prisma.TransactionClient;

const view = (
  payment: { id: string; status: string; amount: Prisma.Decimal; currency: string },
  consultation: { id: string; status: string; scheduledAt: Date },
) => ({
  payment: { id: payment.id, status: payment.status, amount: payment.amount.toString(), currency: payment.currency },
  consultation: { id: consultation.id, status: consultation.status, scheduledAt: consultation.scheduledAt },
});

// Compensating action of the saga: give the slot back and close the unpaid consultation.
export async function releaseHold(tx: Tx, c: { id: string; slotId: string; status: string }, reason: string) {
  await tx.payment.updateMany({ where: { consultationId: c.id, status: "INITIATED" }, data: { status: "FAILED" } });
  await tx.consultation.updateMany({ where: { id: c.id, status: "PENDING_PAYMENT" }, data: { status: "CANCELLED", cancellationReason: reason } });
  // only release the slot if the hold is still ours (a takeover would already have cancelled this consultation)
  if (c.status === "PENDING_PAYMENT") {
    await tx.availabilitySlot.updateMany({ where: { id: c.slotId, status: "HELD" }, data: { status: "AVAILABLE", heldUntil: null, version: { increment: 1 } } });
  }
}

export async function payBooking(paymentId: string, patientId: string, outcome: "success" | "failure", ctx: AuditContext) {
  // ownership check first; a foreign or unknown payment is a plain 404
  const initial = await prisma.payment.findUnique({ where: { id: paymentId }, select: { patientId: true, consultation: { select: { slotId: true } } } });
  if (!initial || initial.patientId !== patientId) throw notFound("Payment");
  const slotId = initial.consultation.slotId;

  const result = await prisma.$transaction(async (tx) => {
    await lockSlot(tx, slotId); // serializes with booking, cancellation and the hold-expiry job
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { consultation: true } });
    const c = payment.consultation;

    // Repeating a successful payment is a no-op that returns the same result.
    if (payment.status === "SUCCEEDED" && outcome === "success") return { kind: "confirmed" as const, ...view(payment, c) };
    if (payment.status !== "INITIATED") throw new AppError(409, "This payment can no longer be paid", "PAYMENT_NOT_PAYABLE");

    const now = new Date();
    const slot = await tx.availabilitySlot.findUniqueOrThrow({ where: { id: slotId } });
    const holdValid = c.status === "PENDING_PAYMENT" && slot.status === "HELD" && slot.heldUntil !== null && slot.heldUntil > now;

    if (outcome === "failure" || !holdValid) {
      await releaseHold(tx, c, outcome === "failure" ? "payment_failed" : "hold_expired");
      await writeAudit(tx, ctx, { action: "PAYMENT_FAILED", entityType: "payment", entityId: paymentId, metadata: { reason: outcome === "failure" ? "declined" : "hold_expired" } });
      await emitEvent(tx, "consultation.cancelled", c.id, { consultationId: c.id, reason: "payment_failed" });
      return { kind: outcome === "failure" ? ("failed" as const) : ("expired" as const), ...view({ ...payment, status: "FAILED" }, { ...c, status: "CANCELLED" }) };
    }

    // Happy path: three state changes, all-or-nothing.
    await tx.availabilitySlot.updateMany({ where: { id: slotId, status: "HELD" }, data: { status: "BOOKED", heldUntil: null, version: { increment: 1 } } });
    const paid = await tx.payment.update({ where: { id: paymentId }, data: { status: "SUCCEEDED", providerRef: `mock_${randomUUID()}` } });
    const confirmed = await tx.consultation.update({ where: { id: c.id }, data: { status: "CONFIRMED" } });
    await writeAudit(tx, ctx, { action: "PAYMENT_SUCCEEDED", entityType: "payment", entityId: paymentId });
    await emitEvent(tx, "consultation.confirmed", c.id, { consultationId: c.id, patientId: c.patientId, doctorId: c.doctorId, scheduledAt: c.scheduledAt.toISOString() });
    return { kind: "confirmed" as const, ...view(paid, confirmed) };
  });

  // The compensation above is committed; only now tell the client the hold had expired.
  if (result.kind === "expired") throw new AppError(409, "The slot hold expired; please book again", "HOLD_EXPIRED");
  const { kind: _kind, ...body } = result;
  return body;
}
