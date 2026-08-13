import { describe, expect, it } from "vitest";

import { createEd25519DeviceCrypto } from "./ed25519-device-crypto";

describe("mobile Ed25519 adapter", () => {
  it("generates bounded Ed25519 key and signature material", async () => {
    const crypto = createEd25519DeviceCrypto(async (length) =>
      Uint8Array.from({ length }, (_, index) => index + 1),
    );
    const keyPair = await crypto.generateKeyPair();
    const message = new TextEncoder().encode("MHub canonical request");

    const signature = await crypto.sign(keyPair.privateKey, message);
    expect(keyPair.privateKey).toHaveLength(32);
    expect(keyPair.publicKey).toHaveLength(32);
    expect(signature).toHaveLength(64);
  });

  it("rejects an invalid random source", async () => {
    const crypto = createEd25519DeviceCrypto(async () => new Uint8Array(8));
    await expect(crypto.generateKeyPair()).rejects.toThrow("DEVICE_RANDOM_SOURCE_INVALID");
    await expect(crypto.randomBytes(16)).rejects.toThrow("DEVICE_RANDOM_SOURCE_INVALID");
  });
});
