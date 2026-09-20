import bcrypt from "bcryptjs";
import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { AppError, forbidden, notFound } from "../../common/errors";
import { AuditContext, writeAudit } from "../../common/audit";
import { bumpCacheVersion, cached, cacheVersion } from "../../common/cache";
import { CreateDoctorInput, ListDoctorsQuery, UpdateDoctorInput } from "./doctors.schema";

const NS = "doctors";

// Exactly which fields leave the API. Never return whole rows: email and license number stay private.
const publicDoctorSelect = {
  id: true,
  specialization: true,
  experienceYears: true,
  consultationFee: true,
  bio: true,
  user: { select: { profile: { select: { fullName: true } } } },
} satisfies Prisma.DoctorSelect;

export async function createDoctor(input: CreateDoctorInput, ctx: AuditContext) {
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
  try {
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          role: "DOCTOR",
          profile: { create: { fullName: input.fullName } },
          doctor: {
            create: {
              specialization: input.specialization,
              licenseNumber: input.licenseNumber,
              experienceYears: input.experienceYears,
              consultationFee: input.consultationFee,
              bio: input.bio,
              isVerified: true, // admin-created = verified
            },
          },
        },
        select: { id: true, email: true, role: true, doctor: { select: { id: true, specialization: true, licenseNumber: true } } },
      });
      await writeAudit(tx, ctx, { action: "DOCTOR_CREATED", entityType: "doctor", entityId: user.doctor?.id, metadata: { userId: user.id } });
      return user;
    });
    await bumpCacheVersion(NS);
    return created;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new AppError(409, "Email or license number already exists", "DUPLICATE");
    }
    throw e;
  }
}

export async function updateOwnDoctorProfile(userId: string, input: UpdateDoctorInput, ctx: AuditContext) {
  const doctor = await prisma.doctor.findUnique({ where: { userId }, select: { id: true } });
  if (!doctor) throw forbidden("Doctor profile required");
  const updated = await prisma.doctor.update({ where: { id: doctor.id }, data: input, select: publicDoctorSelect });
  await writeAudit(prisma, ctx, { action: "DOCTOR_UPDATED", entityType: "doctor", entityId: doctor.id, metadata: { fields: Object.keys(input) } });
  await bumpCacheVersion(NS);
  return updated;
}

async function queryDoctors(f: ListDoctorsQuery) {
  const where: Prisma.DoctorWhereInput = {
    isVerified: true,
    user: { isActive: true, ...(f.q && { profile: { fullName: { contains: f.q, mode: "insensitive" } } }) },
  };
  if (f.specialization) where.specialization = { equals: f.specialization, mode: "insensitive" };
  if (f.maxFee) where.consultationFee = { lte: f.maxFee };
  if (f.minExperience !== undefined) where.experienceYears = { gte: f.minExperience };
  if (f.availableFrom || f.availableTo) {
    where.slots = {
      some: {
        status: "AVAILABLE",
        startTime: { gte: f.availableFrom && f.availableFrom > new Date() ? f.availableFrom : new Date(), ...(f.availableTo && { lt: f.availableTo }) },
      },
    };
  }

  const orderBy: Prisma.DoctorOrderByWithRelationInput[] =
    f.sort === "fee_asc" ? [{ consultationFee: "asc" }, { id: "asc" }]
    : f.sort === "fee_desc" ? [{ consultationFee: "desc" }, { id: "asc" }]
    : [{ experienceYears: "desc" }, { id: "asc" }]; // id as tie-breaker keeps pagination stable

  const [total, items] = await prisma.$transaction([
    prisma.doctor.count({ where }),
    prisma.doctor.findMany({ where, select: publicDoctorSelect, orderBy, skip: (f.page - 1) * f.limit, take: f.limit }),
  ]);
  return { items, page: f.page, limit: f.limit, total };
}

export async function listDoctors(f: ListDoctorsQuery) {
  // Availability changes constantly, so results that depend on it are never cached.
  if (f.availableFrom || f.availableTo) return queryDoctors(f);
  const key = `doctors:list:${await cacheVersion(NS)}:${createHash("sha1").update(JSON.stringify(f)).digest("hex")}`;
  return cached(key, env.CACHE_TTL_SECONDS, () => queryDoctors(f));
}

export async function getDoctor(id: string) {
  const doctor = await cached(`doctors:one:${await cacheVersion(NS)}:${id}`, env.CACHE_TTL_SECONDS, () =>
    prisma.doctor.findFirst({ where: { id, isVerified: true, user: { isActive: true } }, select: publicDoctorSelect }),
  );
  if (!doctor) throw notFound("Doctor");
  return doctor;
}
