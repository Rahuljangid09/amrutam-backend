import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError, notFound } from "../../common/errors";
import { AuditContext, writeAudit } from "../../common/audit";
import { auditQuerySchema, listUsersQuerySchema, updateUserSchema } from "./admin.schema";

export async function listAuditLogs(q: z.infer<typeof auditQuerySchema>) {
  const where: Prisma.AuditLogWhereInput = {
    ...(q.actorId && { actorId: q.actorId }),
    ...(q.entityType && { entityType: q.entityType }),
    ...(q.entityId && { entityId: q.entityId }),
    ...(q.action && { action: q.action }),
    ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: q.from }), ...(q.to && { lt: q.to }) } }),
    ...(q.cursor && { id: { lt: BigInt(q.cursor) } }),
  };
  // Keyset pagination on the monotonically increasing id: constant cost per page however deep you go.
  // Pass from/to to let Postgres prune partitions on large ranges.
  const rows = await prisma.auditLog.findMany({ where, orderBy: { id: "desc" }, take: q.limit + 1 });
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((r) => ({
      id: r.id.toString(), // BigInt is not JSON-serializable
      at: r.createdAt,
      actorId: r.actorId,
      actorRole: r.actorRole,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      ip: r.ip,
      metadata: r.metadata,
    })),
    nextCursor: rows.length > q.limit ? page[page.length - 1]!.id.toString() : null,
  };
}

export async function listUsers(q: z.infer<typeof listUsersQuerySchema>) {
  const where: Prisma.UserWhereInput = {
    ...(q.role && { role: q.role }),
    ...(q.isActive !== undefined && { isActive: q.isActive }),
    ...(q.q && { email: { contains: q.q, mode: "insensitive" } }),
  };
  const [total, items] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: { id: true, email: true, role: true, isActive: true, mfaEnabled: true, createdAt: true, profile: { select: { fullName: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
  ]);
  return { items, page: q.page, limit: q.limit, total };
}

export async function updateUser(actorId: string, userId: string, input: z.infer<typeof updateUserSchema>, ctx: AuditContext) {
  if (actorId === userId) throw new AppError(409, "Admins cannot change their own account here", "SELF_MODIFICATION");
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!target) throw notFound("User");
  if (input.role && target.role === "DOCTOR") throw new AppError(409, "Doctor accounts cannot change role", "INVALID_ROLE_CHANGE");

  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: userId }, data: input, select: { id: true, email: true, role: true, isActive: true } });
    // a deactivated account loses its sessions immediately (access tokens expire within minutes)
    if (input.isActive === false) await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "USER_UPDATED", entityType: "user", entityId: userId, metadata: { changes: input } });
    return user;
  });
  return updated;
}
