import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/config/prisma";
import { releaseExpiredHolds } from "../src/jobs/holdExpiry";
import { Account, api, bearer, book, makeAdmin, makeDoctor, makePatient, makeSlot, newKey, pay, resetDb } from "./helpers";

let admin: Account;
let doctor: Account & { doctorId: string };

beforeAll(async () => {
  await resetDb();
  admin = await makeAdmin();
  doctor = await makeDoctor(admin);
});

describe("slots", () => {
  it("rejects overlapping slots for the same doctor at the database level", async () => {
    const start = new Date(Date.now() + 200 * 3600_000);
    const mk = (offsetMin: number) => ({ startTime: new Date(start.getTime() + offsetMin * 60_000).toISOString(), endTime: new Date(start.getTime() + (offsetMin + 30) * 60_000).toISOString() });
    const first = await api().post("/api/v1/slots").set(bearer(doctor)).send({ slots: [mk(0)] });
    expect(first.status).toBe(201);
    const overlap = await api().post("/api/v1/slots").set(bearer(doctor)).send({ slots: [mk(15)] });
    expect(overlap.status).toBe(409);
  });

  it("only lists AVAILABLE future slots to patients", async () => {
    const patient = await makePatient();
    const slotId = await makeSlot(doctor, 300);
    const listed = await api().get(`/api/v1/doctors/${doctor.doctorId}/slots`).set(bearer(patient));
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain(slotId);
    await book(patient, slotId);
    const after = await api().get(`/api/v1/doctors/${doctor.doctorId}/slots`).set(bearer(patient));
    expect(JSON.stringify(after.body)).not.toContain(slotId);
  });
});

describe("booking + idempotency", () => {
  it("requires an Idempotency-Key", async () => {
    const patient = await makePatient();
    const slotId = await makeSlot(doctor, 400);
    const res = await api().post("/api/v1/bookings").set(bearer(patient)).send({ slotId });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("replays the stored response for a repeated key and creates exactly one booking", async () => {
    const patient = await makePatient();
    const slotId = await makeSlot(doctor, 410);
    const key = newKey();
    const a = await book(patient, slotId, key);
    const b = await book(patient, slotId, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(await prisma.consultation.count({ where: { slotId } })).toBe(1);
    expect(await prisma.payment.count({ where: { patientId: patient.id } })).toBe(1);
  });

  it("returns 422 when the same key is reused with a different request", async () => {
    const patient = await makePatient();
    const s1 = await makeSlot(doctor, 420);
    const s2 = await makeSlot(doctor, 421);
    const key = newKey();
    expect((await book(patient, s1, key)).status).toBe(201);
    const res = await book(patient, s2, key);
    expect(res.status).toBe(422);
  });

  it("scopes keys per user: another patient using the same key is not a replay", async () => {
    const p1 = await makePatient();
    const p2 = await makePatient();
    const s1 = await makeSlot(doctor, 430);
    const s2 = await makeSlot(doctor, 431);
    const key = newKey();
    const a = await book(p1, s1, key);
    const b = await book(p2, s2, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.consultation.id).not.toBe(a.body.consultation.id);
  });

  it("concurrent retries with the same key produce ONE booking (in-flight or replay, never two)", async () => {
    const patient = await makePatient();
    const slotId = await makeSlot(doctor, 440);
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 8 }, () => book(patient, slotId, key)));
    const created = results.filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    // everything else is either a stored replay (201) or an explicit "still processing" (409)
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(new Set(created.map((r) => r.body.consultation.id)).size).toBe(1);
    expect(await prisma.consultation.count({ where: { slotId } })).toBe(1);
  });
});

describe("double booking is impossible", () => {
  it("30 patients race for one slot: exactly one wins", async () => {
    const slotId = await makeSlot(doctor, 500);
    const patients = await Promise.all(Array.from({ length: 30 }, (_, i) => makePatient(`race${i}`)));
    const results = await Promise.all(patients.map((p) => book(p, slotId)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(29);
    expect(await prisma.consultation.count({ where: { slotId, status: "PENDING_PAYMENT" } })).toBe(1);
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slotId } })).status).toBe("HELD");
  });

  it("the partial unique index is a second line of defence below the application", async () => {
    const patient = await makePatient();
    const slotId = await makeSlot(doctor, 510);
    const booked = await book(patient, slotId);
    expect(booked.status).toBe(201);
    await expect(
      prisma.consultation.create({ data: { patientId: patient.id, doctorId: doctor.doctorId, slotId, scheduledAt: new Date(Date.now() + 510 * 3600_000) } }),
    ).rejects.toThrow();
  });

  it("limits how many unpaid holds one patient can accumulate", async () => {
    const patient = await makePatient();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await book(patient, await makeSlot(doctor, 520 + i))).status);
    expect(statuses).toEqual([201, 201, 201, 429]);
  });
});

describe("payment saga", () => {
  it("success: slot BOOKED, payment SUCCEEDED, consultation CONFIRMED, outbox event written", async () => {
    const patient = await makePatient();
    const slotId = await makeSlot(doctor, 600);
    const booked = await book(patient, slotId);
    const paid = await pay(patient, booked.body.payment.id);
    expect(paid.status).toBe(200);
    expect(paid.body.consultation.status).toBe("CONFIRMED");
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slotId } })).status).toBe("BOOKED");
    expect(await prisma.outboxEvent.count({ where: { type: "consultation.confirmed", aggregateId: booked.body.consultation.id } })).toBe(1);
  });

  it("repeating a successful payment is a safe no-op", async () => {
    const patient = await makePatient();
    const booked = await book(patient, await makeSlot(doctor, 610));
    expect((await pay(patient, booked.body.payment.id)).status).toBe(200);
    expect((await pay(patient, booked.body.payment.id)).status).toBe(200); // fresh key, same outcome
    expect(await prisma.outboxEvent.count({ where: { type: "consultation.confirmed", aggregateId: booked.body.consultation.id } })).toBe(1);
  });

  it("failure compensates: slot goes back on sale, consultation cancelled, payment FAILED", async () => {
    const patient = await makePatient();
    const slotId = await makeSlot(doctor, 620);
    const booked = await book(patient, slotId);
    const failed = await pay(patient, booked.body.payment.id, "failure");
    expect(failed.status).toBe(200);
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slotId } })).status).toBe("AVAILABLE");
    expect((await prisma.consultation.findUniqueOrThrow({ where: { id: booked.body.consultation.id } })).status).toBe("CANCELLED");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: booked.body.payment.id } })).status).toBe("FAILED");
    // someone else can now book it
    expect((await book(await makePatient(), slotId)).status).toBe(201);
  });

  it("a patient cannot pay someone else's payment (404, no existence leak)", async () => {
    const owner = await makePatient();
    const other = await makePatient();
    const booked = await book(owner, await makeSlot(doctor, 630));
    expect((await pay(other, booked.body.payment.id)).status).toBe(404);
  });

  it("paying after the hold expired compensates and answers 409 HOLD_EXPIRED", async () => {
    const patient = await makePatient();
    const slotId = await makeSlot(doctor, 640);
    const booked = await book(patient, slotId);
    await prisma.availabilitySlot.update({ where: { id: slotId }, data: { heldUntil: new Date(Date.now() - 1000) } });
    const res = await pay(patient, booked.body.payment.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("HOLD_EXPIRED");
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slotId } })).status).toBe("AVAILABLE");
  });

  it("racing payments for one booking settle exactly once", async () => {
    const patient = await makePatient();
    const booked = await book(patient, await makeSlot(doctor, 650));
    const results = await Promise.all(Array.from({ length: 6 }, () => pay(patient, booked.body.payment.id)));
    for (const r of results) expect(r.status).toBe(200);
    expect(await prisma.payment.count({ where: { id: booked.body.payment.id, status: "SUCCEEDED" } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { type: "consultation.confirmed", aggregateId: booked.body.consultation.id } })).toBe(1);
  });
});

describe("hold expiry", () => {
  it("the worker job releases expired holds and cancels the unpaid consultation", async () => {
    const patient = await makePatient();
    const slotId = await makeSlot(doctor, 700);
    const booked = await book(patient, slotId);
    await prisma.availabilitySlot.update({ where: { id: slotId }, data: { heldUntil: new Date(Date.now() - 60_000) } });

    const released = await releaseExpiredHolds();
    expect(released).toBeGreaterThanOrEqual(1);
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slotId } })).status).toBe("AVAILABLE");
    expect((await prisma.consultation.findUniqueOrThrow({ where: { id: booked.body.consultation.id } })).cancellationReason).toBe("hold_expired");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: booked.body.payment.id } })).status).toBe("FAILED");
    expect(await prisma.outboxEvent.count({ where: { type: "consultation.cancelled", aggregateId: booked.body.consultation.id } })).toBe(1);
  });

  it("never touches a paid booking or a hold that is still valid", async () => {
    const patient = await makePatient();
    const paidSlot = await makeSlot(doctor, 710);
    const heldSlot = await makeSlot(doctor, 711);
    const paid = await book(patient, paidSlot);
    await pay(patient, paid.body.payment.id);
    await book(patient, heldSlot);
    await releaseExpiredHolds();
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: paidSlot } })).status).toBe("BOOKED");
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: heldSlot } })).status).toBe("HELD");
  });

  it("a new patient can take over an expired hold even before the job runs", async () => {
    const first = await makePatient();
    const second = await makePatient();
    const slotId = await makeSlot(doctor, 720);
    const a = await book(first, slotId);
    await prisma.availabilitySlot.update({ where: { id: slotId }, data: { heldUntil: new Date(Date.now() - 1000) } });
    const b = await book(second, slotId);
    expect(b.status).toBe(201);
    expect((await prisma.consultation.findUniqueOrThrow({ where: { id: a.body.consultation.id } })).status).toBe("CANCELLED");
    // the first patient can no longer pay for it
    expect((await pay(first, a.body.payment.id)).status).toBe(409);
  });
});
