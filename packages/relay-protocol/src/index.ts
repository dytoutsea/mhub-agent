import ipaddr from "ipaddr.js";

export type AgentPlatform = "windows" | "macos" | "android" | "ios" | "node";

export interface Hello {
  readonly type: "HELLO";
  readonly protocol_version: 1;
  readonly proxy_id: string;
  readonly ticket: string;
  readonly agent_version: string;
  readonly platform: AgentPlatform;
  readonly capabilities: readonly ["tcp", "ip_egress", "per_stream_wss"];
}

export interface Welcome {
  readonly type: "WELCOME";
  readonly session_id: string;
  readonly heartbeat_interval_ms: number;
  readonly connection_open_timeout_ms: number;
  readonly max_streams: number;
  readonly max_bps: number;
}

export interface OpenRequest {
  readonly type: "OPEN_REQUEST";
  readonly connection_id: string;
  readonly connection_token: string;
  readonly host: string;
  readonly port: number;
  readonly connect_timeout_ms: number;
}

export type RelayMessage = Welcome | OpenRequest | Ping | Pong | ConnectionClosed | GoAway;

export interface Ping {
  readonly type: "PING";
  readonly nonce: string;
}

export interface Pong {
  readonly type: "PONG";
  readonly nonce: string;
}

export interface ConnectionClosed {
  readonly type: "CONNECTION_CLOSED";
  readonly connection_id: string;
  readonly reason: string;
}

export interface GoAway {
  readonly type: "GOAWAY";
  readonly reason: string;
}

export function hello(
  proxyId: string,
  ticket: string,
  platform: AgentPlatform = "node",
  agentVersion = "0.1.0",
): Hello {
  boundedText(proxyId, "PROXY_ID", 128);
  boundedText(ticket, "TICKET", 4_096);
  boundedText(agentVersion, "AGENT_VERSION", 64);
  return {
    type: "HELLO",
    protocol_version: 1,
    proxy_id: proxyId,
    ticket,
    agent_version: agentVersion,
    platform,
    capabilities: ["tcp", "ip_egress", "per_stream_wss"],
  };
}

export function parseRelayMessage(value: string): RelayMessage {
  const message = parseObject(value);
  const type = text(message, "type", 64);
  if (type === "WELCOME") {
    requireFields(message, [
      "type",
      "session_id",
      "heartbeat_interval_ms",
      "connection_open_timeout_ms",
      "max_streams",
      "max_bps",
    ]);
    return {
      type,
      session_id: text(message, "session_id", 128),
      heartbeat_interval_ms: integer(message, "heartbeat_interval_ms", 1_000, 300_000),
      connection_open_timeout_ms: integer(message, "connection_open_timeout_ms", 1_000, 30_000),
      max_streams: integer(message, "max_streams", 1, 256),
      max_bps: integer(message, "max_bps", 1, Number.MAX_SAFE_INTEGER),
    };
  }
  if (type === "OPEN_REQUEST") {
    requireFields(message, [
      "type",
      "connection_id",
      "connection_token",
      "host",
      "port",
      "connect_timeout_ms",
    ]);
    const host = text(message, "host", 255);
    if (!isIpLiteral(host)) {
      throw new Error("RELAY_HOST_INVALID");
    }
    return {
      type,
      connection_id: text(message, "connection_id", 128),
      connection_token: text(message, "connection_token", 256, 32),
      host,
      port: integer(message, "port", 1, 65_535),
      connect_timeout_ms: integer(message, "connect_timeout_ms", 1_000, 30_000),
    };
  }
  if (type === "PING") {
    requireFields(message, ["type", "nonce"]);
    return { type, nonce: text(message, "nonce", 128) };
  }
  if (type === "PONG") {
    requireFields(message, ["type", "nonce"]);
    return { type, nonce: text(message, "nonce", 128) };
  }
  if (type === "CONNECTION_CLOSED") {
    requireFields(message, ["type", "connection_id", "reason"]);
    return {
      type,
      connection_id: text(message, "connection_id", 128),
      reason: text(message, "reason", 64),
    };
  }
  if (type === "GOAWAY") {
    requireFields(message, ["type", "reason"]);
    return { type, reason: text(message, "reason", 64) };
  }
  throw new Error("UNSUPPORTED_RELAY_MESSAGE");
}

export function parseDataAccepted(value: string, connectionId: string): void {
  const message = parseObject(value);
  requireFields(message, ["type", "connection_id"]);
  if (
    text(message, "type", 64) !== "DATA_ACCEPTED" ||
    text(message, "connection_id", 128) !== connectionId
  ) {
    throw new Error("DATA_PAIRING_REJECTED");
  }
}

function parseObject(value: string): Record<string, unknown> {
  if (value.length > 64 * 1024) {
    throw new Error("RELAY_MESSAGE_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("RELAY_MESSAGE_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RELAY_MESSAGE_INVALID");
  }
  return parsed as Record<string, unknown>;
}

function text(
  message: Record<string, unknown>,
  name: string,
  maximum: number,
  minimum = 1,
): string {
  const value = message[name];
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`RELAY_${name.toUpperCase()}_INVALID`);
  }
  return value;
}

function boundedText(value: string, name: string, maximum: number): void {
  if (value.length < 1 || value.length > maximum) {
    throw new Error(`RELAY_${name}_INVALID`);
  }
}

function integer(
  message: Record<string, unknown>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = message[name];
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`RELAY_${name.toUpperCase()}_INVALID`);
  }
  return value as number;
}

function requireFields(message: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(message).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((value, index) => value !== sortedExpected[index])
  ) {
    throw new Error("RELAY_UNEXPECTED_FIELDS");
  }
}

function isIpLiteral(value: string): boolean {
  if (value.includes("%") || !ipaddr.isValid(value)) {
    return false;
  }
  const address = ipaddr.parse(value);
  if (address.kind() === "ipv4") {
    const octets = value.split(".");
    return (
      octets.length === 4 &&
      octets.every((octet) => /^(0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255)
    );
  }
  return value.includes(":");
}
