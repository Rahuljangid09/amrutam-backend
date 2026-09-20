import bcrypt from "bcryptjs";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/config/prisma";

export const api = () => request(app);
export const PASSWORD = "Passw0rd!Test";

let counter = 0;
export const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${counter++}@test.dev`;

// Safety net: never let a test run wipe a real database.
export async function resetDb() {
  const [{ current_database: name }] = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()::text AS current_database`;
  if (!name.endsWith("_test")) throw new Error(`Refusing to reset database "${name}": tests must run against a *_test database`);
  await prisma.$executeRawUnsafe(
    `TRUNCATE users, profiles, doctors, availability_slots, consultations, prescriptions, payments, audit_logs, idempotency_keys, refresh_tokens, outbox_events, daily_stats RESTART IDENTITY CASCADE`,
  );
}

export interface Account {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

export async function loginAs(email: string, password = PASSWORD): Promise<Account> {
  const res = await api().post("/api/v1/auth/login").send({ email, password });
  if (res.status !== 200 || !res.body.accessToken) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.user.id, email, accessToken: res.body.accessToken, refreshToken: res.body.refreshToken };
}

export async function makePatient(prefix = "patient"): Promise<Account> {
  const email = uniqueEmail(prefix);
  const res = await api().post("/api/v1/auth/register").send({ email, password: PASSWORD, fullName: "Test Patient" });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return loginAs(email);
}

export async function makeAdmin(): Promise<Account> {
  const email = uniqueEmail("admin");
  await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash(PASSWORD, 4), role: "ADMIN", profile: { create: { fullName: "Test Admin" } } },
  });
  return loginAs(email);
}

export async function makeDoctor(admin: Account, overrides: Record<string, unknown> = {}) {
  const email = uniqueEmail("doctor");
  const res = await api()
    .post("/api/v1/doctors")
    .set(bearer(admin))
    .send({ email, password: PASSWORD, fullName: "Dr. Test", specialization: "Cardiology", licenseNumber: `LIC-${Date.now()}-${counter++}`, experienceYears: 8, consultationFee: 500, ...overrides });
  if (res.status !== 201) throw new Error(`create doctor failed: ${res.status} ${JSON.stringify(res.body)}`);
  const account = await loginAs(email);
  return { ...account, doctorId: res.body.doctor.doctor.id as string };
}

export const bearer = (a: Account) => ({ Authorization: `Bearer ${a.accessToken}` });

// A slot `hoursFromNow` hours ahead (or the next unused hour far in the future).
let autoSlot = 0;
export async function makeSlot(doctor: Account, hoursFromNow?: number, minutes = 30): Promise<string> {
  // no explicit offset: take the next free hour, so slots created by different tests never overlap
  const hours = hoursFromNow ?? 1000 + autoSlot++;
  const start = new Date(Date.now() + hours * 3600_000);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + minutes * 60_000);
  const res = await api().post("/api/v1/slots").set(bearer(doctor)).send({ slots: [{ startTime: start.toISOString(), endTime: end.toISOString() }] });
  if (res.status !== 201) throw new Error(`create slot failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.slots[0].id as string;
}

let keyCounter = 0;
export const newKey = () => `k-${Date.now()}-${keyCounter++}`;

export const book = (patient: Account, slotId: string, key = newKey()) =>
  api().post("/api/v1/bookings").set(bearer(patient)).set("Idempotency-Key", key).send({ slotId });

export const pay = (patient: Account, paymentId: string, outcome: "success" | "failure" = "success", key = newKey()) =>
  api().post(`/api/v1/payments/${paymentId}/pay`).set(bearer(patient)).set("Idempotency-Key", key).send({ outcome });

// Book + pay in one go; returns ids for lifecycle tests.
export async function confirmedConsultation(patient: Account, doctor: Account & { doctorId: string }, hoursFromNow?: number) {
  const slotId = await makeSlot(doctor, hoursFromNow);
  const booked = await book(patient, slotId);
  if (booked.status !== 201) throw new Error(`book failed: ${booked.status} ${JSON.stringify(booked.body)}`);
  const paid = await pay(patient, booked.body.payment.id);
  if (paid.status !== 200) throw new Error(`pay failed: ${paid.status} ${JSON.stringify(paid.body)}`);
  return { slotId, consultationId: booked.body.consultation.id as string, paymentId: booked.body.payment.id as string };
}

// Move a slot to "now" so the doctor can start it (real slots must be created in the future).
export async function shiftSlotToNow(slotId: string, consultationId: string, startOffsetMinutes = 0, lengthMinutes = 30) {
  const start = new Date(Date.now() + startOffsetMinutes * 60_000);
  const end = new Date(start.getTime() + lengthMinutes * 60_000);
  await prisma.availabilitySlot.update({ where: { id: slotId }, data: { startTime: start, endTime: end } });
  await prisma.consultation.update({ where: { id: consultationId }, data: { scheduledAt: start } });
}
