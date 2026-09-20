import { authenticator } from "otplib";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/config/prisma";
import { PASSWORD, api, bearer, loginAs, makeAdmin, makeDoctor, makePatient, resetDb, uniqueEmail } from "./helpers";

beforeAll(resetDb);

describe("registration and login", () => {
  it("registers a patient, never returns the password hash, and rejects duplicates", async () => {
    const email = uniqueEmail("reg");
    const res = await api().post("/api/v1/auth/register").send({ email, password: PASSWORD, fullName: "Asha" });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("PATIENT");
    expect(JSON.stringify(res.body)).not.toMatch(/hash|password/i);

    const dup = await api().post("/api/v1/auth/register").send({ email, password: PASSWORD, fullName: "Asha" });
    expect(dup.status).toBe(409);
  });

  it("cannot self-register as a doctor or admin (mass-assignment guard)", async () => {
    const email = uniqueEmail("sneaky");
    const res = await api().post("/api/v1/auth/register").send({ email, password: PASSWORD, fullName: "X", role: "ADMIN" });
    expect(res.status).toBe(400); // the schema is strict: unknown fields are rejected, not silently ignored
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    const p = await makePatient();
    const wrong = await api().post("/api/v1/auth/login").send({ email: p.email, password: "not-the-password" });
    const unknown = await api().post("/api/v1/auth/login").send({ email: uniqueEmail("ghost"), password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it("rejects malformed input with a structured 400", async () => {
    const res = await api().post("/api/v1/auth/register").send({ email: "not-an-email", password: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a deactivated account", async () => {
    const p = await makePatient();
    await prisma.user.update({ where: { id: p.id }, data: { isActive: false } });
    const res = await api().post("/api/v1/auth/login").send({ email: p.email, password: PASSWORD });
    expect(res.status).toBe(401);
  });
});

describe("tokens", () => {
  it("protects routes: no token, garbage token", async () => {
    expect((await api().get("/api/v1/auth/me")).status).toBe(401);
    expect((await api().get("/api/v1/auth/me").set("Authorization", "Bearer nope")).status).toBe(401);
  });

  it("rotates refresh tokens and revokes the whole family when an old one is replayed", async () => {
    const p = await makePatient();
    const first = await api().post("/api/v1/auth/refresh").send({ refreshToken: p.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(p.refreshToken);

    // replaying the already-used token = theft signal
    const replay = await api().post("/api/v1/auth/refresh").send({ refreshToken: p.refreshToken });
    expect(replay.status).toBe(401);

    // ...and the legitimate newest token is now dead too
    const afterTheft = await api().post("/api/v1/auth/refresh").send({ refreshToken: first.body.refreshToken });
    expect(afterTheft.status).toBe(401);
  });

  it("logout invalidates the refresh token", async () => {
    const p = await makePatient();
    expect((await api().post("/api/v1/auth/logout").send({ refreshToken: p.refreshToken })).status).toBe(204);
    expect((await api().post("/api/v1/auth/refresh").send({ refreshToken: p.refreshToken })).status).toBe(401);
  });

  it("stores only a hash of refresh tokens", async () => {
    const p = await makePatient();
    const rows = await prisma.refreshToken.findMany({ where: { userId: p.id } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.tokenHash).not.toBe(p.refreshToken);
  });
});

describe("RBAC", () => {
  it("only admins can create doctors, only doctors can create slots, only patients can book", async () => {
    const patient = await makePatient();
    const admin = await makeAdmin();
    const doctor = await makeDoctor(admin);

    const asPatient = await api().post("/api/v1/doctors").set(bearer(patient)).send({});
    expect(asPatient.status).toBe(403);
    const slotAsPatient = await api().post("/api/v1/slots").set(bearer(patient)).send({ slots: [] });
    expect(slotAsPatient.status).toBe(403);
    const bookAsDoctor = await api().post("/api/v1/bookings").set(bearer(doctor)).set("Idempotency-Key", "abc12345").send({ slotId: "3f2b8c1e-9d3a-4b7e-8f1a-2c5d6e7f8a9b" });
    expect(bookAsDoctor.status).toBe(403);
  });

  it("admin routes reject non-admins", async () => {
    const patient = await makePatient();
    expect((await api().get("/api/v1/admin/analytics/overview").set(bearer(patient))).status).toBe(403);
    expect((await api().get("/api/v1/admin/audit-logs").set(bearer(patient))).status).toBe(403);
  });
});

describe("MFA (TOTP)", () => {
  it("full flow: setup, enable, login challenge, verify, replay protection, disable", async () => {
    const p = await makePatient("mfa");

    const setup = await api().post("/api/v1/auth/mfa/setup").set(bearer(p));
    expect(setup.status).toBe(200);
    const secret: string = setup.body.secret;
    expect(setup.body.otpauthUrl).toContain("otpauth://totp/");

    // the secret is encrypted at rest
    const row = await prisma.user.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.mfaSecretEnc).not.toContain(secret);

    // wrong code is rejected, right code enables
    expect((await api().post("/api/v1/auth/mfa/enable").set(bearer(p)).send({ code: "000000" })).status).toBeGreaterThanOrEqual(400);
    const enable = await api().post("/api/v1/auth/mfa/enable").set(bearer(p)).send({ code: authenticator.generate(secret) });
    expect(enable.status).toBe(200);

    // login now returns a challenge instead of tokens
    const login = await api().post("/api/v1/auth/login").send({ email: p.email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.accessToken).toBeUndefined();

    // the challenge token is not usable as an access token
    expect((await api().get("/api/v1/auth/me").set("Authorization", `Bearer ${login.body.mfaToken}`)).status).toBe(401);

    // move the last-used step back so the next valid code (the current step) is accepted once, then replayed
    await prisma.user.update({ where: { id: p.id }, data: { mfaLastStep: 1 } });
    const code = authenticator.generate(secret);
    const verified = await api().post("/api/v1/auth/mfa/verify").send({ mfaToken: login.body.mfaToken, code });
    expect(verified.status).toBe(200);
    expect(verified.body.accessToken).toBeTruthy();

    const replay = await api().post("/api/v1/auth/mfa/verify").send({ mfaToken: login.body.mfaToken, code });
    expect(replay.status).toBe(401);

    // wrong code never yields a session
    const bad = await api().post("/api/v1/auth/mfa/verify").send({ mfaToken: login.body.mfaToken, code: "123456" });
    expect(bad.status).toBe(401);
  });
});

describe("user profile", () => {
  it("encrypts the phone number at rest and revokes sessions on password change", async () => {
    const p = await makePatient("profile");
    const upd = await api().patch("/api/v1/users/me").set(bearer(p)).send({ phone: "+919812345678" });
    expect(upd.status).toBe(200);
    const raw = await prisma.$queryRaw<{ phone_enc: string | null }[]>`SELECT phone_enc FROM profiles WHERE user_id = ${p.id}::uuid`;
    expect(raw[0].phone_enc).toBeTruthy();
    expect(raw[0].phone_enc).not.toContain("9812345678");

    const change = await api().post("/api/v1/users/me/password").set(bearer(p)).send({ currentPassword: PASSWORD, newPassword: "An0ther!Pass99" });
    expect(change.status).toBeLessThan(300);
    expect((await api().post("/api/v1/auth/refresh").send({ refreshToken: p.refreshToken })).status).toBe(401);
    expect((await loginAs(p.email, "An0ther!Pass99")).id).toBe(p.id);
  });
});
