import { z } from "zod";

const medication = z.object({
  name: z.string().trim().min(1).max(100),
  dosage: z.string().trim().min(1).max(100),
  frequency: z.string().trim().min(1).max(100),
  durationDays: z.number().int().min(1).max(365),
  notes: z.string().trim().max(300).optional(),
});

export const createPrescriptionSchema = z.object({
  diagnosis: z.string().trim().min(1).max(500),
  medications: z.array(medication).min(1).max(20),
  advice: z.string().trim().max(1000).optional(),
});

export type PrescriptionContent = z.infer<typeof createPrescriptionSchema>;
