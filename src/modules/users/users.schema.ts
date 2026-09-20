import { z } from "zod";
import { passwordSchema } from "../../common/schemas";

export const updateProfileSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100).optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9][0-9\s-]{6,18}$/, "invalid phone number")
      .nullable()
      .optional(),
    dateOfBirth: z.coerce.date().max(new Date(), "must be in the past").nullable().optional(),
    gender: z.string().trim().max(30).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field" });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});
