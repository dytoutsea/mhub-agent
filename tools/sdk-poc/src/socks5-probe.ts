import { randomUUID } from "node:crypto";
import { createConnection, isIP, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import ipaddr from "ipaddr.js";

import { SocketReader } from "./socket-reader.js";

export interface Socks5ProbeOptions {
  readonly proxyHost: string;
  readonly proxyPort: number;
  readonly username: string;
  readonly password: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly addressType: "domain" | "ip";
  readonly transport?: "tcp" | "tls";
  readonly tlsCa?: Buffer;
  readonly timeoutMs?: number;
}

export interface Socks5ProbeResult {
  readonly addressType: "domain" | "ipv4" | "ipv6";
  readonly targetHost: string;
  readonly targetPort: number;
  readonly echo: {
    readonly protocol: string;
    readonly transport: string;
    readonly nonce: string;
    readonly observed_remote_address: string | null;
    readonly observed_remote_port: number | null;
  };
}

export async function runSocks5EchoProbe(options: Socks5ProbeOptions): Promise<Socks5ProbeResult> {
  const socket = await openSocks5Tunnel(options);
  const transport = options.transport ?? "tcp";
  const connection =
    transport === "tls"
      ? await upgradeToTls(socket, options.targetHost, options.tlsCa, options.timeoutMs ?? 5_000)
      : socket;
  const nonce = randomUUID();
  connection.write(`${JSON.stringify({ nonce })}\n`);
  const response = await readJsonLine(connection, options.timeoutMs ?? 5_000);
  connection.end();
  const echo = parseEchoResponse(response, nonce, transport);

  return {
    addressType: socksAddressType(options),
    targetHost: options.targetHost,
    targetPort: options.targetPort,
    echo,
  };
}

export async function openSocks5Tunnel(options: Socks5ProbeOptions): Promise<Socket> {
  validateOptions(options);
  const socket = await connectSocket(
    options.proxyHost,
    options.proxyPort,
    options.timeoutMs ?? 5_000,
  );
  const reader = new SocketReader(socket);
  socket.write(Buffer.from([0x05, 0x01, 0x02]));
  const method = await reader.readExactly(2);
  if (method[0] !== 0x05 || method[1] !== 0x02) {
    socket.destroy();
    throw new Error("SOCKS_AUTH_METHOD_REJECTED");
  }

  const username = Buffer.from(options.username, "utf8");
  const password = Buffer.from(options.password, "utf8");
  socket.write(
    Buffer.concat([
      Buffer.from([0x01, username.length]),
      username,
      Buffer.from([password.length]),
      password,
    ]),
  );
  const auth = await reader.readExactly(2);
  if (auth[0] !== 0x01 || auth[1] !== 0x00) {
    socket.destroy();
    throw new Error("SOCKS_AUTHENTICATION_FAILED");
  }

  socket.write(connectRequest(options));
  const reply = await reader.readExactly(4);
  if (reply.readUInt8(0) !== 0x05 || reply.readUInt8(2) !== 0x00) {
    socket.destroy();
    throw new Error("SOCKS_RESPONSE_INVALID");
  }
  await consumeReplyAddress(reader, reply.readUInt8(3));
  await reader.readExactly(2);
  const replyCode = reply.readUInt8(1);
  if (replyCode !== 0x00) {
    socket.destroy();
    throw new Error(`SOCKS_CONNECT_FAILED_${replyCode}`);
  }
  const buffered = reader.detach();
  if (buffered.length > 0) {
    socket.unshift(buffered);
  }
  socket.setTimeout(0);
  return socket;
}

function connectRequest(options: Socks5ProbeOptions): Buffer {
  const port = Buffer.alloc(2);
  port.writeUInt16BE(options.targetPort);
  if (options.addressType === "domain") {
    const domain = Buffer.from(options.targetHost, "utf8");
    if (domain.length < 1 || domain.length > 255) {
      throw new Error("SOCKS_TARGET_DOMAIN_INVALID");
    }
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]), domain, port]);
  }

  const parsed = ipaddr.parse(options.targetHost);
  const bytes = Buffer.from(parsed.toByteArray());
  const addressCode = parsed.kind() === "ipv4" ? 0x01 : 0x04;
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, addressCode]), bytes, port]);
}

async function consumeReplyAddress(reader: SocketReader, addressCode: number) {
  if (addressCode === 0x01) {
    await reader.readExactly(4);
    return;
  }
  if (addressCode === 0x03) {
    const length = (await reader.readExactly(1)).readUInt8(0);
    await reader.readExactly(length);
    return;
  }
  if (addressCode === 0x04) {
    await reader.readExactly(16);
    return;
  }
  throw new Error("SOCKS_RESPONSE_ADDRESS_INVALID");
}

function socksAddressType(options: Socks5ProbeOptions): "domain" | "ipv4" | "ipv6" {
  if (options.addressType === "domain") {
    return "domain";
  }
  return isIP(options.targetHost) === 4 ? "ipv4" : "ipv6";
}

function connectSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("PROXY_CONNECT_TIMEOUT"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("PROXY_CONNECT_FAILED"));
    });
  });
}

function upgradeToTls(
  socket: Socket,
  targetHost: string,
  ca: Buffer | undefined,
  timeoutMs: number,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = connectTls({
      socket,
      servername: isIP(targetHost) ? undefined : targetHost,
      ca,
      rejectUnauthorized: true,
    });
    const timeout = setTimeout(() => {
      tlsSocket.destroy();
      reject(new Error("TLS_CONNECT_TIMEOUT"));
    }, timeoutMs);
    tlsSocket.once("secureConnect", () => {
      clearTimeout(timeout);
      resolve(tlsSocket);
    });
    tlsSocket.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("TLS_CONNECT_FAILED"));
    });
  });
}

function readJsonLine(socket: Socket | TLSSocket, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => finish(new Error("ECHO_RESPONSE_TIMEOUT")), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 8 * 1024) {
        finish(new Error("ECHO_RESPONSE_TOO_LARGE"));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      try {
        const parsed: unknown = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        finish(null, parsed);
      } catch {
        finish(new Error("ECHO_RESPONSE_INVALID"));
      }
    };
    const onClose = () => finish(new Error("ECHO_CONNECTION_CLOSED"));
    const onError = () => finish(new Error("ECHO_CONNECTION_ERROR"));
    const finish = (error: Error | null, value?: unknown) => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function parseEchoResponse(
  value: unknown,
  nonce: string,
  transport: "tcp" | "tls",
): Socks5ProbeResult["echo"] {
  if (!value || typeof value !== "object") {
    throw new Error("ECHO_RESPONSE_INVALID");
  }
  const response = value as Record<string, unknown>;
  const protocol = response.protocol;
  const responseTransport = response.transport;
  const responseNonce = response.nonce;
  const observedRemoteAddress = response.observed_remote_address;
  const observedRemotePort = response.observed_remote_port;
  if (
    protocol !== "mhub-poc-echo-v1" ||
    typeof responseTransport !== "string" ||
    responseTransport !== transport ||
    typeof responseNonce !== "string" ||
    responseNonce !== nonce ||
    (observedRemoteAddress !== null && typeof observedRemoteAddress !== "string") ||
    (observedRemotePort !== null && typeof observedRemotePort !== "number")
  ) {
    throw new Error("ECHO_RESPONSE_INVALID");
  }
  return {
    protocol,
    transport: responseTransport,
    nonce: responseNonce,
    observed_remote_address: observedRemoteAddress,
    observed_remote_port: observedRemotePort,
  };
}

function validateOptions(options: Socks5ProbeOptions) {
  for (const port of [options.proxyPort, options.targetPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("PROBE_PORT_INVALID");
    }
  }
  for (const value of [options.username, options.password]) {
    const length = Buffer.byteLength(value, "utf8");
    if (length < 1 || length > 255) {
      throw new Error("PROBE_CREDENTIAL_INVALID");
    }
  }
  if (options.addressType === "ip" && isIP(options.targetHost) === 0) {
    throw new Error("PROBE_IP_TARGET_REQUIRED");
  }
}
