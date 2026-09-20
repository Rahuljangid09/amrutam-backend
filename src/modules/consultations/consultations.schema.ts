import { z } from "zod";
import { pageQuery } from "../../common/schemas";

export const listConsultationsQuerySchema = z.object({
  status: z.enum(["PENDING_PAYMENT", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  ...pageQuery,
});

export const completeSchema = z.object({ notes: z.string().trim().max(5000).optional() });
export const cancelSchema = z.object({ reason: z.string().trim().max(300).optional() });

export type ListConsultationsQuery = z.infer<typeof listConsultationsQuerySchema>;
