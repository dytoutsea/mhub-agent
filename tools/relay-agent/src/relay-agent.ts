import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import WebSocket, { type RawData } from "ws";

import { isAllowedTargetIp, sameIp } from "./address-policy.js";
import { hello, type OpenRequest, parseDataAccepted, parseRelayMessage } from "./protocol.js";
import type { SessionTicketClient } from "./session-ticket-client.js";

const HIGH_WATER_MARK = 256 * 1024;
const LOW_WATER_MARK = 64 * 1024;
const HARD_BUFFER_LIMIT = 1024 * 1024;

export interface RelayAgentOptions {
  readonly controlUrl: string;
  readonly proxyId: string;
  readonly ticket?: string | undefined;
  readonly sessionTicketClient?: SessionTicketClient | undefined;
  readonly allowPrivateTargets?: boolean;
  readonly onEvent?: (event: RelayAgentEvent) => void;
}

export interface RelayAgentEvent {
  readonly type: "online" | "stream_opened" | "stream_closed" | "stopped";
  readonly connectionId?: string;
}

export class RelayAgent {
  private control: WebSocket | null = null;
  private readonly streams = new Map<string, AgentStream>();
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;

  constructor(private readonly options: RelayAgentOptions) {
    validateOptions(options);
  }

  async start(): Promise<void> {
    if (this.control || this.reconnectTimer) {
      throw new Error("AGENT_ALREADY_STARTED");
    }
    this.stopping = false;
    await this.connectControl();
  }

  private async connectControl(): Promise<void> {
    if (this.stopping) {
      return;
    }
    const control = new WebSocket(this.options.controlUrl, { maxPayload: 64 * 1024 });
    this.control = control;
    try {
      await waitForOpen(control, 10_000);
      const ticket = this.options.sessionTicketClient
        ? (await this.options.sessionTicketClient.issue()).ticket
        : this.options.ticket;
      if (!ticket) {
        throw new Error("AGENT_CREDENTIALS_REQUIRED");
      }
      control.send(JSON.stringify(hello(this.options.proxyId, ticket)));
    } catch (error) {
      this.control = null;
      control.terminate();
      throw error;
    }
    control.on("message", (data, isBinary) => {
      if (isBinary) {
        this.failControl("BINARY_CONTROL_MESSAGE");
        return;
      }
      this.handleControl(data.toString());
    });
    control.on("close", () => this.handleDisconnect(control));
    control.on("error", () => this.handleDisconnect(control));
    this.reconnectAttempt = 0;
  }

  private handleDisconnect(control: WebSocket) {
    if (this.control !== control) {
      return;
    }
    this.control = null;
    this.clearHeartbeat();
    this.stopStreams();
    if (this.stopping || !this.options.sessionTicketClient || this.reconnectTimer) {
      return;
    }
    const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectControl().catch(() => this.handleReconnectFailure());
    }, delay);
  }

  private handleReconnectFailure() {
    if (this.stopping || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectControl().catch(() => this.handleReconnectFailure());
    }, 1_000);
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopStreams();
    const control = this.control;
    this.control = null;
    if (control && control.readyState === WebSocket.OPEN) {
      await closeWebSocket(control);
    } else if (control) {
      control.terminate();
    }
    this.options.onEvent?.({ type: "stopped" });
  }

  private handleControl(raw: string) {
    try {
      const message = parseRelayMessage(raw);
      switch (message.type) {
        case "WELCOME":
          this.startHeartbeat(message.heartbeat_interval_ms);
          this.options.onEvent?.({ type: "online" });
          return;
        case "PING":
          this.sendControl({ type: "PONG", nonce: message.nonce });
          return;
        case "PONG":
          return;
        case "OPEN_REQUEST":
          void this.openStream(message);
          return;
        case "CONNECTION_CLOSED":
          this.streams.get(message.connection_id)?.close(false);
          return;
        case "GOAWAY":
          void this.stop();
          return;
      }
    } catch {
      this.failControl("INVALID_CONTROL_MESSAGE");
    }
  }

  private async openStream(request: OpenRequest) {
    if (this.streams.has(request.connection_id)) {
      this.sendControl({
        type: "OPEN_FAILED",
        connection_id: request.connection_id,
        reason: "DUPLICATE_CONNECTION",
      });
      return;
    }
    if (!isAllowedTargetIp(request.host, this.options.allowPrivateTargets ?? false)) {
      this.sendControl({
        type: "OPEN_FAILED",
        connection_id: request.connection_id,
        reason: "TARGET_IP_BLOCKED",
      });
      return;
    }
    const stream = new AgentStream(
      request,
      dataUrl(this.options.controlUrl, request.connection_id),
      (message) => this.sendControl(message),
      () => {
        this.streams.delete(request.connection_id);
        this.options.onEvent?.({ type: "stream_closed", connectionId: request.connection_id });
      },
      this.options.allowPrivateTargets ?? false,
    );
    this.streams.set(request.connection_id, stream);
    try {
      await stream.open();
      this.options.onEvent?.({ type: "stream_opened", connectionId: request.connection_id });
    } catch (error) {
      this.streams.delete(request.connection_id);
      stream.close(false);
      this.sendControl({
        type: "OPEN_FAILED",
        connection_id: request.connection_id,
        reason: stableOpenFailure(error),
      });
    }
  }

  private sendControl(message: object) {
    if (this.control?.readyState === WebSocket.OPEN) {
      this.control.send(JSON.stringify(message));
    }
  }

  private startHeartbeat(intervalMillis: number) {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendControl({ type: "PING", nonce: randomUUID() });
    }, intervalMillis);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private failControl(_reason: string) {
    this.control?.close(1002, "PROTOCOL_ERROR");
    this.stopStreams();
  }

  private stopStreams() {
    for (const stream of this.streams.values()) {
      stream.close(false);
    }
    this.streams.clear();
  }
}

class AgentStream {
  private target: Socket | null = null;
  private data: WebSocket | null = null;
  private closed = false;
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly request: OpenRequest,
    private readonly url: string,
    private readonly sendControl: (message: object) => void,
    private readonly onClosed: () => void,
    private readonly allowPrivateTargets: boolean,
  ) {}

  async open() {
    const target = await connectTarget(this.request);
    if (
      !sameIp(target.remoteAddress, this.request.host) ||
      !isAllowedTargetIp(target.remoteAddress ?? "", this.allowPrivateTargets)
    ) {
      target.destroy();
      throw new Error("TARGET_PEER_MISMATCH");
    }
    target.pause();
    this.target = target;

    const data = new WebSocket(this.url, { maxPayload: HARD_BUFFER_LIMIT });
    this.data = data;
    await waitForOpen(data, this.request.connect_timeout_ms);
    data.send(
      JSON.stringify({
        type: "DATA_HELLO",
        connection_id: this.request.connection_id,
        connection_token: this.request.connection_token,
      }),
    );
    await waitForDataAccepted(data, this.request.connection_id, this.request.connect_timeout_ms);
    this.installForwarding(target, data);
    this.sendControl({ type: "OPEN_READY", connection_id: this.request.connection_id });
    target.resume();
  }

  close(notifyRelay: boolean) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
    }
    this.target?.destroy();
    if (this.data?.readyState === WebSocket.OPEN) {
      this.data.close(1000, "STREAM_CLOSED");
    } else {
      this.data?.terminate();
    }
    if (notifyRelay) {
      this.sendControl({
        type: "CONNECTION_CLOSED",
        connection_id: this.request.connection_id,
        reason: "TARGET_CLOSED",
      });
    }
    this.onClosed();
  }

  private installForwarding(target: Socket, data: WebSocket) {
    target.on("data", (chunk: Buffer) => {
      if (data.readyState !== WebSocket.OPEN) {
        this.close(true);
        return;
      }
      if (data.bufferedAmount + chunk.length > HARD_BUFFER_LIMIT) {
        this.close(true);
        return;
      }
      data.send(chunk, { binary: true });
      if (data.bufferedAmount > HIGH_WATER_MARK) {
        target.pause();
        this.waitForWebSocketDrain(target, data);
      }
    });
    target.once("close", () => this.close(true));
    target.once("error", () => this.close(true));
    data.on("message", (raw: RawData, isBinary: boolean) => {
      if (!isBinary) {
        this.close(true);
        return;
      }
      const bytes = toBuffer(raw);
      if (!target.write(bytes)) {
        data.pause();
      }
    });
    target.on("drain", () => data.resume());
    data.once("close", () => this.close(false));
    data.once("error", () => this.close(false));
  }

  private waitForWebSocketDrain(target: Socket, data: WebSocket) {
    const check = () => {
      if (this.closed || data.readyState !== WebSocket.OPEN) {
        return;
      }
      if (data.bufferedAmount <= LOW_WATER_MARK) {
        this.drainTimer = null;
        target.resume();
        return;
      }
      this.drainTimer = setTimeout(check, 10);
    };
    this.drainTimer = setTimeout(check, 10);
  }
}

function connectTarget(request: OpenRequest): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: request.host, port: request.port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("TARGET_CONNECT_TIMEOUT"));
    }, request.connect_timeout_ms);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("TARGET_CONNECT_FAILED"));
    });
  });
}

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("WEBSOCKET_OPEN_TIMEOUT")), timeoutMs);
    const onOpen = () => finish();
    const onError = () => finish(new Error("WEBSOCKET_OPEN_FAILED"));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
      error ? reject(error) : resolve();
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function waitForDataAccepted(socket: WebSocket, connectionId: string, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("DATA_PAIRING_TIMEOUT")), timeoutMs);
    const onMessage = (raw: RawData, isBinary: boolean) => {
      try {
        if (isBinary) {
          throw new Error("DATA_PAIRING_INVALID");
        }
        parseDataAccepted(raw.toString(), connectionId);
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("DATA_PAIRING_INVALID"));
      }
    };
    const onClose = () => finish(new Error("DATA_PAIRING_CLOSED"));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      error ? reject(error) : resolve();
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

function closeWebSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 1_000);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.close(1000, "AGENT_STOPPED");
  });
}

function dataUrl(controlUrl: string, connectionId: string): string {
  const url = new URL(controlUrl);
  url.pathname = `/agent/v1/data/${encodeURIComponent(connectionId)}`;
  url.search = "";
  return url.toString();
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw);
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw);
  }
  throw new Error("DATA_FRAME_INVALID");
}

function stableOpenFailure(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) {
    return error.message;
  }
  return "TARGET_CONNECT_FAILED";
}

function validateOptions(options: RelayAgentOptions) {
  const url = new URL(options.controlUrl);
  if (
    !(["ws:", "wss:"] as string[]).includes(url.protocol) ||
    url.pathname !== "/agent/v1/control"
  ) {
    throw new Error("CONTROL_URL_INVALID");
  }
  if (!options.proxyId.trim() || (!options.ticket && !options.sessionTicketClient)) {
    throw new Error("AGENT_CREDENTIALS_REQUIRED");
  }
}
