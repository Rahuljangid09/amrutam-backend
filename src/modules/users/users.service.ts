import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { AppError, notFound } from "../../common/errors";
import { crypto } from "../../common/crypto";
import { AuditContext, writeAudit } from "../../common/audit";
import { changePasswordSchema, updateProfileSchema } from "./users.schema";

const phoneAad = (userId: string) => `profile-phone:${userId}`;

export async function getProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, mfaEnabled: true, profile: true },
  });
  if (!user) throw notFound("User");
  const p = user.profile;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    mfaEnabled: user.mfaEnabled,
    profile: p && {
      fullName: p.fullName,
      phone: p.phoneEnc ? crypto.decrypt(p.phoneEnc, phoneAad(userId)) : null, // PII is encrypted at rest
      dateOfBirth: p.dateOfBirth,
      gender: p.gender,
    },
  };
}

export async function updateProfile(userId: string, input: z.infer<typeof updateProfileSchema>, ctx: AuditContext) {
  const { phone, ...rest } = input;
  await prisma.profile.update({
    where: { userId },
    data: {
      ...rest,
      ...(phone !== undefined && { phoneEnc: phone === null ? null : crypto.encrypt(phone, phoneAad(userId)) }),
    },
  });
  await writeAudit(prisma, ctx, { action: "PROFILE_UPDATED", entityType: "user", entityId: userId, metadata: { fields: Object.keys(input) } });
  return getProfile(userId);
}

export async function changePassword(userId: string, input: z.infer<typeof changePasswordSchema>, ctx: AuditContext) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound("User");
  if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
    throw new AppError(401, "Current password is incorrect", "INVALID_CREDENTIALS");
  }
  const passwordHash = await bcrypt.hash(input.newPassword, env.BCRYPT_ROUNDS);
  // changing the password signs out every device
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await writeAudit(prisma, ctx, { action: "PASSWORD_CHANGED", entityType: "user", entityId: userId });
}
