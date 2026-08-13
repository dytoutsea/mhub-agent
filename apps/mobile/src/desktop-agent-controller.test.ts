import { describe, expect, it, vi } from "vitest";

import {
  DesktopAgentController,
  type DesktopAgentSnapshot,
  type DesktopBridge,
  findDesktopBridge,
} from "./desktop-agent-controller";

const STOPPED: DesktopAgentSnapshot = {
  platform: "macos",
  state: "stopped",
  proxyId: "cpx_01K1D1NJ000000000000008003",
  activeStreams: 0,
  connectedAt: null,
  errorCode: null,
};

describe("DesktopAgentController", () => {
  it("fails closed when the preload bridge is absent", async () => {
    const controller = new DesktopAgentController(null);

    await controller.initialize();

    expect(controller.getSnapshot()).toMatchObject({
      state: "unavailable",
      errorCode: "DESKTOP_BRIDGE_UNAVAILABLE",
    });
    expect(findDesktopBridge({ window: {} })).toBeNull();
  });

  it("subscribes before loading the host and agent snapshots", async () => {
    const harness = createHarness();

    await harness.controller.initialize();

    expect(harness.bridge.agent.onStateChanged).toHaveBeenCalledOnce();
    expect(harness.controller.getSnapshot()).toEqual({ ...STOPPED, appVersion: "0.1.0" });
  });

  it("keeps a newer event when the initial state request resolves late", async () => {
    let resolveState!: (snapshot: DesktopAgentSnapshot) => void;
    const harness = createHarness();
    harness.bridge.agent.getState.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveState = resolve;
      }),
    );

    const initializing = harness.controller.initialize();
    harness.emit({ ...STOPPED, state: "online", activeStreams: 2 });
    resolveState(STOPPED);
    await initializing;

    expect(harness.controller.getSnapshot()).toMatchObject({ state: "online", activeStreams: 2 });
  });

  it("activates and reloads the sanitized agent snapshot", async () => {
    const harness = createHarness({ ...STOPPED, state: "unregistered", proxyId: null });
    await harness.controller.initialize();
    harness.bridge.agent.getState.mockResolvedValueOnce(STOPPED);

    await harness.controller.activate("  one-time-code  ");

    expect(harness.bridge.agent.activate).toHaveBeenCalledWith({ activationCode: "one-time-code" });
    expect(harness.controller.getSnapshot().proxyId).toBe(STOPPED.proxyId);
  });

  it("serializes start and stop operations", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    let resolveStart!: (snapshot: DesktopAgentSnapshot) => void;
    harness.bridge.agent.start.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );

    const starting = harness.controller.start();
    await expect(harness.controller.stop()).rejects.toThrow("DESKTOP_OPERATION_IN_PROGRESS");
    resolveStart({ ...STOPPED, state: "connecting" });
    await starting;

    expect(harness.bridge.agent.stop).not.toHaveBeenCalled();
  });

  it("rejects operations until initialization completes", async () => {
    let resolveState!: (snapshot: DesktopAgentSnapshot) => void;
    const harness = createHarness();
    harness.bridge.agent.getState.mockReturnValueOnce(
      new Promise<DesktopAgentSnapshot>((resolve) => {
        resolveState = resolve;
      }),
    );

    const initializing = harness.controller.initialize();
    await expect(harness.controller.start()).rejects.toThrow("DESKTOP_OPERATION_IN_PROGRESS");
    resolveState(STOPPED);
    await initializing;
  });

  it("redacts unknown native errors and retains known error codes", async () => {
    const harness = createHarness();
    await harness.controller.initialize();
    harness.bridge.agent.start.mockRejectedValueOnce(new Error("server body contains a secret"));

    await expect(harness.controller.start()).rejects.toThrow();
    expect(harness.controller.getSnapshot().errorCode).toBe("DESKTOP_START_FAILED");

    harness.bridge.agent.start.mockRejectedValueOnce(
      new Error("Error invoking remote method: Error: AGENT_CONFIGURATION_REQUIRED"),
    );
    await expect(harness.controller.start()).rejects.toThrow();
    expect(harness.controller.getSnapshot().errorCode).toBe("AGENT_CONFIGURATION_REQUIRED");
  });

  it("removes the state subscription when disposed", async () => {
    const harness = createHarness();
    await harness.controller.initialize();

    harness.controller.dispose();

    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });
});

function createHarness(initialSnapshot: DesktopAgentSnapshot = STOPPED) {
  let listener: ((snapshot: DesktopAgentSnapshot) => void) | null = null;
  const unsubscribe = vi.fn();
  const bridge = {
    getHostInfo: vi.fn(async () => ({ appVersion: "0.1.0", platform: "macos" as const })),
    agent: {
      activate: vi.fn(async () => ({
        proxyId: STOPPED.proxyId as string,
        proxyName: "广州一号",
        platform: "macos" as const,
        activatedAt: "2026-08-13T07:00:00Z",
        credentialExpiresAt: "2026-09-13T07:00:00Z",
      })),
      getState: vi.fn(async () => initialSnapshot),
      start: vi.fn(
        async (): Promise<DesktopAgentSnapshot> => ({
          ...initialSnapshot,
          state: "connecting",
        }),
      ),
      stop: vi.fn(
        async (): Promise<DesktopAgentSnapshot> => ({
          ...initialSnapshot,
          state: "stopped",
        }),
      ),
      onStateChanged: vi.fn((next: (snapshot: DesktopAgentSnapshot) => void) => {
        listener = next;
        return unsubscribe;
      }),
    },
  } satisfies DesktopBridge;
  const controller = new DesktopAgentController(bridge);
  return {
    bridge,
    controller,
    emit: (snapshot: DesktopAgentSnapshot) => listener?.(snapshot),
    unsubscribe,
  };
}
