import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/config/prisma";
import { ensureAuditPartitions, refreshRecentDailyStats } from "../src/jobs/maintenance";
import { Account, PASSWORD, api, bearer, confirmedConsultation, makeAdmin, makeDoctor, makePatient, resetDb } from "./helpers";

let admin: Account;
let doctor: Account & { doctorId: string };
const window = () => `from=${encodeURIComponent(new Date(Date.now() - 86400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60 * 86400_000).toISOString())}`;

beforeAll(async () => {
  await resetDb();
  admin = await makeAdmin();
  doctor = await makeDoctor(admin, { consultationFee: 750 });
});

describe("audit log", () => {
  it("is append-only: the database refuses UPDATE and DELETE, even from the application role", async () => {
    await api().post("/api/v1/auth/login").send({ email: "nobody@test.dev", password: PASSWORD }); // produces an audit row
    const row = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.$executeRaw`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = ${row.id}`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM audit_logs WHERE id = ${row.id}`).rejects.toThrow(/append-only/);
  });

  it("records who did what for business actions", async () => {
    const patient = await makePatient();
    const { consultationId } = await confirmedConsultation(patient, doctor);
    const rows = await prisma.auditLog.findMany({ where: { entityId: consultationId }, orderBy: { id: "asc" } });
    expect(rows.map((r) => r.action)).toContain("CONSULTATION_BOOKED");
    expect(rows.find((r) => r.action === "CONSULTATION_BOOKED")?.actorId).toBe(patient.id);
    expect(rows.find((r) => r.action === "CONSULTATION_BOOKED")?.actorRole).toBe("PATIENT");
  });

  it("is browsable by admins with keyset pagination and filters", async () => {
    const page1 = await api().get("/api/v1/admin/audit-logs?limit=3").set(bearer(admin));
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(3);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await api().get(`/api/v1/admin/audit-logs?limit=3&cursor=${page1.body.nextCursor}`).set(bearer(admin));
    const ids1 = page1.body.items.map((i: { id: string }) => BigInt(i.id));
    const ids2 = page2.body.items.map((i: { id: string }) => BigInt(i.id));
    expect(ids2.every((id: bigint) => id < ids1[ids1.length - 1])).toBe(true);

    const filtered = await api().get("/api/v1/admin/audit-logs?action=CONSULTATION_BOOKED").set(bearer(admin));
    expect(filtered.body.items.length).toBeGreaterThan(0);
    expect(filtered.body.items.every((i: { action: string }) => i.action === "CONSULTATION_BOOKED")).toBe(true);
  });

  it("partitions exist for the coming months and creating them is idempotent", async () => {
    await ensureAuditPartitions(3);
    expect(await ensureAuditPartitions(3)).toBe(0);
    const parts = await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'audit_logs'::regclass`;
    expect(parts[0].n).toBeGreaterThanOrEqual(4);
  });
});

describe("analytics", () => {
  it("overview: counts by status and revenue for a range", async () => {
    const patient = await makePatient();
    await confirmedConsultation(patient, doctor);
    await confirmedConsultation(patient, doctor);
    const res = await api().get(`/api/v1/admin/analytics/overview?${window()}`).set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.consultations.byStatus.CONFIRMED).toBeGreaterThanOrEqual(2);
    expect(Number(res.body.revenue)).toBeGreaterThanOrEqual(1500);
    expect(res.body.activeDoctors).toBeGreaterThanOrEqual(1);
  });

  it("daily stats are pre-aggregated and the refresh job is idempotent", async () => {
    await refreshRecentDailyStats();
    await refreshRecentDailyStats();
    const rows = await prisma.dailyStat.findMany();
    // every day appears once, however often the job ran
    expect(new Set(rows.map((r) => r.day.toISOString())).size).toBe(rows.length);
    const res = await api().get(`/api/v1/admin/analytics/daily?${window()}`).set(bearer(admin));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it("top doctors ranks by consultations with slot utilisation", async () => {
    const res = await api().get(`/api/v1/admin/analytics/top-doctors?${window()}&limit=5`).set(bearer(admin));
    expect(res.status).toBe(200);
    const top = res.body.items.find((i: { doctorId: string }) => i.doctorId === doctor.doctorId);
    expect(top.consultations).toBeGreaterThanOrEqual(2);
    expect(top.slotUtilization).toBeGreaterThan(0);
  });

  it("rejects oversized ranges and inverted ranges", async () => {
    const from = new Date(Date.now() - 200 * 86400_000).toISOString();
    expect((await api().get(`/api/v1/admin/analytics/overview?from=${from}&to=${new Date().toISOString()}`).set(bearer(admin))).status).toBe(400);
    expect((await api().get(`/api/v1/admin/analytics/overview?from=${new Date().toISOString()}&to=${from}`).set(bearer(admin))).status).toBe(400);
  });
});

describe("user management", () => {
  it("deactivating a user kills their sessions immediately", async () => {
    const patient = await makePatient();
    const res = await api().patch(`/api/v1/admin/users/${patient.id}`).set(bearer(admin)).send({ isActive: false });
    expect(res.status).toBe(200);
    expect((await api().post("/api/v1/auth/refresh").send({ refreshToken: patient.refreshToken })).status).toBe(401);
    expect((await api().post("/api/v1/auth/login").send({ email: patient.email, password: PASSWORD })).status).toBe(401);
  });

  it("an admin cannot modify their own account, or mint doctors through a role change", async () => {
    expect((await api().patch(`/api/v1/admin/users/${admin.id}`).set(bearer(admin)).send({ isActive: false })).status).toBe(409);
    const patient = await makePatient();
    expect((await api().patch(`/api/v1/admin/users/${patient.id}`).set(bearer(admin)).send({ role: "DOCTOR" })).status).toBe(400);
  });

  it("lists and searches users", async () => {
    const res = await api().get("/api/v1/admin/users?role=DOCTOR").set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.items.every((u: { role: string }) => u.role === "DOCTOR")).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|mfaSecret/);
  });
});
