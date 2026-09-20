import { z } from "zod";
import { emailSchema, pageQuery, passwordSchema } from "../../common/schemas";

export const createDoctorSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(100),
  specialization: z.string().trim().min(2).max(60),
  licenseNumber: z.string().trim().min(3).max(50),
  experienceYears: z.number().int().min(0).max(70).default(0),
  consultationFee: z.number().positive().max(100000),
  bio: z.string().trim().max(1000).optional(),
});

export const updateDoctorSchema = z
  .object({
    consultationFee: z.number().positive().max(100000).optional(),
    bio: z.string().trim().max(1000).nullable().optional(),
    experienceYears: z.number().int().min(0).max(70).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Provide at least one field" });

export const listDoctorsQuerySchema = z.object({
  specialization: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).optional(),
  maxFee: z.coerce.number().positive().optional(),
  minExperience: z.coerce.number().int().min(0).optional(),
  availableFrom: z.coerce.date().optional(), // only doctors with a free slot in [availableFrom, availableTo)
  availableTo: z.coerce.date().optional(),
  sort: z.enum(["experience", "fee_asc", "fee_desc"]).default("experience"),
  ...pageQuery,
});

export type CreateDoctorInput = z.infer<typeof createDoctorSchema>;
export type UpdateDoctorInput = z.infer<typeof updateDoctorSchema>;
export type ListDoctorsQuery = z.infer<typeof listDoctorsQuerySchema>;
