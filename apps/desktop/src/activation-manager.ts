import { generateKeyPairSync } from "node:crypto";
import type { DesktopAgentRuntimeConfig } from "./agent-runtime";
import { type ActivationResult, activationResultSchema } from "./contracts";
import type { SecretStore } from "./secure-store";

export interface ActivationManagerOptions {
  readonly apiUrl: string;
  readonly controlUrl: string;
  readonly platform: "windows" | "macos";
  readonly store: SecretStore;
  readonly fetchImpl?: typeof fetch;
}

export class ActivationManager {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ActivationManagerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    validateEndpoint(options.apiUrl, "/agent-api/v1/activations:exchange");
    validateControlUrl(options.controlUrl);
  }

  async loadRuntimeConfig(): Promise<DesktopAgentRuntimeConfig | null> {
    const raw = await this.options.store.read();
    if (!raw) {
      return null;
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (!isStoredConfig(value)) {
        throw new Error("invalid");
      }
      return {
        controlUrl: value.controlUrl,
        proxyId: value.proxyId,
        sessionTicketApiUrl: value.apiUrl.replace("/activations:exchange", "/session-tickets"),
        credentialId: value.credentialId,
        devicePrivateKey: value.devicePrivateKey,
      };
    } catch {
      throw new Error("SECURE_STORAGE_DATA_INVALID");
    }
  }

  async activate(
    activationCode: string,
  ): Promise<{ result: ActivationResult; config: DesktopAgentRuntimeConfig }> {
    if (!activationCode.trim() || activationCode.length > 160) {
      throw new Error("ACTIVATION_CODE_INVALID");
    }
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyValue = privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url");
    const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
    const publicKeyValue = publicKeyDer.subarray(publicKeyDer.length - 32).toString("base64url");
    const response = await this.fetchImpl(this.options.apiUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        activation_code: activationCode.trim(),
        device_public_key: publicKeyValue,
        platform: this.options.platform,
        agent_version: "0.1.0",
      }),
    });
    if (!response.ok) {
      throw new Error(`ACTIVATION_REQUEST_FAILED_${response.status}`);
    }
    const raw: unknown = await response.json();
    const parsed = parseActivationResponse(raw);
    const config: DesktopAgentRuntimeConfig = {
      controlUrl: this.options.controlUrl,
      proxyId: parsed.proxyId,
      sessionTicketApiUrl: this.options.apiUrl.replace("/activations:exchange", "/session-tickets"),
      credentialId: parsed.credentialId,
      devicePrivateKey: privateKeyValue,
    };
    await this.options.store.write(
      JSON.stringify({
        apiUrl: this.options.apiUrl,
        controlUrl: this.options.controlUrl,
        proxyId: parsed.proxyId,
        credentialId: parsed.credentialId,
        devicePrivateKey: privateKeyValue,
        refreshCredential: parsed.refreshCredential,
      }),
    );
    return { result: parsed.result, config };
  }
}

function parseActivationResponse(value: unknown): {
  result: ActivationResult;
  proxyId: string;
  credentialId: string;
  refreshCredential: string;
} {
  if (!isObject(value)) {
    throw new Error("ACTIVATION_RESPONSE_INVALID");
  }
  const proxyId = text(value.proxy_id);
  const credentialId = text(value.credential_id);
  const refreshCredential = text(value.refresh_credential);
  if (refreshCredential.length > 512) {
    throw new Error("ACTIVATION_RESPONSE_INVALID");
  }
  const result = activationResultSchema.parse({
    proxyId,
    proxyName: value.proxy_name,
    platform: value.platform,
    activatedAt: value.activated_at,
    credentialExpiresAt: value.credential_expires_at,
  });
  if (!/^cpc_[0-9A-HJKMNP-TV-Z]{26}$/.test(credentialId)) {
    throw new Error("ACTIVATION_RESPONSE_INVALID");
  }
  return { result, proxyId, credentialId, refreshCredential };
}

function isStoredConfig(value: unknown): value is {
  apiUrl: string;
  controlUrl: string;
  proxyId: string;
  credentialId: string;
  devicePrivateKey: string;
  refreshCredential: string;
} {
  return (
    isObject(value) &&
    typeof value.apiUrl === "string" &&
    typeof value.controlUrl === "string" &&
    typeof value.proxyId === "string" &&
    typeof value.credentialId === "string" &&
    typeof value.devicePrivateKey === "string" &&
    typeof value.refreshCredential === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new Error("ACTIVATION_RESPONSE_INVALID");
  }
  return value;
}

function validateEndpoint(value: string, pathname: string) {
  const url = new URL(value);
  if (
    !(url.protocol === "https:" || url.protocol === "http:") ||
    url.pathname !== pathname ||
    url.search ||
    url.hash
  ) {
    throw new Error("AGENT_API_URL_INVALID");
  }
}

function validateControlUrl(value: string) {
  const url = new URL(value);
  if (
    !(url.protocol === "ws:" || url.protocol === "wss:") ||
    url.pathname !== "/agent/v1/control" ||
    url.search ||
    url.hash
  ) {
    throw new Error("CONTROL_URL_INVALID");
  }
}
