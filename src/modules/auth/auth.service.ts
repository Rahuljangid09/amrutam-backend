import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import { authenticator } from "otplib";
import { createHash, randomBytes } from "crypto";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { env } from "../../config/env";
import { AppError } from "../../common/errors";
import { crypto } from "../../common/crypto";
import { AuditContext, writeAudit } from "../../common/audit";
import { authEventsTotal } from "../../common/metrics";

authenticator.options = { window: 1 }; // accept the previous/next 30s code to tolerate clock drift

const DUMMY_HASH = bcrypt.hashSync("dummy-password", env.BCRYPT_ROUNDS);
const MFA_TOKEN_TTL = "5m";

const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");
const invalidRefresh = () => new AppError(401, "Invalid refresh token", "INVALID_REFRESH_TOKEN");
const invalidMfa = () => new AppError(401, "Invalid MFA code", "INVALID_MFA_CODE");
const mfaAad = (userId: string) => `user-mfa:${userId}`;

export function signAccessToken(user: { id: string; role: Role }, mfa: boolean) {
  return jwt.sign({ role: user.role, typ: "access", mfa }, env.JWT_ACCESS_SECRET, {
    subject: user.id,
    algorithm: "HS256",
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions["expiresIn"],
  });
}

async function issueRefreshToken(db: Prisma.TransactionClient | typeof prisma, userId: string, mfaVerified: boolean) {
  const raw = randomBytes(48).toString("hex");
  await db.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(raw), // only the hash is stored: a leaked table cannot be used to log in
      mfaVerified,
      expiresAt: new Date(Date.now() + env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  return raw;
}

async function startSession(user: { id: string; email: string; role: Role }, mfa: boolean) {
  return {
    accessToken: signAccessToken(user, mfa),
    refreshToken: await issueRefreshToken(prisma, user.id, mfa),
    user: { id: user.id, email: user.email, role: user.role },
  };
}

export async function register(input: { email: string; password: string; fullName: string }, ctx: AuditContext) {
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
  try {
    return await prisma.$transaction(async (tx) => {
      // Role is NEVER taken from the client: public sign-up always creates a patient.
      const user = await tx.user.create({
        data: { email: input.email, passwordHash, role: "PATIENT", profile: { create: { fullName: input.fullName } } },
        select: { id: true, email: true, role: true },
      });
      await writeAudit(tx, { ...ctx, actorId: user.id, actorRole: user.role }, { action: "USER_REGISTERED", entityType: "user", entityId: user.id });
      return user;
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new AppError(409, "Email already registered", "EMAIL_TAKEN");
    }
    throw e;
  }
}

export async function login(email: string, password: string, ctx: AuditContext) {
  const user = await prisma.user.findUnique({ where: { email } });
  // compare against a dummy hash when the user does not exist so timing does not reveal it
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok || !user.isActive) {
    authEventsTotal.inc({ event: "login_failed" });
    await writeAudit(prisma, ctx, {
      action: "LOGIN_FAILED",
      entityType: "user",
      entityId: user?.id,
      metadata: { emailHash: createHash("sha256").update(email).digest("hex").slice(0, 16) },
    });
    throw new AppError(401, "Invalid credentials", "INVALID_CREDENTIALS");
  }

  if (user.mfaEnabled) {
    // password is right, but the session is not started until the TOTP code is verified
    const mfaToken = jwt.sign({ typ: "mfa" }, env.JWT_ACCESS_SECRET, {
      subject: user.id,
      algorithm: "HS256",
      expiresIn: MFA_TOKEN_TTL,
    });
    return { mfaRequired: true as const, mfaToken };
  }

  authEventsTotal.inc({ event: "login_success" });
  await writeAudit(prisma, { ...ctx, actorId: user.id, actorRole: user.role }, { action: "LOGIN_SUCCESS", entityType: "user", entityId: user.id, metadata: { mfa: false } });
  return startSession(user, false);
}

export async function refresh(rawToken: string, ctx: AuditContext) {
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(rawToken) }, include: { user: true } });
  if (!stored) throw invalidRefresh();

  if (stored.revokedAt) {
    // a rotated token was presented again: assume theft and end every session of this user
    await prisma.refreshToken.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    authEventsTotal.inc({ event: "refresh_reuse" });
    await writeAudit(prisma, { ...ctx, actorId: stored.userId, actorRole: stored.user.role }, { action: "REFRESH_TOKEN_REUSE_DETECTED", entityType: "user", entityId: stored.userId });
    throw invalidRefresh();
  }
  if (stored.expiresAt < new Date() || !stored.user.isActive) throw invalidRefresh();

  return prisma.$transaction(async (tx) => {
    // atomic: of two concurrent requests with the same token only one wins this update
    const claimed = await tx.refreshToken.updateMany({ where: { id: stored.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (claimed.count === 0) throw invalidRefresh();
    const refreshToken = await issueRefreshToken(tx, stored.userId, stored.mfaVerified);
    return { accessToken: signAccessToken(stored.user, stored.mfaVerified), refreshToken };
  });
}

export async function logout(rawToken: string) {
  await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(rawToken), revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function getMe(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, mfaEnabled: true, profile: { select: { fullName: true } } },
  });
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  return user;
}

// ───────────── MFA (TOTP) ─────────────

// Verifies a TOTP code and records its time-step so the same code cannot be used twice (replay protection).
async function checkTotp(user: { id: string; mfaSecretEnc: string | null }, code: string) {
  if (!user.mfaSecretEnc) throw invalidMfa();
  const secret = crypto.decrypt(user.mfaSecretEnc, mfaAad(user.id));
  const delta = authenticator.checkDelta(code, secret);
  if (delta === null || delta === undefined) throw invalidMfa();
  const step = Math.floor(Date.now() / 30_000) + delta;
  const claimed = await prisma.user.updateMany({
    where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
    data: { mfaLastStep: step },
  });
  if (claimed.count === 0) throw new AppError(401, "This code was already used", "MFA_CODE_REUSED");
}

export async function mfaSetup(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  if (user.mfaEnabled) throw new AppError(409, "MFA is already enabled", "MFA_ALREADY_ENABLED");

  const secret = authenticator.generateSecret();
  // stored encrypted; MFA only becomes active once the user proves they can produce a code
  await prisma.user.update({ where: { id: userId }, data: { mfaSecretEnc: crypto.encrypt(secret, mfaAad(userId)), mfaLastStep: null } });
  const otpauthUrl = authenticator.keyuri(user.email, env.MFA_ISSUER, secret);
  return { secret, otpauthUrl, qrCodeDataUrl: await QRCode.toDataURL(otpauthUrl) };
}

export async function mfaEnable(userId: string, code: string, ctx: AuditContext) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  if (user.mfaEnabled) throw new AppError(409, "MFA is already enabled", "MFA_ALREADY_ENABLED");
  if (!user.mfaSecretEnc) throw new AppError(409, "Call /auth/mfa/setup first", "MFA_NOT_SET_UP");
  await checkTotp(user, code);
  await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: true } });
  await writeAudit(prisma, ctx, { action: "MFA_ENABLED", entityType: "user", entityId: userId });
}

export async function mfaDisable(userId: string, password: string, code: string, ctx: AuditContext) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  if (!user.mfaEnabled) throw new AppError(409, "MFA is not enabled", "MFA_NOT_ENABLED");
  if (!(await bcrypt.compare(password, user.passwordHash))) throw new AppError(401, "Invalid credentials", "INVALID_CREDENTIALS");
  await checkTotp(user, code);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaLastStep: null } }),
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await writeAudit(prisma, ctx, { action: "MFA_DISABLED", entityType: "user", entityId: userId });
}

export async function mfaVerifyLogin(mfaToken: string, code: string, ctx: AuditContext) {
  let userId: string;
  try {
    const payload = jwt.verify(mfaToken, env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    if (payload.typ !== "mfa" || !payload.sub) throw new Error("wrong token type");
    userId = payload.sub;
  } catch {
    throw new AppError(401, "Invalid or expired MFA token", "INVALID_MFA_TOKEN");
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive || !user.mfaEnabled) throw new AppError(401, "Invalid or expired MFA token", "INVALID_MFA_TOKEN");

  try {
    await checkTotp(user, code);
  } catch (e) {
    authEventsTotal.inc({ event: "mfa_failed" });
    await writeAudit(prisma, { ...ctx, actorId: user.id, actorRole: user.role }, { action: "MFA_FAILED", entityType: "user", entityId: user.id });
    throw e;
  }
  authEventsTotal.inc({ event: "login_success" });
  await writeAudit(prisma, { ...ctx, actorId: user.id, actorRole: user.role }, { action: "LOGIN_SUCCESS", entityType: "user", entityId: user.id, metadata: { mfa: true } });
  return startSession(user, true);
}
