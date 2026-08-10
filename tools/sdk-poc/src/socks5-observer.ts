import { createHash, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createConnection, createServer, isIP, type Server, type Socket } from "node:net";
import { TextDecoder } from "node:util";
import ipaddr from "ipaddr.js";

import { SocketReader } from "./socket-reader.js";

const SOCKS_VERSION = 0x05;
const USERNAME_PASSWORD_METHOD = 0x02;
const NO_ACCEPTABLE_METHOD = 0xff;
const CONNECT_COMMAND = 0x01;
const REPLY_SUCCEEDED = 0x00;
const REPLY_NOT_ALLOWED = 0x02;
const REPLY_HOST_UNREACHABLE = 0x04;
const REPLY_COMMAND_UNSUPPORTED = 0x07;
const REPLY_ADDRESS_UNSUPPORTED = 0x08;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type SocksAddressType = "domain" | "ipv4" | "ipv6";

export interface SocksObservation {
  readonly phase: "request" | "connected" | "rejected" | "injected_disconnect";
  readonly observedAt: string;
  readonly clientAddress: string | null;
  readonly authentication: "username_password";
  readonly addressType?: SocksAddressType;
  readonly destinationHost?: string;
  readonly destinationPort?: number;
  readonly resolvedAddress?: string;
  readonly errorCode?: string;
}

export interface Socks5ObserverOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly allowNonLoopbackBind?: boolean;
  readonly allowPrivateTargets?: boolean;
  readonly connectTimeoutMs?: number;
  readonly dropAfterMs?: number;
  readonly onObservation?: (observation: SocksObservation) => void;
}

export interface RunningSocks5Observer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

interface SocksRequest {
  readonly addressType: SocksAddressType;
  readonly destinationHost: string;
  readonly destinationPort: number;
}

class SocksFailure extends Error {
  constructor(
    readonly replyCode: number,
    readonly eventCode: string,
  ) {
    super(eventCode);
  }
}

export async function startSocks5Observer(
  options: Socks5ObserverOptions,
): Promise<RunningSocks5Observer> {
  validateOptions(options);
  const clients = new Set<Socket>();
  const server = createServer((client) => {
    clients.add(client);
    client.once("close", () => clients.delete(client));
    void handleClient(client, options);
  });

  await listen(server, options.host, options.port);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("SOCKS_LISTENER_ADDRESS_UNAVAILABLE");
  }

  return {
    host: address.address,
    port: address.port,
    close: () => closeServer(server, clients),
  };
}

async function handleClient(client: Socket, options: Socks5ObserverOptions) {
  const reader = new SocketReader(client);
  let request: SocksRequest | null = null;
  let authenticated = false;
  try {
    client.setNoDelay(true);
    client.setTimeout(options.connectTimeoutMs ?? 5_000, () => client.destroy());
    await negotiateAuthentication(client, reader, options.username, options.password);
    authenticated = true;
    request = await readConnectRequest(reader);
    observe(options, client, request, { phase: "request" });
    client.pause();
    const bufferedApplicationBytes = reader.detach();

    const resolvedAddresses = await resolveTarget(
      request.destinationHost,
      options.allowPrivateTargets ?? false,
    );
    const upstream = await connectTarget(
      resolvedAddresses,
      request.destinationPort,
      options.connectTimeoutMs ?? 5_000,
    );
    const resolvedAddress = normalizeAddress(upstream.remoteAddress) ?? resolvedAddresses[0] ?? "";

    client.setTimeout(0);
    client.write(successReply());
    if (bufferedApplicationBytes.length > 0) {
      upstream.write(bufferedApplicationBytes);
    }
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
    observe(options, client, request, { phase: "connected", resolvedAddress });

    if (options.dropAfterMs && options.dropAfterMs > 0) {
      const timer = setTimeout(() => {
        observe(options, client, request, { phase: "injected_disconnect" });
        upstream.destroy();
        client.destroy();
      }, options.dropAfterMs);
      timer.unref();
      client.once("close", () => clearTimeout(timer));
    }

    upstream.once("error", () => client.destroy());
    client.once("error", () => upstream.destroy());
  } catch (error) {
    const failure =
      error instanceof SocksFailure ? error : new SocksFailure(0x01, "PROTOCOL_ERROR");
    if (authenticated) {
      client.write(failureReply(failure.replyCode));
    }
    observe(options, client, request, { phase: "rejected", errorCode: failure.eventCode });
    client.end();
  }
}

async function negotiateAuthentication(
  client: Socket,
  reader: SocketReader,
  expectedUsername: string,
  expectedPassword: string,
) {
  const greeting = await reader.readExactly(2);
  const greetingVersion = greeting.readUInt8(0);
  const methodCount = greeting.readUInt8(1);
  if (greetingVersion !== SOCKS_VERSION || methodCount === 0 || methodCount > 16) {
    throw new SocksFailure(0x01, "INVALID_GREETING");
  }
  const methods = await reader.readExactly(methodCount);
  if (!methods.includes(USERNAME_PASSWORD_METHOD)) {
    client.write(Buffer.from([SOCKS_VERSION, NO_ACCEPTABLE_METHOD]));
    throw new SocksFailure(0x01, "USERNAME_PASSWORD_REQUIRED");
  }
  client.write(Buffer.from([SOCKS_VERSION, USERNAME_PASSWORD_METHOD]));

  const authHeader = await reader.readExactly(2);
  const authVersion = authHeader.readUInt8(0);
  const usernameLength = authHeader.readUInt8(1);
  if (authVersion !== 0x01 || usernameLength === 0) {
    client.write(Buffer.from([0x01, 0x01]));
    throw new SocksFailure(0x01, "AUTHENTICATION_FAILED");
  }
  const username = await reader.readExactly(usernameLength);
  const passwordLength = (await reader.readExactly(1)).readUInt8(0);
  if (passwordLength === 0) {
    client.write(Buffer.from([0x01, 0x01]));
    throw new SocksFailure(0x01, "AUTHENTICATION_FAILED");
  }
  const password = await reader.readExactly(passwordLength);
  const authenticated =
    secureEquals(username, Buffer.from(expectedUsername, "utf8")) &&
    secureEquals(password, Buffer.from(expectedPassword, "utf8"));
  client.write(Buffer.from([0x01, authenticated ? 0x00 : 0x01]));
  if (!authenticated) {
    throw new SocksFailure(0x01, "AUTHENTICATION_FAILED");
  }
}

async function readConnectRequest(reader: SocketReader): Promise<SocksRequest> {
  const header = await reader.readExactly(4);
  if (header.readUInt8(0) !== SOCKS_VERSION || header.readUInt8(2) !== 0x00) {
    throw new SocksFailure(0x01, "INVALID_REQUEST");
  }
  if (header.readUInt8(1) !== CONNECT_COMMAND) {
    throw new SocksFailure(REPLY_COMMAND_UNSUPPORTED, "COMMAND_UNSUPPORTED");
  }

  const address = await readAddress(reader, header.readUInt8(3));
  const portBytes = await reader.readExactly(2);
  const destinationPort = portBytes.readUInt16BE(0);
  if (destinationPort === 0) {
    throw new SocksFailure(REPLY_NOT_ALLOWED, "DESTINATION_PORT_INVALID");
  }
  return { ...address, destinationPort };
}

async function readAddress(
  reader: SocketReader,
  addressCode: number,
): Promise<Pick<SocksRequest, "addressType" | "destinationHost">> {
  if (addressCode === 0x01) {
    const address = await reader.readExactly(4);
    return { addressType: "ipv4", destinationHost: [...address].join(".") };
  }
  if (addressCode === 0x03) {
    const length = (await reader.readExactly(1)).readUInt8(0);
    if (length === 0) {
      throw new SocksFailure(REPLY_ADDRESS_UNSUPPORTED, "DOMAIN_INVALID");
    }
    try {
      const destinationHost = UTF8.decode(await reader.readExactly(length));
      if (!destinationHost.trim() || destinationHost !== destinationHost.trim()) {
        throw new Error("invalid domain");
      }
      return { addressType: "domain", destinationHost };
    } catch {
      throw new SocksFailure(REPLY_ADDRESS_UNSUPPORTED, "DOMAIN_INVALID");
    }
  }
  if (addressCode === 0x04) {
    const address = ipaddr.fromByteArray([...(await reader.readExactly(16))]);
    return { addressType: "ipv6", destinationHost: address.toNormalizedString() };
  }
  throw new SocksFailure(REPLY_ADDRESS_UNSUPPORTED, "ADDRESS_TYPE_UNSUPPORTED");
}

async function resolveTarget(host: string, allowPrivateTargets: boolean): Promise<string[]> {
  const results = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new SocksFailure(REPLY_HOST_UNREACHABLE, "DNS_RESOLUTION_FAILED");
      });
  if (results.length === 0) {
    throw new SocksFailure(REPLY_HOST_UNREACHABLE, "DNS_RESOLUTION_EMPTY");
  }
  if (!allowPrivateTargets && results.some((result) => !isPublicAddress(result.address))) {
    throw new SocksFailure(REPLY_NOT_ALLOWED, "PRIVATE_TARGET_BLOCKED");
  }
  return results.map((result) => result.address);
}

function isPublicAddress(address: string): boolean {
  let parsed = ipaddr.parse(address);
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  return parsed.range() === "unicast";
}

async function connectTarget(hosts: string[], port: number, timeoutMs: number): Promise<Socket> {
  for (const host of hosts) {
    try {
      return await connectOneTarget(host, port, timeoutMs);
    } catch {
      // Try the next validated DNS result.
    }
  }
  throw new SocksFailure(REPLY_HOST_UNREACHABLE, "TARGET_CONNECT_FAILED");
}

function connectOneTarget(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("target timeout"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("target connection failed"));
    });
  });
}

function observe(
  options: Socks5ObserverOptions,
  client: Socket,
  request: SocksRequest | null,
  event:
    | { readonly phase: "request" | "injected_disconnect" }
    | { readonly phase: "connected"; readonly resolvedAddress: string }
    | { readonly phase: "rejected"; readonly errorCode: string },
) {
  const base = {
    phase: event.phase,
    observedAt: new Date().toISOString(),
    clientAddress: normalizeAddress(client.remoteAddress),
    authentication: "username_password" as const,
  };
  const target = request
    ? {
        addressType: request.addressType,
        destinationHost: request.destinationHost,
        destinationPort: request.destinationPort,
      }
    : {};
  const detail =
    event.phase === "connected"
      ? { resolvedAddress: event.resolvedAddress }
      : event.phase === "rejected"
        ? { errorCode: event.errorCode }
        : {};
  try {
    options.onObservation?.({ ...base, ...target, ...detail });
  } catch {
    // Evidence sinks must not affect proxy behavior.
  }
}

function secureEquals(actual: Buffer, expected: Buffer): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function successReply(): Buffer {
  return Buffer.from([SOCKS_VERSION, REPLY_SUCCEEDED, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

function failureReply(code: number): Buffer {
  return Buffer.from([SOCKS_VERSION, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

function validateOptions(options: Socks5ObserverOptions) {
  if (!options.host.trim()) {
    throw new Error("SOCKS_HOST_REQUIRED");
  }
  if (!isLoopbackHost(options.host) && !options.allowNonLoopbackBind) {
    throw new Error("SOCKS_NON_LOOPBACK_BIND_REQUIRES_EXPLICIT_ACK");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("SOCKS_PORT_INVALID");
  }
  for (const [name, value] of [
    ["username", options.username],
    ["password", options.password],
  ] as const) {
    const length = Buffer.byteLength(value, "utf8");
    if (length < 1 || length > 255) {
      throw new Error(`SOCKS_${name.toUpperCase()}_INVALID`);
    }
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function normalizeAddress(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server, clients: Set<Socket>): Promise<void> {
  for (const client of clients) {
    client.destroy();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
