import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { conflict, notFound } from "../../common/errors";
import { AuditContext, writeAudit } from "../../common/audit";
import { crypto } from "../../common/crypto";
import { emitEvent } from "../../common/outbox";
import { Actor } from "../consultations/consultations.service";
import { PrescriptionContent } from "./prescriptions.schema";

// The row id is part of the AAD, so a ciphertext copied into another prescription will not decrypt.
const aad = (id: string) => `prescription:${id}`;

export async function createPrescription(doctorUserId: string, consultationId: string, input: PrescriptionContent, ctx: AuditContext) {
  const c = await prisma.consultation.findUnique({
    where: { id: consultationId },
    select: { id: true, status: true, patientId: true, doctorId: true, doctor: { select: { userId: true } } },
  });
  if (!c || c.doctor.userId !== doctorUserId) throw notFound("Consultation");
  if (c.status !== "IN_PROGRESS" && c.status !== "COMPLETED") {
    throw conflict("A prescription can only be issued during or after the consultation", "INVALID_STATE");
  }

  const id = randomUUID();
  try {
    return await prisma.$transaction(async (tx) => {
      const p = await tx.prescription.create({
        data: { id, consultationId, doctorId: c.doctorId, patientId: c.patientId, contentEnc: crypto.encryptJson(input, aad(id)) },
        select: { id: true, consultationId: true, issuedAt: true },
      });
      await writeAudit(tx, ctx, { action: "PRESCRIPTION_CREATED", entityType: "prescription", entityId: id, metadata: { consultationId } });
      await emitEvent(tx, "prescription.issued", id, { prescriptionId: id, consultationId, patientId: c.patientId });
      return p;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw conflict("A prescription already exists for this consultation", "PRESCRIPTION_EXISTS");
    }
    throw e;
  }
}

// Only the patient and the issuing doctor can read a prescription (admins cannot: least privilege).
// Every read is written to the audit log before the data is returned.
export async function getPrescription(actor: Actor, consultationId: string, ctx: AuditContext) {
  const p = await prisma.prescription.findUnique({
    where: { consultationId },
    include: { doctor: { select: { userId: true, specialization: true, user: { select: { profile: { select: { fullName: true } } } } } } },
  });
  if (!p || (p.patientId !== actor.id && p.doctor.userId !== actor.id)) throw notFound("Prescription");

  await writeAudit(prisma, ctx, { action: "PRESCRIPTION_VIEWED", entityType: "prescription", entityId: p.id, metadata: { consultationId } });
  return {
    id: p.id,
    consultationId: p.consultationId,
    issuedAt: p.issuedAt,
    doctor: { name: p.doctor.user.profile?.fullName ?? null, specialization: p.doctor.specialization },
    content: crypto.decryptJson<PrescriptionContent>(p.contentEnc, aad(p.id)),
  };
}

// Metadata only (no medical content) for the "my prescriptions" list.
export async function listMine(actor: Actor, page: number, limit: number) {
  const where: Prisma.PrescriptionWhereInput =
    actor.role === "DOCTOR" ? { doctor: { userId: actor.id } } : { patientId: actor.id };
  const [total, items] = await prisma.$transaction([
    prisma.prescription.count({ where }),
    prisma.prescription.findMany({
      where,
      select: { id: true, consultationId: true, issuedAt: true },
      orderBy: [{ issuedAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return { items, page, limit, total };
}
