import "dotenv/config";
import { z } from "zod";

// "true" / "1" / "yes" -> true. Missing -> the default.
const flag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : ["true", "1", "yes"].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(), // optional: without it caching is skipped and rate limits are per-instance

  // auth
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default("15m"),
  REFRESH_TTL_DAYS: z.coerce.number().default(7),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  MFA_ISSUER: z.string().default("Amrutam"),
  MFA_ENFORCE_STAFF: flag(false), // true: DOCTOR and ADMIN routes require an MFA-verified session

  // field-level encryption: "v1:<64 hex chars>[,v2:<64 hex chars>]", active key id used for new writes
  ENCRYPTION_KEYS: z.string().min(1),
  ENCRYPTION_ACTIVE_KEY_ID: z.string().default("v1"),

  // booking
  SLOT_HOLD_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  PATIENT_CANCEL_CUTOFF_MINUTES: z.coerce.number().int().min(0).default(60),

  // http
  TRUST_PROXY: z.coerce.number().int().min(0).default(0), // number of proxies in front of the API
  RATE_LIMIT_ENABLED: flag(true),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).default(30),

  // observability
  METRICS_TOKEN: z.string().optional(), // if set, /metrics requires "Authorization: Bearer <token>"
  OTEL_ENABLED: flag(false),
  OTEL_SERVICE_NAME: z.string().default("amrutam-api"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default("http://localhost:4318"),

  // worker
  WORKER_POLL_MS: z.coerce.number().int().min(200).default(5000),
  WORKER_METRICS_PORT: z.coerce.number().default(9101),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
