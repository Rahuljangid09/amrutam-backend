import { z } from "zod";
import { pageQuery, uuidSchema } from "../../common/schemas";

export const rangeQuerySchema = z
  .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
  .refine((r) => !r.from || !r.to || r.to > r.from, { message: "to must be after from", path: ["to"] })
  .refine((r) => !r.from || !r.to || r.to.getTime() - r.from.getTime() <= 92 * 24 * 3600_000, { message: "range is limited to 92 days", path: ["to"] });

export const topDoctorsQuerySchema = z
  .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(50).default(10) })
  .refine((r) => !r.from || !r.to || r.to > r.from, { message: "to must be after from", path: ["to"] });

export const auditQuerySchema = z.object({
  actorId: uuidSchema.optional(),
  entityType: z.string().trim().min(1).max(50).optional(),
  entityId: z.string().trim().min(1).max(100).optional(),
  action: z.string().trim().min(1).max(60).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().regex(/^\d+$/).optional(), // id of the last row of the previous page
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const listUsersQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  role: z.enum(["PATIENT", "DOCTOR", "ADMIN"]).optional(),
  isActive: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  ...pageQuery,
});

export const updateUserSchema = z
  .object({
    isActive: z.boolean().optional(),
    role: z.enum(["PATIENT", "ADMIN"]).optional(), // doctors are created through POST /doctors, not by role change
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field" });
