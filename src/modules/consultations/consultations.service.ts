import { Prisma, Role } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { conflict, notFound } from "../../common/errors";
import { AuditContext, writeAudit } from "../../common/audit";
import { crypto } from "../../common/crypto";
import { lockSlot } from "../../common/db";
import { emitEvent } from "../../common/outbox";
import { ListConsultationsQuery } from "./consultations.schema";

export interface Actor {
  id: string;
  role: Role;
}

const START_EARLY_MS = 10 * 60_000; // doctor may start 10 min before the slot
const NO_SHOW_GRACE_MS = 10 * 60_000; // no-show can be recorded 10 min after the slot start
const notesAad = (id: string) => `consultation-notes:${id}`;

const listSelect = {
  id: true,
  status: true,
  scheduledAt: true,
  startedAt: true,
  endedAt: true,
  cancellationReason: true,
  doctorId: true,
  patientId: true,
  doctor: { select: { specialization: true, user: { select: { profile: { select: { fullName: true } } } } } },
  patient: { select: { profile: { select: { fullName: true } } } },
} satisfies Prisma.ConsultationSelect;

type ListRow = Prisma.ConsultationGetPayload<{ select: typeof listSelect }>;

const shape = (c: ListRow) => ({
  id: c.id,
  status: c.status,
  scheduledAt: c.scheduledAt,
  startedAt: c.startedAt,
  endedAt: c.endedAt,
  cancellationReason: c.cancellationReason,
  doctor: { id: c.doctorId, name: c.doctor.user.profile?.fullName ?? null, specialization: c.doctor.specialization },
  patient: { id: c.patientId, name: c.patient.profile?.fullName ?? null },
});

async function doctorIdOf(userId: string) {
  return (await prisma.doctor.findUnique({ where: { userId }, select: { id: true } }))?.id ?? null;
}

// Patients see their own, doctors see theirs, admins see everything. Anything else is a 404 (no existence leak).
async function accessFilter(actor: Actor): Promise<Prisma.ConsultationWhereInput> {
  if (actor.role === "ADMIN") return {};
  if (actor.role === "PATIENT") return { patientId: actor.id };
  const doctorId = await doctorIdOf(actor.id);
  return { doctorId: doctorId ?? "00000000-0000-0000-0000-000000000000" };
}

export async function listConsultations(actor: Actor, q: ListConsultationsQuery) {
  const where: Prisma.ConsultationWhereInput = {
    ...(await accessFilter(actor)),
    ...(q.status && { status: q.status }),
    ...((q.from || q.to) && { scheduledAt: { ...(q.from && { gte: q.from }), ...(q.to && { lt: q.to }) } }),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.consultation.count({ where }),
    prisma.consultation.findMany({ where, select: listSelect, orderBy: [{ scheduledAt: "desc" }, { id: "asc" }], skip: (q.page - 1) * q.limit, take: q.limit }),
  ]);
  return { items: rows.map(shape), page: q.page, limit: q.limit, total };
}

export async function getConsultation(actor: Actor, id: string, ctx: AuditContext) {
  const row = await prisma.consultation.findFirst({
    where: { id, ...(await accessFilter(actor)) },
    select: { ...listSelect, notesEnc: true },
  });
  if (!row) throw notFound("Consultation");
  // Clinical notes are visible to the patient and the treating doctor only, never to admins.
  const notes = actor.role !== "ADMIN" && row.notesEnc ? crypto.decrypt(row.notesEnc, notesAad(id)) : null;
  await writeAudit(prisma, ctx, { action: "CONSULTATION_VIEWED", entityType: "consultation", entityId: id });
  return { ...shape(row), notes };
}

// ── doctor actions ────────────────────────────────────────────────────────────

async function ownedByDoctor(userId: string, id: string) {
  const c = await prisma.consultation.findUnique({
    where: { id },
    include: { doctor: { select: { userId: true } }, slot: { select: { startTime: true, endTime: true } } },
  });
  if (!c || c.doctor.userId !== userId) throw notFound("Consultation");
  return c;
}

const brief = (c: { id: string; status: string; scheduledAt: Date; startedAt: Date | null; endedAt: Date | null }) => ({
  id: c.id,
  status: c.status,
  scheduledAt: c.scheduledAt,
  startedAt: c.startedAt,
  endedAt: c.endedAt,
});

const invalidState = (from: string, action: string) => conflict(`Cannot ${action} a consultation that is ${from}`, "INVALID_STATE");

// State changes use "UPDATE ... WHERE status = <expected>": two racing requests cannot both apply.
// Repeating an action that already happened returns the current state (safe to retry).
export async function startConsultation(userId: string, id: string, ctx: AuditContext) {
  const c = await ownedByDoctor(userId, id);
  if (c.status === "IN_PROGRESS") return brief(c);
  if (c.status !== "CONFIRMED") throw invalidState(c.status, "start");
  const now = new Date();
  if (now.getTime() < c.slot.startTime.getTime() - START_EARLY_MS) throw conflict("Too early to start this consultation", "TOO_EARLY");
  if (now > c.slot.endTime) throw conflict("The slot has already ended", "SLOT_ENDED");

  const updated = await prisma.consultation.updateMany({ where: { id, status: "CONFIRMED" }, data: { status: "IN_PROGRESS", startedAt: now } });
  const fresh = await prisma.consultation.findUniqueOrThrow({ where: { id } });
  if (updated.count === 0 && fresh.status !== "IN_PROGRESS") throw invalidState(fresh.status, "start");
  if (updated.count > 0) await writeAudit(prisma, ctx, { action: "CONSULTATION_STARTED", entityType: "consultation", entityId: id });
  return brief(fresh);
}

export async function completeConsultation(userId: string, id: string, notes: string | undefined, ctx: AuditContext) {
  const c = await ownedByDoctor(userId, id);
  if (c.status === "COMPLETED") return brief(c);
  if (c.status !== "IN_PROGRESS") throw invalidState(c.status, "complete");

  const done = await prisma.$transaction(async (tx) => {
    const updated = await tx.consultation.updateMany({
      where: { id, status: "IN_PROGRESS" },
      data: { status: "COMPLETED", endedAt: new Date(), ...(notes && { notesEnc: crypto.encrypt(notes, notesAad(id)) }) },
    });
    if (updated.count === 0) return null;
    await writeAudit(tx, ctx, { action: "CONSULTATION_COMPLETED", entityType: "consultation", entityId: id });
    await emitEvent(tx, "consultation.completed", id, { consultationId: id, patientId: c.patientId });
    return tx.consultation.findUniqueOrThrow({ where: { id } });
  });
  if (!done) {
    const fresh = await prisma.consultation.findUniqueOrThrow({ where: { id } });
    if (fresh.status === "COMPLETED") return brief(fresh);
    throw invalidState(fresh.status, "complete");
  }
  return brief(done);
}

export async function markNoShow(userId: string, id: string, ctx: AuditContext) {
  const c = await ownedByDoctor(userId, id);
  if (c.status === "NO_SHOW") return brief(c);
  if (c.status !== "CONFIRMED") throw invalidState(c.status, "mark as no-show");
  if (Date.now() < c.slot.startTime.getTime() + NO_SHOW_GRACE_MS) throw conflict("Wait until 10 minutes after the start time", "TOO_EARLY");

  const done = await prisma.$transaction(async (tx) => {
    const updated = await tx.consultation.updateMany({ where: { id, status: "CONFIRMED" }, data: { status: "NO_SHOW" } });
    if (updated.count === 0) return null;
    await writeAudit(tx, ctx, { action: "CONSULTATION_NO_SHOW", entityType: "consultation", entityId: id });
    await emitEvent(tx, "consultation.no_show", id, { consultationId: id, patientId: c.patientId });
    return tx.consultation.findUniqueOrThrow({ where: { id } });
  });
  if (!done) {
    const fresh = await prisma.consultation.findUniqueOrThrow({ where: { id } });
    if (fresh.status === "NO_SHOW") return brief(fresh);
    throw invalidState(fresh.status, "mark as no-show");
  }
  return brief(done);
}

// ── cancellation (patient, doctor or admin) ───────────────────────────────────

export async function cancelConsultation(actor: Actor, id: string, reason: string | undefined, ctx: AuditContext) {
  const found = await prisma.consultation.findFirst({ where: { id, ...(await accessFilter(actor)) }, select: { slotId: true } });
  if (!found) throw notFound("Consultation");

  return prisma.$transaction(async (tx) => {
    await lockSlot(tx, found.slotId); // same lock order as booking / payment / expiry
    const c = await tx.consultation.findUniqueOrThrow({ where: { id } });

    if (c.status === "CANCELLED") return brief(c); // already done: idempotent
    if (c.status !== "PENDING_PAYMENT" && c.status !== "CONFIRMED") throw invalidState(c.status, "cancel");

    const now = Date.now();
    if (actor.role === "PATIENT" && c.status === "CONFIRMED" && c.scheduledAt.getTime() - now < env.PATIENT_CANCEL_CUTOFF_MINUTES * 60_000) {
      throw conflict(`Patients can cancel up to ${env.PATIENT_CANCEL_CUTOFF_MINUTES} minutes before the start`, "CANCEL_WINDOW_PASSED");
    }

    const cancelled = await tx.consultation.update({ where: { id }, data: { status: "CANCELLED", cancellationReason: reason ?? `cancelled_by_${actor.role.toLowerCase()}` } });
    const refunded = await tx.payment.updateMany({ where: { consultationId: id, status: "SUCCEEDED" }, data: { status: "REFUNDED" } });
    await tx.payment.updateMany({ where: { consultationId: id, status: "INITIATED" }, data: { status: "FAILED" } });
    // free the slot again if it is still in the future
    if (c.scheduledAt.getTime() > now) {
      await tx.availabilitySlot.updateMany({ where: { id: c.slotId, status: { in: ["HELD", "BOOKED"] } }, data: { status: "AVAILABLE", heldUntil: null, version: { increment: 1 } } });
    }
    await writeAudit(tx, ctx, { action: "CONSULTATION_CANCELLED", entityType: "consultation", entityId: id, metadata: { by: actor.role, refunded: refunded.count > 0 } });
    await emitEvent(tx, "consultation.cancelled", id, { consultationId: id, by: actor.role, refunded: refunded.count > 0 });
    return brief(cancelled);
  });
}

