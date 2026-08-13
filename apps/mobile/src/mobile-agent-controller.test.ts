import type { MobileAgentRegistration, MobileRuntimeSnapshot } from "@mhub/mobile-runtime";
import { describe, expect, it, vi } from "vitest";

import {
  MobileAgentController,
  type MobileAgentControllerOptions,
  type MobileRuntime,
} from "./mobile-agent-controller";

const REGISTRATION: MobileAgentRegistration = {
  proxyId: "cpx_01K1D1NJ000000000000008003",
  proxyName: "广州移动出口",
  platform: "android",
  activatedAt: "2026-08-13T07:00:00Z",
  credentialExpiresAt: "2026-09-13T07:00:00Z",
};

describe("MobileAgentController", () => {
  it("loads registration without automatically starting the proxy", async () => {
    const harness = createHarness(REGISTRATION);

    await harness.controller.initialize();

    expect(harness.controller.getSnapshot()).toMatchObject({
      state: "stopped",
      registration: REGISTRATION,
    });
    expect(harness.runtime.start).not.toHaveBeenCalled();
  });

  it("stops in background and resumes while user intent remains enabled", async () => {
    const harness = createHarness(REGISTRATION);
    await harness.controller.initialize();

    await harness.controller.start();
    await harness.controller.handleAppState("background");
    await harness.controller.handleAppState("active");

    expect(harness.runtime.start).toHaveBeenCalledTimes(2);
    expect(harness.runtime.stop).toHaveBeenCalledWith("MOBILE_APP_BACKGROUND");
  });

  it("does not resume after the user explicitly stops in background", async () => {
    const harness = createHarness(REGISTRATION);
    await harness.controller.initialize();
    await harness.controller.start();
    await harness.controller.handleAppState("background");

    await harness.controller.stop();
    await harness.controller.handleAppState("active");

    expect(harness.runtime.start).toHaveBeenCalledTimes(1);
  });

  it("uses an AppState change received while secure storage is still loading", async () => {
    let resolveRegistration!: (value: MobileAgentRegistration | null) => void;
    const registration = new Promise<MobileAgentRegistration | null>((resolve) => {
      resolveRegistration = resolve;
    });
    const harness = createHarness(null);
    harness.identity.loadRegistration.mockReturnValueOnce(registration);

    const initializing = harness.controller.initialize();
    await harness.controller.handleAppState("background");
    resolveRegistration(REGISTRATION);
    await initializing;
    await harness.controller.start();

    expect(harness.runtime.start).not.toHaveBeenCalled();
    await harness.controller.handleAppState("active");
    expect(harness.runtime.start).toHaveBeenCalledTimes(1);
  });

  it("rejects activation while secure storage is still loading", async () => {
    let resolveRegistration!: (value: MobileAgentRegistration | null) => void;
    const registration = new Promise<MobileAgentRegistration | null>((resolve) => {
      resolveRegistration = resolve;
    });
    const harness = createHarness(null);
    harness.identity.loadRegistration.mockReturnValueOnce(registration);

    const initializing = harness.controller.initialize();
    await expect(harness.controller.activate("one-time-code")).rejects.toThrow(
      "MOBILE_AGENT_ACTIVATION_NOT_READY",
    );
    expect(harness.identity.activate).not.toHaveBeenCalled();
    resolveRegistration(null);
    await initializing;

    await expect(harness.controller.activate("one-time-code")).resolves.toBeUndefined();
  });

  it("installs a newly activated identity", async () => {
    const harness = createHarness(null);
    await harness.controller.initialize();
    expect(harness.controller.getSnapshot().state).toBe("unregistered");

    await harness.controller.activate("one-time-code");
    expect(harness.controller.getSnapshot()).toMatchObject({
      state: "stopped",
      registration: REGISTRATION,
    });
  });

  it("sanitizes activation failures", async () => {
    const harness = createHarness(null);
    await harness.controller.initialize();

    harness.identity.activate.mockRejectedValueOnce(new Error("server response body secret"));
    await expect(harness.controller.activate("bad-code")).rejects.toThrow();
    expect(harness.controller.getSnapshot().errorCode).toBe("MOBILE_AGENT_FAILED");
  });

  it("stops with app-context reason on disposal", async () => {
    const harness = createHarness(REGISTRATION);
    await harness.controller.initialize();
    await harness.controller.start();

    await harness.controller.dispose();

    expect(harness.runtime.stop).toHaveBeenLastCalledWith("APP_CONTEXT_DESTROYED");
  });

  it("allows restart after the runtime stops independently", async () => {
    const harness = createHarness(REGISTRATION);
    await harness.controller.initialize();
    await harness.controller.start();

    harness.publishRuntime("stopped");
    await harness.controller.start();

    expect(harness.runtime.start).toHaveBeenCalledTimes(2);
  });
});

function createHarness(registration: MobileAgentRegistration | null) {
  const identity = {
    loadRegistration: vi.fn(async () => registration),
    activate: vi.fn(async () => REGISTRATION),
    createTicketProvider: vi.fn(() => ({ issue: async () => ({ ticket: "ticket" }) })),
    clear: vi.fn(async () => undefined),
  };
  let onRuntimeSnapshot: ((snapshot: MobileRuntimeSnapshot) => void) | null = null;
  const runtime: MobileRuntime = {
    start: vi.fn(async () => {
      onRuntimeSnapshot?.(runtimeSnapshot("connecting"));
    }),
    stop: vi.fn(async () => {
      onRuntimeSnapshot?.(runtimeSnapshot("stopped"));
    }),
    getSnapshot: () => runtimeSnapshot("stopped"),
  };
  const options: MobileAgentControllerOptions = {
    identity,
    initialAppState: "active",
    createRuntime: (_registration, _ticketProvider, onSnapshot) => {
      onRuntimeSnapshot = onSnapshot;
      return runtime;
    },
  };
  return {
    controller: new MobileAgentController(options),
    identity,
    runtime,
    publishRuntime: (state: MobileRuntimeSnapshot["state"]) =>
      onRuntimeSnapshot?.(runtimeSnapshot(state)),
  };
}

function runtimeSnapshot(state: MobileRuntimeSnapshot["state"]): MobileRuntimeSnapshot {
  return {
    state,
    proxyId: REGISTRATION.proxyId,
    activeStreams: 0,
    connectedAt: null,
    errorCode: null,
  };
}
