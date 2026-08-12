import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";

export interface SessionTicketClientOptions {
  readonly apiUrl: string;
  readonly credentialId: string;
  /** PKCS#8 Ed25519 private key encoded as unpadded Base64URL. */
  readonly devicePrivateKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface SessionTicket {
  readonly ticket: string;
  readonly expiresAt: string;
}

export class SessionTicketClient {
  private readonly privateKey: ReturnType<typeof createPrivateKey>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly endpoint: URL;

  constructor(private readonly options: SessionTicketClientOptions) {
    this.endpoint = endpoint(options.apiUrl);
    this.privateKey = parsePrivateKey(options.devicePrivateKey);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    if (!/^cpc_[0-9A-HJKMNP-TV-Z]{26}$/.test(options.credentialId)) {
      throw new Error("CREDENTIAL_ID_INVALID");
    }
  }

  async issue(): Promise<SessionTicket> {
    const timestamp = Math.floor(this.now() / 1_000).toString(10);
    const nonce = base64Url(randomBytes(16));
    const body = new Uint8Array();
    const bodyHash = createSha256(body);
    const canonical = [
      "POST",
      this.endpoint.pathname,
      this.endpoint.searchParams.toString(),
      bodyHash,
      this.options.credentialId,
      timestamp,
      nonce,
    ].join("\n");
    const signature = base64Url(sign(null, Buffer.from(canonical, "utf8"), this.privateKey));

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-store",
        "X-Credential-Id": this.options.credentialId,
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Signature": signature,
      },
    });
    if (!response.ok) {
      throw new Error(`SESSION_TICKET_REQUEST_FAILED_${response.status}`);
    }
    const raw: unknown = await response.json();
    if (!isObject(raw) || typeof raw.ticket !== "string" || typeof raw.expires_at !== "string") {
      throw new Error("SESSION_TICKET_RESPONSE_INVALID");
    }
    if (!raw.ticket || !raw.expires_at || raw.ticket.length > 4_096) {
      throw new Error("SESSION_TICKET_RESPONSE_INVALID");
    }
    const expiresAt = Date.parse(raw.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      throw new Error("SESSION_TICKET_RESPONSE_EXPIRED");
    }
    return { ticket: raw.ticket, expiresAt: raw.expires_at };
  }
}

function endpoint(value: string): URL {
  const url = new URL(value);
  if (!(url.protocol === "https:" || url.protocol === "http:") || url.search || url.hash) {
    throw new Error("AGENT_API_URL_INVALID");
  }
  if (!url.pathname.endsWith("/agent-api/v1/session-tickets")) {
    throw new Error("AGENT_API_URL_INVALID");
  }
  return url;
}

function parsePrivateKey(value: string) {
  try {
    const der = decodeBase64Url(value);
    try {
      return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    } finally {
      der.fill(0);
    }
  } catch {
    throw new Error("DEVICE_PRIVATE_KEY_INVALID");
  }
}

function createSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("BASE64URL_INVALID");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    throw new Error("BASE64URL_INVALID");
  }
  return decoded;
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
