import type {
  EventSubscription,
  MobileDataTunnel,
  MobileStreamClosedEvent,
  MobileStreamOpenRequest,
  MobileStreamOpenResult,
  MobileTunnelConfiguration,
  MobileTunnelSnapshot,
  MobileTunnelStopReason,
} from "@mhub/mobile-data-tunnel";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ControlSocket,
  type ControlSocketEventMap,
  MobileAgentRuntime,
} from "./mobile-agent-runtime";

const WELCOME = JSON.stringify({
  type: "WELCOME",
  session_id: "rse_example",
  heartbeat_interval_ms: 10_000,
  connection_open_timeout_ms: 10_000,
  max_streams: 64,
  max_bps: 10_485_760,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MobileAgentRuntime", () => {
  it("obtains a ticket, handshakes, starts the native tunnel, and answers ping", async () => {
    const harness = createHarness();

    await harness.runtime.start();
    expect(harness.ticketProvider.issue).toHaveBeenCalledTimes(1);
    expect(harness.socket.sent.map(parseSent)).toEqual([
      expect.objectContaining({
        type: "HELLO",
        proxy_id: "cpx_example",
        ticket: "ticket-1",
        platform: "android",
      }),
    ]);

    harness.socket.message(WELCOME);
    await waitUntil(() => harness.runtime.getSnapshot().state === "online");

    expect(harness.tunnel.configure).toHaveBeenCalledWith({
      dataWebSocketBaseUrl: "wss://relay.example/agent/v1/data",
      maxStreams: 64,
    });
    expect(harness.tunnel.start).toHaveBeenCalledTimes(1);
    expect(harness.runtime.getSnapshot()).toMatchObject({
      state: "online",
      activeStreams: 0,
      connectedAt: "2026-08-13T06:00:00.000Z",
    });

    harness.socket.message(JSON.stringify({ type: "PING", nonce: "ping-1" }));
    await flushMessages();
    expect(parseSent(harness.socket.sent.at(-1))).toEqual({ type: "PONG", nonce: "ping-1" });
  });

  it("opens streams, reports stable native failures, and forwards native close events", async () => {
    const harness = createHarness();
    await startOnline(harness);

    harness.socket.message(openRequest("rcn_ready"));
    await flushMessages();
    expect(parseSent(harness.socket.sent.at(-1))).toEqual({
      type: "OPEN_READY",
      connection_id: "rcn_ready",
    });
    expect(harness.runtime.getSnapshot().activeStreams).toBe(1);

    harness.tunnel.openStream.mockRejectedValueOnce(new Error("TARGET_CONNECT_FAILED"));
    harness.socket.message(openRequest("rcn_failed"));
    await flushMessages();
    expect(parseSent(harness.socket.sent.at(-1))).toEqual({
      type: "OPEN_FAILED",
      connection_id: "rcn_failed",
      reason: "TARGET_CONNECT_FAILED",
    });
    expect(harness.runtime.getSnapshot().state).toBe("online");

    harness.tunnel.emitClosed({ connectionId: "rcn_ready", reason: "REMOTE_CLOSED" });
    expect(parseSent(harness.socket.sent.at(-1))).toEqual({
      type: "CONNECTION_CLOSED",
      connection_id: "rcn_ready",
      reason: "REMOTE_CLOSED",
    });
    expect(harness.runtime.getSnapshot().activeStreams).toBe(0);
  });

  it("cancels a pending native open when the relay closes the stream", async () => {
    const pending = deferred<MobileStreamOpenResult>();
    const harness = createHarness();
    harness.tunnel.openStream.mockImplementationOnce(() => pending.promise);
    await startOnline(harness);

    harness.socket.message(openRequest("rcn_pending"));
    await flushMessages();
    expect(harness.runtime.getSnapshot().activeStreams).toBe(0);

    harness.socket.message(
      JSON.stringify({
        type: "CONNECTION_CLOSED",
        connection_id: "rcn_pending",
        reason: "SDK_CLOSED",
      }),
    );
    await flushMessages();
    expect(harness.tunnel.closeStream).toHaveBeenCalledWith("rcn_pending");

    pending.resolve({ connectionId: "rcn_pending", status: "ready", reason: null });
    await flushMessages();
    expect(harness.tunnel.closeStream).toHaveBeenCalledTimes(2);
    expect(harness.socket.sent.map(parseSent)).not.toContainEqual({
      type: "OPEN_READY",
      connection_id: "rcn_pending",
    });
  });

  it("reports a native close during pending open as OPEN_FAILED", async () => {
    const pending = deferred<MobileStreamOpenResult>();
    const harness = createHarness();
    harness.tunnel.openStream.mockImplementationOnce(() => pending.promise);
    await startOnline(harness);

    harness.socket.message(openRequest("rcn_pending"));
    await flushMessages();
    harness.tunnel.emitClosed({ connectionId: "rcn_pending", reason: "TARGET_CONNECT_FAILED" });

    expect(parseSent(harness.socket.sent.at(-1))).toEqual({
      type: "OPEN_FAILED",
      connection_id: "rcn_pending",
      reason: "TARGET_CONNECT_FAILED",
    });
    pending.resolve({ connectionId: "rcn_pending", status: "ready", reason: null });
    await flushMessages();
    expect(harness.socket.sent.map(parseSent)).not.toContainEqual({
      type: "OPEN_READY",
      connection_id: "rcn_pending",
    });
  });

  it.each([
    [new Uint8Array([1, 2, 3]), "BINARY_CONTROL_MESSAGE"],
    ['{"type":"PING","nonce":"ok","extra":true}', "INVALID_CONTROL_MESSAGE"],
  ])("fails closed on invalid control frames", async (frame, errorCode) => {
    const harness = createHarness();
    await harness.runtime.start();

    harness.socket.message(frame);
    await flushMessages();

    expect(harness.socket.closed).toContainEqual({ code: 1_002, reason: "PROTOCOL_ERROR" });
    expect(harness.runtime.getSnapshot()).toMatchObject({ state: "backoff", errorCode });
  });

  it("stops the native tunnel before reconnecting with a fresh ticket", async () => {
    vi.useFakeTimers();
    const stopGate = deferred<MobileTunnelSnapshot>();
    const sockets: FakeSocket[] = [];
    const harness = createHarness({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelaysMs: [25],
    });
    harness.tunnel.stop.mockImplementationOnce(() => stopGate.promise);

    await harness.runtime.start();
    sockets[0]?.closeFromRemote();
    await flushMessages();
    await vi.advanceTimersByTimeAsync(25);
    expect(sockets).toHaveLength(1);

    stopGate.resolve(tunnelSnapshot("stopped"));
    await flushMessages();
    await vi.advanceTimersByTimeAsync(25);
    expect(sockets).toHaveLength(2);
    expect(harness.ticketProvider.issue).toHaveBeenCalledTimes(2);
    expect(parseSent(sockets[1]?.sent[0])).toMatchObject({ type: "HELLO", ticket: "ticket-2" });
  });

  it("fails closed when the native tunnel cannot stop after disconnect", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const harness = createHarness({
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelaysMs: [25],
    });
    harness.tunnel.stop.mockRejectedValueOnce(new Error("native details must not escape"));

    await harness.runtime.start();
    sockets[0]?.closeFromRemote();
    await flushMessages();
    await vi.advanceTimersByTimeAsync(100);

    expect(sockets).toHaveLength(1);
    expect(harness.runtime.getSnapshot()).toMatchObject({
      state: "stopped",
      errorCode: "MOBILE_TUNNEL_STOP_FAILED",
    });
  });

  it("does not revive a tunnel when stopped during WELCOME", async () => {
    const configureGate = deferred<MobileTunnelSnapshot>();
    const harness = createHarness();
    harness.tunnel.configure.mockImplementationOnce(() => configureGate.promise);
    await harness.runtime.start();

    harness.socket.message(WELCOME);
    await flushMessages();
    const stopping = harness.runtime.stop("MOBILE_APP_BACKGROUND");
    configureGate.resolve(tunnelSnapshot("stopped"));
    await stopping;
    await flushMessages();

    expect(harness.tunnel.start).not.toHaveBeenCalled();
    expect(harness.runtime.getSnapshot()).toMatchObject({ state: "stopped", activeStreams: 0 });
    expect(harness.socket.sent.map(parseSent)).not.toContainEqual(
      expect.objectContaining({ type: "GOAWAY" }),
    );
  });

  it("does not create a control socket when stopped during ticket acquisition", async () => {
    const ticketGate = deferred<{ readonly ticket: string }>();
    const createSocket = vi.fn(() => new FakeSocket());
    const harness = createHarness({
      ticketProvider: { issue: vi.fn(() => ticketGate.promise) },
      createSocket,
    });

    const starting = harness.runtime.start();
    await flushMessages();
    await harness.runtime.stop("MOBILE_APP_BACKGROUND");
    ticketGate.resolve({ ticket: "late-ticket" });
    await starting;

    expect(createSocket).not.toHaveBeenCalled();
    expect(harness.runtime.getSnapshot().state).toBe("stopped");
  });

  it("closes a late native stream result after background stop", async () => {
    const openGate = deferred<MobileStreamOpenResult>();
    const harness = createHarness();
    harness.tunnel.openStream.mockImplementationOnce(() => openGate.promise);
    await startOnline(harness);

    harness.socket.message(openRequest("rcn_late"));
    await flushMessages();
    await harness.runtime.stop("MOBILE_APP_BACKGROUND");
    openGate.resolve({ connectionId: "rcn_late", status: "ready", reason: null });
    await flushMessages();

    expect(harness.tunnel.closeStream).toHaveBeenCalledWith("rcn_late");
    expect(harness.socket.sent.map(parseSent)).not.toContainEqual({
      type: "OPEN_READY",
      connection_id: "rcn_late",
    });
    expect(harness.runtime.getSnapshot()).toMatchObject({ state: "stopped", activeStreams: 0 });
  });

  it("publishes a sanitized stopped state when explicit native stop fails", async () => {
    const harness = createHarness();
    await startOnline(harness);
    harness.tunnel.stop.mockRejectedValueOnce(new Error("native private details"));

    await harness.runtime.stop();

    expect(harness.runtime.getSnapshot()).toMatchObject({
      state: "stopped",
      activeStreams: 0,
      errorCode: "MOBILE_TUNNEL_STOP_FAILED",
    });
  });

  it("validates reconnect configuration", () => {
    expect(() => createHarness({ reconnectDelaysMs: [] })).toThrow("RECONNECT_DELAYS_INVALID");
    expect(() => createHarness({ reconnectDelaysMs: [1.5] })).toThrow("RECONNECT_DELAYS_INVALID");
  });
});

interface Harness {
  readonly runtime: MobileAgentRuntime;
  readonly socket: FakeSocket;
  readonly tunnel: FakeTunnel;
  readonly ticketProvider: { readonly issue: ReturnType<typeof vi.fn> };
}

function createHarness(
  overrides: Partial<ConstructorParameters<typeof MobileAgentRuntime>[0]> = {},
): Harness {
  const socket = new FakeSocket();
  const tunnel = new FakeTunnel();
  let ticketNumber = 0;
  const ticketProvider = {
    issue: vi.fn(async () => ({ ticket: `ticket-${++ticketNumber}` })),
  };
  const runtime = new MobileAgentRuntime({
    controlUrl: "wss://relay.example/agent/v1/control",
    proxyId: "cpx_example",
    platform: "android",
    ticketProvider,
    tunnel,
    createSocket: () => socket,
    now: () => Date.parse("2026-08-13T06:00:00.000Z"),
    reconnectDelaysMs: [1_000],
    ...overrides,
  });
  return { runtime, socket, tunnel, ticketProvider };
}

async function startOnline(harness: Harness): Promise<void> {
  await harness.runtime.start();
  harness.socket.message(WELCOME);
  await waitUntil(() => harness.runtime.getSnapshot().state === "online");
  expect(harness.runtime.getSnapshot().state).toBe("online");
}

function openRequest(connectionId: string): string {
  return JSON.stringify({
    type: "OPEN_REQUEST",
    connection_id: connectionId,
    connection_token: "0123456789abcdef0123456789abcdef",
    host: "203.0.113.10",
    port: 443,
    connect_timeout_ms: 5_000,
  });
}

function parseSent(value: string | undefined): unknown {
  return value ? JSON.parse(value) : undefined;
}

async function flushMessages(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("TEST_CONDITION_TIMEOUT");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

class FakeSocket implements ControlSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly closed: Array<{ code: number | undefined; reason: string | undefined }> = [];
  private readonly listeners = new Map<keyof ControlSocketEventMap, Set<(event: never) => void>>();

  send(value: string): void {
    this.sent.push(value);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }

  addEventListener<EventName extends keyof ControlSocketEventMap>(
    eventName: EventName,
    listener: (event: ControlSocketEventMap[EventName]) => void,
  ): void {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener as (event: never) => void);
    this.listeners.set(eventName, listeners);
  }

  removeEventListener<EventName extends keyof ControlSocketEventMap>(
    eventName: EventName,
    listener: (event: ControlSocketEventMap[EventName]) => void,
  ): void {
    this.listeners.get(eventName)?.delete(listener as (event: never) => void);
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  closeFromRemote(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit<EventName extends keyof ControlSocketEventMap>(
    eventName: EventName,
    event: ControlSocketEventMap[EventName],
  ): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event as never);
    }
  }
}

class FakeTunnel implements MobileDataTunnel {
  private closedListener: ((event: MobileStreamClosedEvent) => void) | null = null;

  readonly configure = vi.fn(async (_configuration: MobileTunnelConfiguration) =>
    tunnelSnapshot("stopped"),
  );
  readonly start = vi.fn(async () => tunnelSnapshot("running"));
  readonly stop = vi.fn(async (_reason: MobileTunnelStopReason) => tunnelSnapshot("stopped"));
  readonly getSnapshot = vi.fn(async () => tunnelSnapshot("stopped"));
  readonly openStream = vi.fn(
    async (request: MobileStreamOpenRequest): Promise<MobileStreamOpenResult> => ({
      connectionId: request.connectionId,
      status: "ready",
      reason: null,
    }),
  );
  readonly closeStream = vi.fn(async (_connectionId: string) => tunnelSnapshot("running"));

  addListener<EventName extends "onStateChanged" | "onStreamClosed">(
    eventName: EventName,
    listener: Parameters<MobileDataTunnel["addListener"]>[1],
  ): EventSubscription {
    if (eventName === "onStreamClosed") {
      this.closedListener = listener as (event: MobileStreamClosedEvent) => void;
    }
    return {
      remove: () => {
        this.closedListener = null;
      },
    };
  }

  emitClosed(event: MobileStreamClosedEvent): void {
    this.closedListener?.(event);
  }
}

function tunnelSnapshot(state: "stopped" | "running"): MobileTunnelSnapshot {
  return { state, foreground: true, activeStreams: 0, errorCode: null };
}
