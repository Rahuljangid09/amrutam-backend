import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { env } from "../config/env";

// AES-256-GCM field encryption with a key ring (key rotation without downtime).
// Stored format:  <keyId>.<iv>.<authTag>.<ciphertext>   (base64url parts)
// `aad` (additional authenticated data, e.g. "prescription:<id>") binds a ciphertext to
// its row, so copying an encrypted value into another row makes decryption fail.

export interface Crypto {
  encrypt(plain: string, aad?: string): string;
  decrypt(payload: string, aad?: string): string;
  encryptJson(value: unknown, aad?: string): string;
  decryptJson<T = unknown>(payload: string, aad?: string): T;
  needsReencryption(payload: string): boolean;
  activeKeyId: string;
}

function parseKeys(raw: string): Map<string, Buffer> {
  const ring = new Map<string, Buffer>();
  for (const part of raw.split(",")) {
    const [id, hex] = part.trim().split(":");
    if (!id || !hex || !/^[A-Za-z0-9_-]+$/.test(id) || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("ENCRYPTION_KEYS must look like v1:<64 hex chars>[,v2:<64 hex chars>]");
    }
    ring.set(id, Buffer.from(hex, "hex"));
  }
  return ring;
}

export function createCrypto(rawKeys: string, activeKeyId: string): Crypto {
  const ring = parseKeys(rawKeys);
  const activeKey = ring.get(activeKeyId);
  if (!activeKey) throw new Error(`ENCRYPTION_ACTIVE_KEY_ID "${activeKeyId}" is not in ENCRYPTION_KEYS`);

  const encrypt = (plain: string, aad?: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", activeKey, iv);
    if (aad) cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [activeKeyId, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
  };

  const decrypt = (payload: string, aad?: string) => {
    const [keyId, iv, tag, ct] = payload.split(".");
    const key = keyId ? ring.get(keyId) : undefined;
    if (!key || !iv || !tag || !ct) throw new Error("Malformed or unknown-key ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  };

  return {
    activeKeyId,
    encrypt,
    decrypt,
    encryptJson: (value, aad) => encrypt(JSON.stringify(value), aad),
    decryptJson: <T>(payload: string, aad?: string) => JSON.parse(decrypt(payload, aad)) as T,
    needsReencryption: (payload) => payload.split(".")[0] !== activeKeyId,
  };
}

export const crypto = createCrypto(env.ENCRYPTION_KEYS, env.ENCRYPTION_ACTIVE_KEY_ID);
