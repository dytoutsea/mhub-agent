import type { SessionTicketProvider } from "./mobile-agent-runtime";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const AGENT_VERSION = "0.1.0";
const PROXY_ID = /^cpx_[0-9A-HJKMNP-TV-Z]{26}$/;
const CREDENTIAL_ID = /^cpc_[0-9A-HJKMNP-TV-Z]{26}$/;

export interface MobileSecretStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

export interface MobileDeviceCrypto {
  generateKeyPair(): Promise<{
    readonly privateKey: Uint8Array;
    readonly publicKey: Uint8Array;
  }>;
  randomBytes(length: number): Promise<Uint8Array>;
  sign(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
}

export interface MobileAgentRegistration {
  readonly proxyId: string;
  readonly proxyName: string;
  readonly platform: "android" | "ios";
  readonly activatedAt: string;
  readonly credentialExpiresAt: string;
}

export interface MobileAgentIdentityOptions {
  readonly activationApiUrl: string;
  readonly controlUrl: string;
  readonly allowInsecureDevelopmentEndpoints?: boolean;
  readonly platform: "android" | "ios";
  readonly store: MobileSecretStore;
  readonly crypto: MobileDeviceCrypto;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  readonly deviceModel?: string;
  readonly osVersion?: string;
}

type FetchLike = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

interface StoredIdentity extends MobileAgentRegistration {
  readonly activationApiUrl: string;
  readonly controlUrl: string;
  readonly credentialId: string;
  readonly devicePrivateKey: string;
  readonly refreshCredential: string;
}

export class MobileAgentIdentityManager {
  private readonly activationEndpoint: URL;
  private readonly sessionTicketEndpoint: URL;
  private readonly controlUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private readonly options: MobileAgentIdentityOptions) {
    this.activationEndpoint = endpoint(
      options.activationApiUrl,
      "/agent-api/v1/activations:exchange",
      options.allowInsecureDevelopmentEndpoints ?? false,
    );
    this.sessionTicketEndpoint = endpoint(
      options.activationApiUrl.replace(/\/activations:exchange$/, "/session-tickets"),
      "/agent-api/v1/session-tickets",
      options.allowInsecureDevelopmentEndpoints ?? false,
    );
    this.controlUrl = controlEndpoint(
      options.controlUrl,
      options.allowInsecureDevelopmentEndpoints ?? false,
    ).toString();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async loadRegistration(): Promise<MobileAgentRegistration | null> {
    const identity = await this.readIdentity();
    return identity ? registration(identity) : null;
  }

  async activate(activationCode: string): Promise<MobileAgentRegistration> {
    const code = activationCode.trim();
    if (!code || code.length > 160) {
      throw new Error("ACTIVATION_CODE_INVALID");
    }
    const keyPair = await this.options.crypto.generateKeyPair();
    try {
      requireBytes(keyPair.privateKey, 32, "DEVICE_PRIVATE_KEY_INVALID");
      requireBytes(keyPair.publicKey, 32, "DEVICE_PUBLIC_KEY_INVALID");
      const response = await this.fetchImpl(this.activationEndpoint.toString(), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          activation_code: code,
          device_public_key: encodeBase64Url(keyPair.publicKey),
          platform: this.options.platform,
          ...(this.options.deviceModel ? { device_model: this.options.deviceModel } : {}),
          ...(this.options.osVersion ? { os_version: this.options.osVersion } : {}),
          agent_version: AGENT_VERSION,
        }),
      });
      if (!response.ok) {
        throw new Error(`ACTIVATION_REQUEST_FAILED_${response.status}`);
      }
      const activated = parseActivationResponse(
        await responseJson(response, "ACTIVATION_RESPONSE_INVALID"),
        this.options.platform,
      );
      const stored: StoredIdentity = {
        ...activated.registration,
        activationApiUrl: this.activationEndpoint.toString(),
        controlUrl: this.controlUrl,
        credentialId: activated.credentialId,
        devicePrivateKey: encodeBase64Url(keyPair.privateKey),
        refreshCredential: activated.refreshCredential,
      };
      try {
        await this.options.store.write(JSON.stringify(stored));
      } catch {
        throw new Error("SECURE_STORAGE_WRITE_FAILED");
      }
      return activated.registration;
    } finally {
      keyPair.privateKey.fill(0);
      keyPair.publicKey.fill(0);
    }
  }

  createTicketProvider(): SessionTicketProvider {
    return { issue: async () => this.issueTicket() };
  }

  async clear(): Promise<void> {
    try {
      await this.options.store.clear();
    } catch {
      throw new Error("SECURE_STORAGE_CLEAR_FAILED");
    }
  }

  private async issueTicket(): Promise<{ readonly ticket: string }> {
    const identity = await this.readIdentity();
    if (!identity) {
      throw new Error("MOBILE_AGENT_NOT_ACTIVATED");
    }
    const privateKey = decodeBase64Url(identity.devicePrivateKey);
    const nonceBytes = await this.options.crypto.randomBytes(16);
    try {
      requireBytes(privateKey, 32, "DEVICE_PRIVATE_KEY_INVALID");
      requireBytes(nonceBytes, 16, "DEVICE_NONCE_INVALID");
      const timestamp = Math.floor(this.now() / 1_000).toString(10);
      const nonce = encodeBase64Url(nonceBytes);
      const canonical = new TextEncoder().encode(
        [
          "POST",
          this.sessionTicketEndpoint.pathname,
          this.sessionTicketEndpoint.searchParams.toString(),
          EMPTY_SHA256,
          identity.credentialId,
          timestamp,
          nonce,
        ].join("\n"),
      );
      let signature: Uint8Array;
      try {
        signature = await this.options.crypto.sign(privateKey, canonical);
      } finally {
        canonical.fill(0);
      }
      try {
        requireBytes(signature, 64, "DEVICE_SIGNATURE_INVALID");
        const response = await this.fetchImpl(this.sessionTicketEndpoint.toString(), {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Cache-Control": "no-store",
            "X-Credential-Id": identity.credentialId,
            "X-Nonce": nonce,
            "X-Signature": encodeBase64Url(signature),
            "X-Timestamp": timestamp,
          },
        });
        if (!response.ok) {
          throw new Error(`SESSION_TICKET_REQUEST_FAILED_${response.status}`);
        }
        return parseTicketResponse(
          await responseJson(response, "SESSION_TICKET_RESPONSE_INVALID"),
          this.now(),
        );
      } finally {
        signature.fill(0);
      }
    } finally {
      privateKey.fill(0);
      nonceBytes.fill(0);
    }
  }

  private async readIdentity(): Promise<StoredIdentity | null> {
    let raw: string | null;
    try {
      raw = await this.options.store.read();
    } catch {
      throw new Error("SECURE_STORAGE_READ_FAILED");
    }
    if (!raw) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return parseStoredIdentity(parsed, this.options);
    } catch {
      throw new Error("SECURE_STORAGE_DATA_INVALID");
    }
  }
}

function parseActivationResponse(
  value: unknown,
  platform: "android" | "ios",
): {
  readonly registration: MobileAgentRegistration;
  readonly credentialId: string;
  readonly refreshCredential: string;
} {
  if (!isObject(value)) {
    throw new Error("ACTIVATION_RESPONSE_INVALID");
  }
  const proxyId = requiredText(value.proxy_id, 128, "ACTIVATION_RESPONSE_INVALID");
  const credentialId = requiredText(value.credential_id, 128, "ACTIVATION_RESPONSE_INVALID");
  const refreshCredential = requiredText(
    value.refresh_credential,
    512,
    "ACTIVATION_RESPONSE_INVALID",
  );
  const proxyName = requiredText(value.proxy_name, 128, "ACTIVATION_RESPONSE_INVALID");
  const activatedAt = dateTime(value.activated_at, "ACTIVATION_RESPONSE_INVALID");
  const credentialExpiresAt = dateTime(value.credential_expires_at, "ACTIVATION_RESPONSE_INVALID");
  if (
    !PROXY_ID.test(proxyId) ||
    !CREDENTIAL_ID.test(credentialId) ||
    value.platform !== platform ||
    value.admin_state !== "active"
  ) {
    throw new Error("ACTIVATION_RESPONSE_INVALID");
  }
  return {
    registration: { proxyId, proxyName, platform, activatedAt, credentialExpiresAt },
    credentialId,
    refreshCredential,
  };
}

function parseTicketResponse(value: unknown, now: number): { readonly ticket: string } {
  if (!isObject(value)) {
    throw new Error("SESSION_TICKET_RESPONSE_INVALID");
  }
  const ticket = requiredText(value.ticket, 4_096, "SESSION_TICKET_RESPONSE_INVALID");
  const expiresAt = Date.parse(
    requiredText(value.expires_at, 64, "SESSION_TICKET_RESPONSE_INVALID"),
  );
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("SESSION_TICKET_RESPONSE_EXPIRED");
  }
  return { ticket };
}

function parseStoredIdentity(value: unknown, options: MobileAgentIdentityOptions): StoredIdentity {
  if (!isObject(value)) {
    throw new Error("invalid");
  }
  const identity: StoredIdentity = {
    proxyId: requiredText(value.proxyId, 128, "invalid"),
    proxyName: requiredText(value.proxyName, 128, "invalid"),
    platform: value.platform === "android" || value.platform === "ios" ? value.platform : fail(),
    activatedAt: dateTime(value.activatedAt, "invalid"),
    credentialExpiresAt: dateTime(value.credentialExpiresAt, "invalid"),
    activationApiUrl: requiredText(value.activationApiUrl, 2_048, "invalid"),
    controlUrl: requiredText(value.controlUrl, 2_048, "invalid"),
    credentialId: requiredText(value.credentialId, 128, "invalid"),
    devicePrivateKey: requiredText(value.devicePrivateKey, 128, "invalid"),
    refreshCredential: requiredText(value.refreshCredential, 512, "invalid"),
  };
  if (
    !PROXY_ID.test(identity.proxyId) ||
    !CREDENTIAL_ID.test(identity.credentialId) ||
    identity.platform !== options.platform ||
    identity.activationApiUrl !==
      endpoint(
        options.activationApiUrl,
        "/agent-api/v1/activations:exchange",
        options.allowInsecureDevelopmentEndpoints ?? false,
      ).toString() ||
    identity.controlUrl !==
      controlEndpoint(
        options.controlUrl,
        options.allowInsecureDevelopmentEndpoints ?? false,
      ).toString() ||
    decodeBase64Url(identity.devicePrivateKey).length !== 32
  ) {
    throw new Error("invalid");
  }
  return identity;
}

function registration(identity: StoredIdentity): MobileAgentRegistration {
  return {
    proxyId: identity.proxyId,
    proxyName: identity.proxyName,
    platform: identity.platform,
    activatedAt: identity.activatedAt,
    credentialExpiresAt: identity.credentialExpiresAt,
  };
}

function endpoint(value: string, pathname: string, allowInsecureDevelopmentEndpoint: boolean): URL {
  const url = new URL(value);
  if (
    !(
      url.protocol === "https:" ||
      (allowInsecureDevelopmentEndpoint && url.protocol === "http:")
    ) ||
    url.pathname !== pathname ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("AGENT_API_URL_INVALID");
  }
  return url;
}

function controlEndpoint(value: string, allowInsecureDevelopmentEndpoint: boolean): URL {
  const url = new URL(value);
  if (
    !(url.protocol === "wss:" || (allowInsecureDevelopmentEndpoint && url.protocol === "ws:")) ||
    url.pathname !== "/agent/v1/control" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("CONTROL_URL_INVALID");
  }
  return url;
}

function requiredText(value: unknown, maximum: number, errorCode: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(errorCode);
  }
  return value;
}

function dateTime(value: unknown, errorCode: string): string {
  const text = requiredText(value, 64, errorCode);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(errorCode);
  }
  return text;
}

async function responseJson(response: Response, errorCode: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(errorCode);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireBytes(value: Uint8Array, length: number, error: string): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(error);
  }
}

function fail(): never {
  throw new Error("invalid");
}

export function encodeBase64Url(value: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";
  for (let index = 0; index < value.length; index += 3) {
    const first = value[index] ?? 0;
    const second = value[index + 1];
    const third = value[index + 2];
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) {
      encoded += alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    }
    if (third !== undefined) {
      encoded += alphabet[third & 63];
    }
  }
  return encoded;
}

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error("BASE64URL_INVALID");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const decoded = alphabet.indexOf(character);
    if (decoded < 0) {
      throw new Error("BASE64URL_INVALID");
    }
    buffer = (buffer << 6) | decoded;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 255);
    }
  }
  const bytes = Uint8Array.from(output);
  if (encodeBase64Url(bytes) !== value) {
    throw new Error("BASE64URL_INVALID");
  }
  return bytes;
}
