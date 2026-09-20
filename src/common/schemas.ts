import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email());
export const passwordSchema = z.string().min(8).max(72); // bcrypt only reads the first 72 bytes
export const uuidSchema = z.uuid();
export const idParamSchema = z.object({ id: uuidSchema });

export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
};
