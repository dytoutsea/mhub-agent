import type { MobileDeviceCrypto } from "@mhub/mobile-runtime";
import { ed25519 } from "@noble/curves/ed25519.js";

export type SecureRandomBytes = (length: number) => Promise<Uint8Array>;

export function createEd25519DeviceCrypto(randomBytes: SecureRandomBytes): MobileDeviceCrypto {
  return {
    async generateKeyPair() {
      const privateKey = await randomBytes(32);
      if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
        throw new Error("DEVICE_RANDOM_SOURCE_INVALID");
      }
      return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
    },
    async randomBytes(length) {
      const value = await randomBytes(length);
      if (!(value instanceof Uint8Array) || value.length !== length) {
        throw new Error("DEVICE_RANDOM_SOURCE_INVALID");
      }
      return value;
    },
    async sign(privateKey, message) {
      return ed25519.sign(message, privateKey);
    },
  };
}
