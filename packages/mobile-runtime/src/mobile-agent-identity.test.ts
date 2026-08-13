import { describe, expect, it, vi } from "vitest";

import {
  decodeBase64Url,
  encodeBase64Url,
  MobileAgentIdentityManager,
  type MobileDeviceCrypto,
  type MobileSecretStore,
} from "./mobile-agent-identity";

const ACTIVATION_API_URL = "https://api.example/agent-api/v1/activations:exchange";
const CONTROL_URL = "wss://relay.example/agent/v1/control";
const PROXY_ID = "cpx_01K1D1NJ000000000000008003";
const CREDENTIAL_ID = "cpc_01K1D1NJ000000000000008003";

describe("MobileAgentIdentityManager", () => {
  it("activates with a raw Ed25519 public key and stores secrets without returning them", async () => {
    const store = new MemorySecretStore();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        activation_code: "one-time-code",
        device_public_key: encodeBase64Url(bytes(32, 64)),
        platform: "android",
        device_model: "Pixel",
        os_version: "16",
        agent_version: "0.1.0",
      });
      expect(init?.headers).not.toHaveProperty("Authorization");
      return Response.json(activationResponse(), { status: 201 });
    });
    const manager = createManager(store, fetchImpl);

    const result = await manager.activate(" one-time-code ");

    expect(result).toEqual({
      proxyId: PROXY_ID,
      proxyName: "广州移动出口",
      platform: "android",
      activatedAt: "2026-08-13T07:00:00Z",
      credentialExpiresAt: "2026-09-13T07:00:00Z",
    });
    const stored = JSON.parse(store.value ?? "{}");
    expect(stored).toMatchObject({
      proxyId: PROXY_ID,
      credentialId: CREDENTIAL_ID,
      refreshCredential: "refresh-value",
    });
    expect(result).not.toHaveProperty("credentialId");
    expect(result).not.toHaveProperty("refreshCredential");
    expect(result).not.toHaveProperty("devicePrivateKey");
  });

  it("signs the exact server canonical ticket request with a fresh nonce", async () => {
    const store = new MemorySecretStore();
    const sign = vi.fn(async (_privateKey: Uint8Array, message: Uint8Array) => {
      expect(new TextDecoder().decode(message)).toBe(
        [
          "POST",
          "/agent-api/v1/session-tickets",
          "",
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          CREDENTIAL_ID,
          "1786604400",
          encodeBase64Url(bytes(16, 96)),
        ].join("\n"),
      );
      return bytes(64, 128);
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(activationResponse(), { status: 201 }))
      .mockImplementationOnce(async (input, init) => {
        expect(String(input)).toBe("https://api.example/agent-api/v1/session-tickets");
        expect(init?.body).toBeUndefined();
        expect(init?.headers).toMatchObject({
          "X-Credential-Id": CREDENTIAL_ID,
          "X-Timestamp": "1786604400",
          "X-Nonce": encodeBase64Url(bytes(16, 96)),
          "X-Signature": encodeBase64Url(bytes(64, 128)),
        });
        return Response.json({
          ticket: "signed-ticket",
          expires_at: "2026-08-13T07:05:00Z",
        });
      });
    const manager = createManager(store, fetchImpl, { sign });
    await manager.activate("one-time-code");

    await expect(manager.createTicketProvider().issue()).resolves.toEqual({
      ticket: "signed-ticket",
    });
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("fails closed for corrupt or environment-mismatched secure storage", async () => {
    const corrupt = new MemorySecretStore("not-json");
    await expect(createManager(corrupt, vi.fn()).loadRegistration()).rejects.toThrow(
      "SECURE_STORAGE_DATA_INVALID",
    );

    const store = new MemorySecretStore();
    const manager = createManager(
      store,
      vi.fn(async () => Response.json(activationResponse(), { status: 201 })),
    );
    await manager.activate("one-time-code");
    const otherEnvironment = new MobileAgentIdentityManager({
      activationApiUrl: "https://other.example/agent-api/v1/activations:exchange",
      controlUrl: CONTROL_URL,
      platform: "android",
      store,
      crypto: fakeCrypto(),
    });
    await expect(otherEnvironment.loadRegistration()).rejects.toThrow(
      "SECURE_STORAGE_DATA_INVALID",
    );
  });

  it("does not persist an identity when secure storage fails", async () => {
    const store = new MemorySecretStore();
    store.write = vi.fn(async () => {
      throw new Error("platform detail");
    });
    const manager = createManager(
      store,
      vi.fn(async () => Response.json(activationResponse(), { status: 201 })),
    );

    await expect(manager.activate("one-time-code")).rejects.toThrow("SECURE_STORAGE_WRITE_FAILED");
    expect(store.value).toBeNull();
  });

  it("maps malformed service JSON to stable response errors", async () => {
    const invalidJson = new Response("not-json", {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
    await expect(
      createManager(
        new MemorySecretStore(),
        vi.fn(async () => invalidJson),
      ).activate("one-time-code"),
    ).rejects.toThrow("ACTIVATION_RESPONSE_INVALID");
  });

  it("strictly round-trips unpadded Base64URL", () => {
    for (const value of [bytes(1, 1), bytes(2, 2), bytes(32, 3), bytes(64, 4)]) {
      expect(decodeBase64Url(encodeBase64Url(value))).toEqual(value);
    }
    expect(() => decodeBase64Url("bad=")).toThrow("BASE64URL_INVALID");
  });
});

function createManager(
  store: MobileSecretStore,
  fetchImpl: typeof fetch,
  cryptoOverrides: Partial<MobileDeviceCrypto> = {},
): MobileAgentIdentityManager {
  return new MobileAgentIdentityManager({
    activationApiUrl: ACTIVATION_API_URL,
    controlUrl: CONTROL_URL,
    platform: "android",
    deviceModel: "Pixel",
    osVersion: "16",
    store,
    crypto: { ...fakeCrypto(), ...cryptoOverrides },
    fetchImpl,
    now: () => Date.parse("2026-08-13T07:00:00Z"),
  });
}

function fakeCrypto(): MobileDeviceCrypto {
  return {
    generateKeyPair: async () => ({ privateKey: bytes(32, 32), publicKey: bytes(32, 64) }),
    randomBytes: async (length) => bytes(length, 96),
    sign: async () => bytes(64, 128),
  };
}

class MemorySecretStore implements MobileSecretStore {
  constructor(public value: string | null = null) {}

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(value: string): Promise<void> {
    this.value = value;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

function activationResponse() {
  return {
    proxy_id: PROXY_ID,
    credential_id: CREDENTIAL_ID,
    refresh_credential: "refresh-value",
    proxy_name: "广州移动出口",
    platform: "android",
    admin_state: "active",
    activated_at: "2026-08-13T07:00:00Z",
    credential_expires_at: "2026-09-13T07:00:00Z",
  };
}

function bytes(length: number, start: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (start + index) % 256);
}
