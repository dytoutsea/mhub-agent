import { createPublicKey, verify } from "node:crypto";

import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

const X509_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

describe("mobile Ed25519 compatibility", () => {
  it("verifies a mobile signature with the server-compatible key encoding", () => {
    const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const publicKeyBytes = ed25519.getPublicKey(privateKey);
    const message = new TextEncoder().encode("MHub canonical request");
    const signature = ed25519.sign(message, privateKey);
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from(X509_ED25519_PREFIX), Buffer.from(publicKeyBytes)]),
      format: "der",
      type: "spki",
    });

    expect(verify(null, Buffer.from(message), publicKey, Buffer.from(signature))).toBe(true);
  });
});
