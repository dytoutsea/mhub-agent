import { describe, expect, it } from "vitest";

import { DesktopAgentRuntime } from "./agent-runtime";

describe("DesktopAgentRuntime", () => {
  it("starts unregistered when no development credentials are configured", async () => {
    const runtime = new DesktopAgentRuntime("macos", null);

    expect(runtime.getSnapshot()).toMatchObject({
      platform: "macos",
      state: "unregistered",
      proxyId: null,
      activeStreams: 0,
      connectedAt: null,
      errorCode: null,
    });
    await expect(runtime.start()).rejects.toThrow("AGENT_CONFIGURATION_REQUIRED");
    expect(runtime.getSnapshot().state).toBe("unregistered");
  });

  it("publishes only sanitized state fields", () => {
    const runtime = new DesktopAgentRuntime("windows", {
      controlUrl: "wss://relay.example.test/agent/v1/control",
      proxyId: "cpx_01K1D1NJ000000000000008003",
      ticket: "ticket-must-not-escape",
    });

    expect(runtime.getSnapshot()).not.toHaveProperty("ticket");
    expect(runtime.getSnapshot()).not.toHaveProperty("devicePrivateKey");
  });

  it("publishes a sanitized paused state for a system interruption", async () => {
    const runtime = new DesktopAgentRuntime("windows", {
      controlUrl: "wss://relay.example.test/agent/v1/control",
      proxyId: "cpx_01K1D1NJ000000000000008003",
      ticket: "ticket-must-not-escape",
    });

    await runtime.pause("SYSTEM_SUSPENDED");

    expect(runtime.getSnapshot()).toMatchObject({
      state: "paused",
      activeStreams: 0,
      connectedAt: null,
      errorCode: "SYSTEM_SUSPENDED",
    });
  });
});
