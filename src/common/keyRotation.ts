import { prisma } from "../config/prisma";
import { Crypto, crypto as defaultCrypto } from "./crypto";

// Re-encrypts every encrypted column with the ACTIVE key so an old key can be retired.
// Safe to run while the API is serving traffic and safe to re-run (rows already on the active key are skipped).
// Each update is conditional on the ciphertext we read, so a value the API changed in the meantime is never overwritten.
export async function reencryptAll(c: Crypto = defaultCrypto, batchSize = 200) {
  async function sweep<T extends { id: string }>(load: (after: string | undefined) => Promise<T[]>, fix: (row: T) => Promise<boolean>) {
    let after: string | undefined;
    let changed = 0;
    for (;;) {
      const rows = await load(after);
      if (rows.length === 0) return changed;
      for (const row of rows) if (await fix(row)) changed++;
      after = rows[rows.length - 1]!.id;
    }
  }

  const mfaSecrets = await sweep(
    (after) => prisma.user.findMany({ where: { mfaSecretEnc: { not: null }, ...(after && { id: { gt: after } }) }, select: { id: true, mfaSecretEnc: true }, orderBy: { id: "asc" }, take: batchSize }),
    async (r) => {
      if (!r.mfaSecretEnc || !c.needsReencryption(r.mfaSecretEnc)) return false;
      const aad = `user-mfa:${r.id}`;
      const res = await prisma.user.updateMany({ where: { id: r.id, mfaSecretEnc: r.mfaSecretEnc }, data: { mfaSecretEnc: c.encrypt(c.decrypt(r.mfaSecretEnc, aad), aad) } });
      return res.count > 0;
    },
  );

  const phones = await sweep(
    (after) => prisma.profile.findMany({ where: { phoneEnc: { not: null }, ...(after && { id: { gt: after } }) }, select: { id: true, userId: true, phoneEnc: true }, orderBy: { id: "asc" }, take: batchSize }),
    async (r) => {
      if (!r.phoneEnc || !c.needsReencryption(r.phoneEnc)) return false;
      const aad = `profile-phone:${r.userId}`;
      const res = await prisma.profile.updateMany({ where: { id: r.id, phoneEnc: r.phoneEnc }, data: { phoneEnc: c.encrypt(c.decrypt(r.phoneEnc, aad), aad) } });
      return res.count > 0;
    },
  );

  const notes = await sweep(
    (after) => prisma.consultation.findMany({ where: { notesEnc: { not: null }, ...(after && { id: { gt: after } }) }, select: { id: true, notesEnc: true }, orderBy: { id: "asc" }, take: batchSize }),
    async (r) => {
      if (!r.notesEnc || !c.needsReencryption(r.notesEnc)) return false;
      const aad = `consultation-notes:${r.id}`;
      const res = await prisma.consultation.updateMany({ where: { id: r.id, notesEnc: r.notesEnc }, data: { notesEnc: c.encrypt(c.decrypt(r.notesEnc, aad), aad) } });
      return res.count > 0;
    },
  );

  const prescriptions = await sweep(
    (after) => prisma.prescription.findMany({ where: { ...(after && { id: { gt: after } }) }, select: { id: true, contentEnc: true }, orderBy: { id: "asc" }, take: batchSize }),
    async (r) => {
      if (!c.needsReencryption(r.contentEnc)) return false;
      const aad = `prescription:${r.id}`;
      const res = await prisma.prescription.updateMany({ where: { id: r.id, contentEnc: r.contentEnc }, data: { contentEnc: c.encrypt(c.decrypt(r.contentEnc, aad), aad) } });
      return res.count > 0;
    },
  );

  return { mfaSecrets, phones, notes, prescriptions };
}
