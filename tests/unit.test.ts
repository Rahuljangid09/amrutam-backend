import { describe, expect, it } from "vitest";
import { createCrypto } from "../src/common/crypto";
import { canonicalJson, requestFingerprint } from "../src/common/idempotency";
import { backoffSeconds } from "../src/jobs/outbox";

const K1 = "a".repeat(64);
const K2 = "b".repeat(64);

describe("field encryption", () => {
  it("round-trips and never stores plaintext", () => {
    const c = createCrypto(`v1:${K1}`, "v1");
    const enc = c.encrypt("penicillin allergy", "prescription:1");
    expect(enc).not.toContain("penicillin");
    expect(c.decrypt(enc, "prescription:1")).toBe("penicillin allergy");
  });

  it("uses a fresh IV each time", () => {
    const c = createCrypto(`v1:${K1}`, "v1");
    expect(c.encrypt("same", "x")).not.toBe(c.encrypt("same", "x"));
  });

  it("refuses a ciphertext moved to another row (AAD binding)", () => {
    const c = createCrypto(`v1:${K1}`, "v1");
    const enc = c.encrypt("secret", "prescription:1");
    expect(() => c.decrypt(enc, "prescription:2")).toThrow();
  });

  it("detects tampering", () => {
    const c = createCrypto(`v1:${K1}`, "v1");
    const [id, iv, tag, data] = c.encrypt("secret", "a").split(".");
    const flipped = (data.startsWith("A") ? "B" : "A") + data.slice(1);
    expect(() => c.decrypt([id, iv, tag, flipped].join("."), "a")).toThrow();
  });

  it("supports key rotation: old data still decrypts, new writes use the active key", () => {
    const old = createCrypto(`v1:${K1}`, "v1");
    const legacy = old.encrypt("history", "a");
    const rotated = createCrypto(`v1:${K1},v2:${K2}`, "v2");
    expect(rotated.decrypt(legacy, "a")).toBe("history");
    expect(rotated.needsReencryption(legacy)).toBe(true);
    const fresh = rotated.encrypt("history", "a");
    expect(fresh.startsWith("v2.")).toBe(true);
    expect(rotated.needsReencryption(fresh)).toBe(false);
  });
});

describe("idempotency fingerprint", () => {
  it("ignores JSON key order", () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it("differs when the body differs", () => {
    expect(requestFingerprint("POST", "/x", { a: 1 })).not.toBe(requestFingerprint("POST", "/x", { a: 2 }));
  });
  it("differs when the path differs", () => {
    expect(requestFingerprint("POST", "/x", {})).not.toBe(requestFingerprint("POST", "/y", {}));
  });
});

describe("outbox backoff", () => {
  it("grows exponentially and is capped at one hour", () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([5, 10, 20, 40]);
    expect(backoffSeconds(30)).toBe(3600);
  });
});
