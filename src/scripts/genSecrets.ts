import { randomBytes } from "crypto";

// Prints fresh secrets to paste into .env (nothing is stored anywhere).
console.log(`JWT_ACCESS_SECRET=${randomBytes(48).toString("hex")}`);
console.log(`ENCRYPTION_KEYS=v1:${randomBytes(32).toString("hex")}`);
console.log(`ENCRYPTION_ACTIVE_KEY_ID=v1`);
console.log(`METRICS_TOKEN=${randomBytes(24).toString("hex")}`);
