import { z } from "zod";
import { uuidSchema } from "../../common/schemas";

const slotInput = z
  .object({ startTime: z.coerce.date(), endTime: z.coerce.date() })
  .refine((s) => s.endTime > s.startTime, { message: "endTime must be after startTime", path: ["endTime"] })
  .refine(
    (s) => {
      const minutes = (s.endTime.getTime() - s.startTime.getTime()) / 60_000;
      return minutes >= 10 && minutes <= 120;
    },
    { message: "Slot must be 10 to 120 minutes long", path: ["endTime"] },
  )
  .refine((s) => s.startTime > new Date(), { message: "startTime must be in the future", path: ["startTime"] });

export const createSlotsSchema = z.object({ slots: z.array(slotInput).min(1).max(20) });

export const slotIdParamSchema = z.object({ id: uuidSchema });
export const doctorIdParamSchema = z.object({ doctorId: uuidSchema });

export const listSlotsQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const mySlotsQuerySchema = listSlotsQuerySchema.extend({
  status: z.enum(["AVAILABLE", "HELD", "BOOKED", "CANCELLED"]).optional(),
});

export type CreateSlotsInput = z.infer<typeof createSlotsSchema>;
export type ListSlotsQuery = z.infer<typeof listSlotsQuerySchema>;
export type MySlotsQuery = z.infer<typeof mySlotsQuerySchema>;
