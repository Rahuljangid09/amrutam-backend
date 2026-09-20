import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/config/prisma";
import { Account, api, bearer, book, confirmedConsultation, makeAdmin, makeDoctor, makePatient, makeSlot, newKey, pay, resetDb, shiftSlotToNow } from "./helpers";

let admin: Account;
let doctor: Account & { doctorId: string };
let otherDoctor: Account & { doctorId: string };

beforeAll(async () => {
  await resetDb();
  admin = await makeAdmin();
  doctor = await makeDoctor(admin);
  otherDoctor = await makeDoctor(admin);
});

// Tests that move a slot to "now" get their own doctor: two shifted slots for one doctor would (correctly) violate
// the no-overlap constraint.
async function fixture() {
  const d = await makeDoctor(admin);
  const patient = await makePatient();
  return { d, patient, ...(await confirmedConsultation(patient, d)) };
}

const get = (who: Account, id: string) => api().get(`/api/v1/consultations/${id}`).set(bearer(who));
const act = (who: Account, id: string, action: string, body: object = {}) => api().post(`/api/v1/consultations/${id}/${action}`).set(bearer(who)).send(body);

describe("visibility", () => {
  it("patients see only their own consultations; strangers get 404, not 403", async () => {
    const owner = await makePatient();
    const stranger = await makePatient();
    const { consultationId } = await confirmedConsultation(owner, doctor);

    expect((await get(owner, consultationId)).status).toBe(200);
    expect((await get(stranger, consultationId)).status).toBe(404);
    expect((await get(otherDoctor, consultationId)).status).toBe(404);
    expect((await get(doctor, consultationId)).status).toBe(200);
    expect((await get(admin, consultationId)).status).toBe(200);

    const list = await api().get("/api/v1/consultations").set(bearer(stranger));
    expect(list.body.items).toHaveLength(0);
    const mine = await api().get("/api/v1/consultations").set(bearer(owner));
    expect(mine.body.total).toBe(1);
  });

  it("filters the list by status", async () => {
    const patient = await makePatient();
    await confirmedConsultation(patient, doctor);
    const pending = await book(patient, await makeSlot(doctor, 90));
    expect(pending.status).toBe(201);
    const confirmed = await api().get("/api/v1/consultations?status=CONFIRMED").set(bearer(patient));
    expect(confirmed.body.items.every((c: { status: string }) => c.status === "CONFIRMED")).toBe(true);
    const bad = await api().get("/api/v1/consultations?status=NOPE").set(bearer(patient));
    expect(bad.status).toBe(400);
  });
});

describe("lifecycle: CONFIRMED -> IN_PROGRESS -> COMPLETED", () => {
  it("enforces the time window, order of states, and only the treating doctor", async () => {
    const { d: doctor, patient, slotId, consultationId } = await fixture();

    // too early (slot is far away)
    const early = await act(doctor, consultationId, "start");
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("TOO_EARLY");

    // cannot complete something that never started
    expect((await act(doctor, consultationId, "complete")).status).toBe(409);

    await shiftSlotToNow(slotId, consultationId);

    // a different doctor cannot touch it
    expect((await act(otherDoctor, consultationId, "start")).status).toBe(404);
    // patients cannot run doctor actions
    expect((await act(patient, consultationId, "start")).status).toBe(403);

    const started = await act(doctor, consultationId, "start");
    expect(started.status).toBe(200);
    expect(started.body.consultation.status).toBe("IN_PROGRESS");
    // repeating is safe
    expect((await act(doctor, consultationId, "start")).body.consultation.status).toBe("IN_PROGRESS");

    const done = await act(doctor, consultationId, "complete", { notes: "BP 120/80. Continue current medication." });
    expect(done.status).toBe(200);
    expect(done.body.consultation.status).toBe("COMPLETED");
    expect((await act(doctor, consultationId, "complete")).body.consultation.status).toBe("COMPLETED");

    // completion is queued for delivery
    expect(await prisma.outboxEvent.count({ where: { type: "consultation.completed", aggregateId: consultationId } })).toBe(1);
  });

  it("clinical notes are encrypted at rest, readable by patient and doctor, hidden from admins", async () => {
    const { d: doctor, patient, slotId, consultationId } = await fixture();
    await shiftSlotToNow(slotId, consultationId);
    await act(doctor, consultationId, "start");
    const note = "Patient reports chest tightness on exertion";
    await act(doctor, consultationId, "complete", { notes: note });

    const raw = await prisma.$queryRaw<{ notes_enc: string }[]>`SELECT notes_enc FROM consultations WHERE id = ${consultationId}::uuid`;
    expect(raw[0].notes_enc).toBeTruthy();
    expect(raw[0].notes_enc).not.toContain("chest");

    expect((await get(patient, consultationId)).body.consultation.notes).toBe(note);
    expect((await get(doctor, consultationId)).body.consultation.notes).toBe(note);
    expect((await get(admin, consultationId)).body.consultation.notes).toBeNull();
  });

  it("no-show is only allowed 10 minutes after the start time", async () => {
    const { d: doctor, patient, slotId, consultationId } = await fixture();
    await shiftSlotToNow(slotId, consultationId, 0);
    expect((await act(doctor, consultationId, "no-show")).body.error.code).toBe("TOO_EARLY");

    const b = await confirmedConsultation(patient, doctor);
    await shiftSlotToNow(b.slotId, b.consultationId, -45); // ended before the other slot starts: no overlap
    const res = await act(doctor, b.consultationId, "no-show");
    expect(res.status).toBe(200);
    expect(res.body.consultation.status).toBe("NO_SHOW");
  });
});

describe("cancellation", () => {
  it("patient cancels a distant booking: refund recorded and slot goes back on sale", async () => {
    const patient = await makePatient();
    const { slotId, consultationId, paymentId } = await confirmedConsultation(patient, doctor);
    const res = await act(patient, consultationId, "cancel", { reason: "plans changed" });
    expect(res.status).toBe(200);
    expect(res.body.consultation.status).toBe("CANCELLED");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe("REFUNDED");
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slotId } })).status).toBe("AVAILABLE");
    // repeating is idempotent
    expect((await act(patient, consultationId, "cancel")).status).toBe(200);
  });

  it("patients cannot cancel inside the cut-off window, but the doctor can", async () => {
    const { d: doctor, patient, slotId, consultationId } = await fixture();
    await shiftSlotToNow(slotId, consultationId, 20); // starts in 20 min, cut-off is 60
    const denied = await act(patient, consultationId, "cancel");
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe("CANCEL_WINDOW_PASSED");
    expect((await act(doctor, consultationId, "cancel", { reason: "emergency" })).status).toBe(200);
  });

  it("a stranger cannot cancel someone else's consultation", async () => {
    const owner = await makePatient();
    const stranger = await makePatient();
    const { consultationId } = await confirmedConsultation(owner, doctor);
    expect((await act(stranger, consultationId, "cancel")).status).toBe(404);
  });

  it("cancelling an unpaid booking releases the slot and fails the payment", async () => {
    const patient = await makePatient();
    const slotId = await makeSlot(doctor, 95);
    const booked = await book(patient, slotId);
    expect((await act(patient, booked.body.consultation.id, "cancel")).status).toBe(200);
    expect((await prisma.availabilitySlot.findUniqueOrThrow({ where: { id: slotId } })).status).toBe("AVAILABLE");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: booked.body.payment.id } })).status).toBe("FAILED");
    expect((await pay(patient, booked.body.payment.id)).status).toBe(409);
  });
});

describe("prescriptions", () => {
  const rx = { diagnosis: "Hypertension stage 1", medications: [{ name: "Amlodipine", dosage: "5mg", frequency: "once daily", durationDays: 30 }], advice: "Reduce salt intake" };
  const create = (who: Account, id: string, body: object = rx, key = newKey()) =>
    api().post(`/api/v1/consultations/${id}/prescription`).set(bearer(who)).set("Idempotency-Key", key).send(body);

  it("cannot be issued before the consultation starts", async () => {
    const patient = await makePatient();
    const { consultationId } = await confirmedConsultation(patient, doctor);
    expect((await create(doctor, consultationId)).status).toBe(409);
  });

  it("is issued by the treating doctor, encrypted at rest, one per consultation", async () => {
    const { d: doctor, patient, slotId, consultationId } = await fixture();
    await shiftSlotToNow(slotId, consultationId);
    await act(doctor, consultationId, "start");

    // other doctors and patients cannot issue one
    expect((await create(otherDoctor, consultationId)).status).toBe(404);
    expect((await create(patient, consultationId)).status).toBe(403);
    // validation
    expect((await create(doctor, consultationId, { diagnosis: "x", medications: [] })).status).toBe(400);

    const key = newKey();
    const made = await create(doctor, consultationId, rx, key);
    expect(made.status).toBe(201);
    // network retry with the same key: replay, not a second prescription
    const retry = await create(doctor, consultationId, rx, key);
    expect(retry.body).toEqual(made.body);
    // a *new* attempt is rejected by the database constraint
    const second = await create(doctor, consultationId);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("PRESCRIPTION_EXISTS");

    const raw = await prisma.$queryRaw<{ content_enc: string }[]>`SELECT content_enc FROM prescriptions WHERE consultation_id = ${consultationId}::uuid`;
    expect(raw[0].content_enc).not.toContain("Amlodipine");
    expect(raw[0].content_enc).not.toContain("Hypertension");
  });

  it("is readable by the patient and the issuing doctor only, and every read is audited", async () => {
    const stranger = await makePatient();
    const { d: doctor, patient, slotId, consultationId } = await fixture();
    await shiftSlotToNow(slotId, consultationId);
    await act(doctor, consultationId, "start");
    const made = await create(doctor, consultationId);
    const rxId = made.body.prescription.id;

    const url = `/api/v1/consultations/${consultationId}/prescription`;
    const asPatient = await api().get(url).set(bearer(patient));
    expect(asPatient.status).toBe(200);
    expect(asPatient.body.prescription.content.medications[0].name).toBe("Amlodipine");
    expect((await api().get(url).set(bearer(doctor))).status).toBe(200);

    expect((await api().get(url).set(bearer(stranger))).status).toBe(404);
    expect((await api().get(url).set(bearer(otherDoctor))).status).toBe(404);
    expect((await api().get(url).set(bearer(admin))).status).toBe(403); // admins are not clinical staff

    const views = await prisma.auditLog.count({ where: { action: "PRESCRIPTION_VIEWED", entityId: rxId } });
    expect(views).toBe(2);
  });

  it("the list endpoint returns metadata only", async () => {
    const { d: doctor, patient, slotId, consultationId } = await fixture();
    await shiftSlotToNow(slotId, consultationId);
    await act(doctor, consultationId, "start");
    await create(doctor, consultationId);
    const list = await api().get("/api/v1/prescriptions").set(bearer(patient));
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(JSON.stringify(list.body)).not.toContain("Amlodipine");
  });
});
