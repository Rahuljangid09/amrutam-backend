import { z } from "zod";
import { emailSchema, passwordSchema } from "../../common/schemas";

const totpCode = z.string().regex(/^\d{6}$/, "must be a 6-digit code");

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(100),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(500) });
export const mfaCodeSchema = z.object({ code: totpCode });
export const mfaDisableSchema = z.object({ code: totpCode, password: z.string().min(1).max(200) });
export const mfaVerifySchema = z.object({ mfaToken: z.string().min(1).max(2000), code: totpCode });
