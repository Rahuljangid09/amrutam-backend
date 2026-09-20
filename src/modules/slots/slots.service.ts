import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError, forbidden } from "../../common/errors";
import { AuditContext, writeAudit } from "../../common/audit";
import { getDoctor } from "../doctors/doctors.service";
import { CreateSlotsInput, ListSlotsQuery, MySlotsQuery } from "./slots.schema";

const slotSelect = { id: true, doctorId: true, startTime: true, endTime: true, status: true } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

async function doctorForUser(userId: string) {
  const doctor = await prisma.doctor.findUnique({ where: { userId } });
  if (!doctor) throw forbidden("Doctor profile required");
  return doctor;
}

// the exclusion constraint's name / text appears in the driver error
const isOverlap = (e: unknown) => e instanceof Error && /no_overlapping_slots|exclusion constraint/i.test(e.message);

export async function createSlots(userId: string, input: CreateSlotsInput, ctx: AuditContext) {
  const doctor = await doctorForUser(userId);
  try {
    // one transaction: either every slot is created or none
    return await prisma.$transaction(async (tx) => {
      const created = [];
      for (const s of input.slots) {
        created.push(await tx.availabilitySlot.create({ data: { doctorId: doctor.id, startTime: s.startTime, endTime: s.endTime }, select: slotSelect }));
      }
      await writeAudit(tx, ctx, { action: "SLOTS_CREATED", entityType: "doctor", entityId: doctor.id, metadata: { count: created.length } });
      return created;
    });
  } catch (e) {
    const duplicate = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
    if (duplicate || isOverlap(e)) throw new AppError(409, "A slot overlaps an existing slot", "SLOT_OVERLAP");
    throw e;
  }
}

// Patients: open slots only, from now on.
export async function listAvailableSlots(doctorId: string, q: ListSlotsQuery) {
  await getDoctor(doctorId); // 404 if the doctor does not exist
  const now = new Date();
  const from = q.from && q.from > now ? q.from : now;
  const to = q.to ?? new Date(now.getTime() + 14 * DAY_MS);
  return prisma.availabilitySlot.findMany({
    where: { doctorId, status: "AVAILABLE", startTime: { gte: from, lt: to } },
    select: slotSelect,
    orderBy: { startTime: "asc" },
    take: q.limit,
  });
}

// Doctors: their own schedule, any status.
export async function listOwnSlots(userId: string, q: MySlotsQuery) {
  const doctor = await doctorForUser(userId);
  const from = q.from ?? new Date();
  const to = q.to ?? new Date(from.getTime() + 14 * DAY_MS);
  return prisma.availabilitySlot.findMany({
    where: { doctorId: doctor.id, startTime: { gte: from, lt: to }, ...(q.status && { status: q.status }) },
    select: slotSelect,
    orderBy: { startTime: "asc" },
    take: q.limit,
  });
}

export async function cancelSlot(userId: string, slotId: string, ctx: AuditContext) {
  const doctor = await doctorForUser(userId);
  // check and change in ONE statement: only your own slot, and only while nobody holds or booked it
  const result = await prisma.availabilitySlot.updateMany({
    where: { id: slotId, doctorId: doctor.id, status: "AVAILABLE" },
    data: { status: "CANCELLED" },
  });
  if (result.count === 0) throw new AppError(404, "Slot not found or cannot be cancelled", "SLOT_NOT_CANCELLABLE");
  await writeAudit(prisma, ctx, { action: "SLOT_CANCELLED", entityType: "slot", entityId: slotId });
}
