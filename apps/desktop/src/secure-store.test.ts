import { describe, expect, it } from "vitest";
import { ActivationManager } from "./activation-manager";
import type { SecretStore } from "./secure-store";

class MemoryStore implements SecretStore {
  value: string | null = null;
  async read() {
    return this.value;
  }
  async write(value: string) {
    this.value = value;
  }
  async clear() {
    this.value = null;
  }
}

describe("ActivationManager", () => {
  it("exchanges an activation and persists only encrypted-store input", async () => {
    const store = new MemoryStore();
    const manager = new ActivationManager({
      apiUrl: "https://mhub.example.test/agent-api/v1/activations:exchange",
      controlUrl: "wss://relay.example.test/agent/v1/control",
      platform: "macos",
      store,
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.activation_code).toBe("activation-code");
        expect(typeof body.device_public_key).toBe("string");
        return new Response(
          JSON.stringify({
            proxy_id: "cpx_01K1D1NJ000000000000008003",
            credential_id: "cpc_01K1D1NJ000000000000008003",
            refresh_credential: "refresh-credential",
            proxy_name: "Dev Mac",
            platform: "macos",
            admin_state: "active",
            activated_at: "2026-08-12T09:00:00Z",
            credential_expires_at: "2026-09-12T09:00:00Z",
          }),
          { status: 201 },
        );
      },
    });

    const activated = await manager.activate("activation-code");
    expect(activated.result.proxyId).toBe("cpx_01K1D1NJ000000000000008003");
    expect(store.value).toContain("devicePrivateKey");
    expect(store.value).toContain("refreshCredential");
    expect(activated.result).not.toHaveProperty("refreshCredential");
  });
});
