import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, type TlsOptions } from "node:tls";

const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export type EchoTransport = "tcp" | "tls";

export interface EchoServerOptions {
  readonly host: string;
  readonly port: number;
  readonly transport: EchoTransport;
  readonly tls?: Pick<TlsOptions, "cert" | "key">;
  readonly maxRequestBytes?: number;
  readonly requestTimeoutMs?: number;
}

export interface RunningEchoServer {
  readonly host: string;
  readonly port: number;
  readonly transport: EchoTransport;
  close(): Promise<void>;
}

interface EchoRequest {
  readonly nonce: string;
}

export async function startEchoServer(options: EchoServerOptions): Promise<RunningEchoServer> {
  validateOptions(options);
  const sockets = new Set<Socket>();
  const listener = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleEchoConnection(socket, options);
  };
  const server =
    options.transport === "tls"
      ? createTlsServer({ cert: options.tls?.cert, key: options.tls?.key }, listener)
      : createTcpServer(listener);

  await listen(server, options.host, options.port);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("ECHO_LISTENER_ADDRESS_UNAVAILABLE");
  }

  return {
    host: address.address,
    port: address.port,
    transport: options.transport,
    close: () => closeServer(server, sockets),
  };
}

function handleEchoConnection(socket: Socket, options: EchoServerOptions) {
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let buffer = Buffer.alloc(0);
  let responded = false;

  socket.setTimeout(timeoutMs, () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    if (responded) {
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maxRequestBytes) {
      responded = true;
      writeErrorAndClose(socket, "REQUEST_TOO_LARGE");
      return;
    }

    const newline = buffer.indexOf(0x0a);
    if (newline < 0) {
      return;
    }

    const request = parseRequest(buffer.subarray(0, newline));
    if (!request) {
      responded = true;
      writeErrorAndClose(socket, "INVALID_REQUEST");
      return;
    }

    responded = true;
    const response = {
      protocol: "mhub-poc-echo-v1",
      transport: options.transport,
      nonce: request.nonce,
      observed_remote_address: normalizeAddress(socket.remoteAddress),
      observed_remote_port: socket.remotePort ?? null,
      received_at: new Date().toISOString(),
    };
    socket.end(`${JSON.stringify(response)}\n`);
  });
}

function parseRequest(value: Buffer): EchoRequest | null {
  try {
    const parsed: unknown = JSON.parse(value.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !("nonce" in parsed)) {
      return null;
    }
    const nonce = (parsed as { nonce: unknown }).nonce;
    if (typeof nonce !== "string" || nonce.length < 1 || nonce.length > 128) {
      return null;
    }
    return { nonce };
  } catch {
    return null;
  }
}

function writeErrorAndClose(socket: Socket, code: string) {
  socket.end(`${JSON.stringify({ protocol: "mhub-poc-echo-v1", error: code })}\n`);
}

function validateOptions(options: EchoServerOptions) {
  if (!options.host.trim()) {
    throw new Error("ECHO_HOST_REQUIRED");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("ECHO_PORT_INVALID");
  }
  if (options.transport === "tls" && (!options.tls?.cert || !options.tls.key)) {
    throw new Error("ECHO_TLS_CERTIFICATE_REQUIRED");
  }
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

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
