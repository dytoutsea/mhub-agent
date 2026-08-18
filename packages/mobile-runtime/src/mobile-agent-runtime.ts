import type {
  EventSubscription,
  MobileDataTunnel,
  MobileStreamClosedEvent,
  MobileStreamOpenResult,
} from "@mhub/mobile-data-tunnel";
import { hello, type OpenRequest, parseRelayMessage } from "@mhub/relay-protocol";

const CONTROL_OPEN_TIMEOUT_MS = 10_000;
const NORMAL_CLOSE = 1_000;
const PROTOCOL_ERROR_CLOSE = 1_002;

export type MobileRuntimeState = "stopped" | "connecting" | "online" | "backoff";

export interface MobileRuntimeSnapshot {
  readonly state: MobileRuntimeState;
  readonly proxyId: string;
  readonly activeStreams: number;
  readonly connectedAt: string | null;
  readonly errorCode: string | null;
}

export interface SessionTicketProvider {
  issue(): Promise<{ readonly ticket: string }>;
}

export interface ControlSocketEventMap {
  readonly open: object;
  readonly message: { readonly data: unknown };
  readonly close: object;
  readonly error: object;
}

export interface ControlSocket {
  readonly readyState: number;
  send(value: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<EventName extends keyof ControlSocketEventMap>(
    eventName: EventName,
    listener: (event: ControlSocketEventMap[EventName]) => void,
  ): void;
  removeEventListener<EventName extends keyof ControlSocketEventMap>(
    eventName: EventName,
    listener: (event: ControlSocketEventMap[EventName]) => void,
  ): void;
}

export interface MobileAgentRuntimeOptions {
  readonly controlUrl: string;
  readonly allowInsecureDevelopmentEndpoints?: boolean;
  readonly proxyId: string;
  readonly platform: "android" | "ios";
  readonly ticketProvider: SessionTicketProvider;
  readonly tunnel: MobileDataTunnel;
  readonly createSocket?: (url: string) => ControlSocket;
  readonly now?: () => number;
  readonly reconnectDelaysMs?: readonly number[];
  readonly onSnapshot?: (snapshot: MobileRuntimeSnapshot) => void;
}

interface StreamReservation {
  cancelled: boolean;
  ready: boolean;
}

export class MobileAgentRuntime {
  private readonly createSocket: (url: string) => ControlSocket;
  private readonly now: () => number;
  private readonly reconnectDelays: readonly number[];
  private readonly streams = new Map<string, StreamReservation>();
  private socket: ControlSocket | null = null;
  private streamClosedSubscription: EventSubscription | null = null;
  private desiredRunning = false;
  private generation = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatNonce = 0;
  private messageQueue = Promise.resolve();
  private tunnelLifecycleQueue = Promise.resolve();
  private snapshot: MobileRuntimeSnapshot;

  constructor(private readonly options: MobileAgentRuntimeOptions) {
    validateOptions(options);
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.now = options.now ?? Date.now;
    this.reconnectDelays = options.reconnectDelaysMs ?? [
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
    ];
    this.snapshot = Object.freeze({
      state: "stopped",
      proxyId: options.proxyId,
      activeStreams: 0,
      connectedAt: null,
      errorCode: null,
    });
  }

  getSnapshot(): MobileRuntimeSnapshot {
    return this.snapshot;
  }

  async start(): Promise<void> {
    if (this.desiredRunning) {
      throw new Error("MOBILE_AGENT_ALREADY_STARTED");
    }
    this.desiredRunning = true;
    this.reconnectAttempt = 0;
    this.streamClosedSubscription = this.options.tunnel.addListener("onStreamClosed", (event) =>
      this.handleNativeStreamClosed(event),
    );
    await this.connect();
  }

  async stop(
    reason: "USER_REQUESTED" | "MOBILE_APP_BACKGROUND" | "APP_CONTEXT_DESTROYED" = "USER_REQUESTED",
  ) {
    if (!this.desiredRunning && this.snapshot.state === "stopped") {
      return;
    }
    this.desiredRunning = false;
    this.generation += 1;
    this.clearReconnect();
    this.clearHeartbeat();
    this.streamClosedSubscription?.remove();
    this.streamClosedSubscription = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(NORMAL_CLOSE, reason);
    this.cancelStreams();
    let errorCode: string | null = null;
    try {
      await this.runTunnelLifecycle(() => this.options.tunnel.stop(reason));
    } catch {
      errorCode = "MOBILE_TUNNEL_STOP_FAILED";
    }
    this.publish("stopped", errorCode);
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    this.publish("connecting", null);
    try {
      const { ticket } = await this.options.ticketProvider.issue();
      if (!this.isCurrent(generation)) {
        return;
      }
      if (!ticket || ticket.length > 4_096) {
        throw new Error("SESSION_TICKET_RESPONSE_INVALID");
      }
      const socket = this.createSocket(this.options.controlUrl);
      this.socket = socket;
      await waitForOpen(socket, CONTROL_OPEN_TIMEOUT_MS);
      if (!this.isCurrent(generation) || this.socket !== socket) {
        socket.close(NORMAL_CLOSE, "STALE_CONNECTION");
        return;
      }
      this.installSocketHandlers(socket, generation);
      socket.send(JSON.stringify(hello(this.options.proxyId, ticket, this.options.platform)));
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.handleConnectFailure(stableError(error));
      }
    }
  }

  private installSocketHandlers(socket: ControlSocket, generation: number): void {
    socket.addEventListener("message", (event) => {
      this.messageQueue = this.messageQueue
        .catch(() => undefined)
        .then(() => this.handleMessage(socket, generation, event.data))
        .catch(() => this.failProtocol(socket, "INVALID_CONTROL_MESSAGE"));
    });
    const disconnected = () => this.handleDisconnect(socket, generation);
    socket.addEventListener("close", disconnected);
    socket.addEventListener("error", disconnected);
  }

  private async handleMessage(
    socket: ControlSocket,
    generation: number,
    raw: unknown,
  ): Promise<void> {
    if (!this.isCurrent(generation) || this.socket !== socket) {
      return;
    }
    if (typeof raw !== "string") {
      this.failProtocol(socket, "BINARY_CONTROL_MESSAGE");
      return;
    }
    const message = parseRelayMessage(raw);
    switch (message.type) {
      case "WELCOME":
        if (this.snapshot.state !== "connecting") {
          this.failProtocol(socket, "DUPLICATE_WELCOME");
          return;
        }
        await this.runTunnelLifecycle(async () => {
          if (!this.isCurrent(generation) || this.socket !== socket) {
            return;
          }
          await this.options.tunnel.configure({
            dataWebSocketBaseUrl: dataBaseUrl(this.options.controlUrl),
            allowInsecureDevelopmentEndpoints:
              this.options.allowInsecureDevelopmentEndpoints ?? false,
            maxStreams: Math.min(message.max_streams, 128),
          });
          if (!this.isCurrent(generation) || this.socket !== socket) {
            return;
          }
          await this.options.tunnel.start();
          if (!this.isCurrent(generation) || this.socket !== socket) {
            await this.options.tunnel.stop("MOBILE_APP_BACKGROUND");
          }
        });
        if (!this.isCurrent(generation) || this.socket !== socket) {
          return;
        }
        this.reconnectAttempt = 0;
        this.publish("online", null);
        this.startHeartbeat(socket, generation, message.heartbeat_interval_ms);
        return;
      case "PING":
        this.sendOn(socket, { type: "PONG", nonce: message.nonce });
        return;
      case "PONG":
        return;
      case "OPEN_REQUEST":
        void this.openStream(socket, generation, message).catch(() =>
          this.failProtocol(socket, "MOBILE_STREAM_DISPATCH_FAILED"),
        );
        return;
      case "CONNECTION_CLOSED":
        await this.cancelStream(message.connection_id);
        return;
      case "GOAWAY":
        await this.stop("USER_REQUESTED");
        return;
    }
  }

  private async openStream(
    socket: ControlSocket,
    generation: number,
    request: OpenRequest,
  ): Promise<void> {
    if (this.snapshot.state !== "online") {
      this.sendOpenFailed(socket, request.connection_id, "MOBILE_AGENT_NOT_READY");
      return;
    }
    if (this.streams.has(request.connection_id)) {
      this.sendOpenFailed(socket, request.connection_id, "DUPLICATE_CONNECTION");
      return;
    }
    const reservation: StreamReservation = { cancelled: false, ready: false };
    this.streams.set(request.connection_id, reservation);
    let result: MobileStreamOpenResult;
    try {
      result = await this.options.tunnel.openStream({
        connectionId: request.connection_id,
        connectionToken: request.connection_token,
        host: request.host,
        port: request.port,
        connectTimeoutMs: request.connect_timeout_ms,
      });
    } catch (error) {
      if (this.isActiveReservation(socket, generation, request.connection_id, reservation)) {
        this.streams.delete(request.connection_id);
        this.sendOpenFailed(socket, request.connection_id, stableError(error));
        this.publish(this.snapshot.state, this.snapshot.errorCode);
      }
      return;
    }
    if (!this.isActiveReservation(socket, generation, request.connection_id, reservation)) {
      await this.closeNativeStream(request.connection_id);
      return;
    }
    if (
      result.connectionId !== request.connection_id ||
      (result.status !== "ready" && result.status !== "failed")
    ) {
      this.streams.delete(request.connection_id);
      await this.closeNativeStream(request.connection_id);
      this.sendOpenFailed(socket, request.connection_id, "NATIVE_STREAM_RESULT_INVALID");
      this.publish(this.snapshot.state, this.snapshot.errorCode);
      return;
    }
    if (result.status === "failed") {
      this.streams.delete(request.connection_id);
      this.sendOpenFailed(socket, request.connection_id, stableReason(result.reason));
      this.publish(this.snapshot.state, this.snapshot.errorCode);
      return;
    }
    reservation.ready = true;
    this.sendOn(socket, { type: "OPEN_READY", connection_id: request.connection_id });
    this.publish(this.snapshot.state, this.snapshot.errorCode);
  }

  private async cancelStream(connectionId: string): Promise<void> {
    const stream = this.streams.get(connectionId);
    if (!stream) {
      return;
    }
    stream.cancelled = true;
    this.streams.delete(connectionId);
    await this.closeNativeStream(connectionId);
    this.publish(this.snapshot.state, this.snapshot.errorCode);
  }

  private handleNativeStreamClosed(event: MobileStreamClosedEvent): void {
    const stream = this.streams.get(event.connectionId);
    if (!stream) {
      return;
    }
    stream.cancelled = true;
    this.streams.delete(event.connectionId);
    const socket = this.socket;
    if (socket?.readyState === 1 && this.snapshot.state === "online") {
      this.sendOn(
        socket,
        stream.ready
          ? {
              type: "CONNECTION_CLOSED",
              connection_id: event.connectionId,
              reason: stableReason(event.reason),
            }
          : {
              type: "OPEN_FAILED",
              connection_id: event.connectionId,
              reason: stableReason(event.reason),
            },
      );
    }
    this.publish(this.snapshot.state, this.snapshot.errorCode);
  }

  private handleDisconnect(
    socket: ControlSocket,
    generation: number,
    errorCode = "CONTROL_CHANNEL_CLOSED",
  ): void {
    if (!this.isCurrent(generation) || this.socket !== socket) {
      return;
    }
    this.socket = null;
    this.clearHeartbeat();
    this.cancelStreams();
    if (!this.desiredRunning) {
      this.publish("stopped", null);
      return;
    }
    this.publish("backoff", errorCode);
    void this.stopTunnelThenReconnect(generation);
  }

  private handleConnectFailure(reason: string): void {
    this.socket?.close(PROTOCOL_ERROR_CLOSE, "CONNECT_FAILED");
    this.socket = null;
    if (!this.desiredRunning) {
      return;
    }
    this.publish("backoff", reason);
    this.scheduleReconnect();
  }

  private failProtocol(socket: ControlSocket, reason: string): void {
    if (this.socket !== socket) {
      return;
    }
    socket.close(PROTOCOL_ERROR_CLOSE, "PROTOCOL_ERROR");
    this.handleDisconnect(socket, this.generation, stableReason(reason));
  }

  private async stopTunnelThenReconnect(generation: number): Promise<void> {
    try {
      await this.runTunnelLifecycle(() => this.options.tunnel.stop("USER_REQUESTED"));
    } catch {
      if (this.isCurrent(generation)) {
        this.desiredRunning = false;
        this.generation += 1;
        this.streamClosedSubscription?.remove();
        this.streamClosedSubscription = null;
        this.publish("stopped", "MOBILE_TUNNEL_STOP_FAILED");
      }
      return;
    }
    if (this.isCurrent(generation) && this.socket === null) {
      this.scheduleReconnect();
    }
  }

  private runTunnelLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tunnelLifecycleQueue.catch(() => undefined).then(operation);
    this.tunnelLifecycleQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private scheduleReconnect(): void {
    if (!this.desiredRunning || this.reconnectTimer) {
      return;
    }
    const index = Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1);
    const delay = this.reconnectDelays[index] ?? 30_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(socket: ControlSocket, generation: number, intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (
        this.isCurrent(generation) &&
        this.socket === socket &&
        this.snapshot.state === "online"
      ) {
        this.sendOn(socket, {
          type: "PING",
          nonce: `${this.now().toString(36)}-${(++this.heartbeatNonce).toString(36)}`,
        });
      }
    }, intervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private cancelStreams(): void {
    for (const [connectionId, stream] of this.streams) {
      stream.cancelled = true;
      void this.options.tunnel.closeStream(connectionId).catch(() => undefined);
    }
    this.streams.clear();
  }

  private async closeNativeStream(connectionId: string): Promise<void> {
    await this.options.tunnel.closeStream(connectionId).catch(() => undefined);
  }

  private sendOpenFailed(socket: ControlSocket, connectionId: string, reason: string): void {
    this.sendOn(socket, { type: "OPEN_FAILED", connection_id: connectionId, reason });
  }

  private sendOn(socket: ControlSocket, message: object): void {
    if (this.socket === socket && socket.readyState === 1) {
      socket.send(JSON.stringify(message));
    }
  }

  private isCurrent(generation: number): boolean {
    return this.desiredRunning && this.generation === generation;
  }

  private isActiveReservation(
    socket: ControlSocket,
    generation: number,
    connectionId: string,
    reservation: StreamReservation,
  ): boolean {
    return (
      this.isCurrent(generation) &&
      this.socket === socket &&
      !reservation.cancelled &&
      this.streams.get(connectionId) === reservation
    );
  }

  private publish(state: MobileRuntimeState, errorCode: string | null): void {
    this.snapshot = Object.freeze({
      state,
      proxyId: this.options.proxyId,
      activeStreams: [...this.streams.values()].filter((stream) => stream.ready).length,
      connectedAt:
        state === "online"
          ? (this.snapshot.connectedAt ?? new Date(this.now()).toISOString())
          : null,
      errorCode,
    });
    this.options.onSnapshot?.(this.snapshot);
  }
}

function waitForOpen(socket: ControlSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === 1) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => finish(new Error("CONTROL_CHANNEL_OPEN_TIMEOUT")), timeoutMs);
    const onOpen = () => finish();
    const onError = () => finish(new Error("CONTROL_CHANNEL_OPEN_FAILED"));
    const onClose = () => finish(new Error("CONTROL_CHANNEL_OPEN_CLOSED"));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      error ? reject(error) : resolve();
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

function dataBaseUrl(controlUrl: string): string {
  const url = new URL(controlUrl);
  url.pathname = "/agent/v1/data";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function stableReason(value: string | null): string {
  return value && value.length <= 64 && /^[A-Z0-9_]+$/.test(value) ? value : "STREAM_FAILED";
}

function stableError(error: unknown): string {
  return error instanceof Error ? stableReason(error.message) : "MOBILE_AGENT_FAILED";
}

function validateOptions(options: MobileAgentRuntimeOptions): void {
  const url = new URL(options.controlUrl);
  if (
    !(
      url.protocol === "wss:" ||
      (options.allowInsecureDevelopmentEndpoints === true && url.protocol === "ws:")
    ) ||
    url.pathname !== "/agent/v1/control" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("CONTROL_URL_INVALID");
  }
  if (!options.proxyId || options.proxyId.length > 128) {
    throw new Error("PROXY_ID_INVALID");
  }
  if (
    options.reconnectDelaysMs &&
    (options.reconnectDelaysMs.length === 0 ||
      options.reconnectDelaysMs.some(
        (value) => !Number.isSafeInteger(value) || value < 0 || value > 60_000,
      ))
  ) {
    throw new Error("RECONNECT_DELAYS_INVALID");
  }
}

function defaultSocketFactory(url: string): ControlSocket {
  return new WebSocket(url) as unknown as ControlSocket;
}
