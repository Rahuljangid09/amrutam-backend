import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/config/prisma";
import { createCrypto } from "../src/common/crypto";
import { reencryptAll } from "../src/common/keyRotation";
import { api, bearer, makePatient, resetDb } from "./helpers";

const K1 = "e764723e2a31d0539846fa7ab1a81bea3d7b7e9e7bca1af3e7ee3bff610e69a1";
const K2 = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

describe("key rotation", () => {
  beforeAll(resetDb);

  it("moves stored ciphertext to the new key, keeps it readable, and is safe to re-run", async () => {
    const patient = await makePatient();
    await api().patch("/api/v1/users/me").set(bearer(patient)).send({ phone: "+91 98765 43210" }).expect(200);
    await api().post("/api/v1/auth/mfa/setup").set(bearer(patient)).expect(200);

    const rotated = createCrypto(`v1:${K1},v2:${K2}`, "v2");
    const first = await reencryptAll(rotated);
    expect(first.phones).toBe(1);
    expect(first.mfaSecrets).toBe(1);

    const profile = await prisma.profile.findUniqueOrThrow({ where: { userId: patient.id } });
    expect(profile.phoneEnc!.startsWith("v2.")).toBe(true);
    expect(rotated.decrypt(profile.phoneEnc!, `profile-phone:${patient.id}`)).toBe("+91 98765 43210");

    // the API (which only knows v1 as active but still holds both keys in real deployments) reads it back
    const second = await reencryptAll(rotated);
    expect(second).toEqual({ mfaSecrets: 0, phones: 0, notes: 0, prescriptions: 0 });
  });
});
