import type { Request } from "express";
import { Prisma, PrismaClient, Role } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditContext {
  actorId?: string | null;
  actorRole?: Role | null;
  ip?: string | null;
  userAgent?: string | null;
}

export const auditContext = (req: Request): AuditContext => ({
  actorId: req.user?.id ?? null,
  actorRole: req.user?.role ?? null,
  ip: req.ip ?? null,
  userAgent: req.get("user-agent")?.slice(0, 255) ?? null,
});

// Pass the transaction client to make the audit row atomic with the change it describes.
// Errors are NOT swallowed: for regulated data we prefer failing the request to acting unaudited.
export async function writeAudit(
  db: Db,
  ctx: AuditContext,
  entry: { action: string; entityType: string; entityId?: string; metadata?: Prisma.InputJsonValue },
): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: ctx.actorId ?? null,
      actorRole: ctx.actorRole ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? Prisma.JsonNull,
    },
    select: { id: true },
  });
}
