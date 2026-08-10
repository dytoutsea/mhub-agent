import { describe, expect, it } from "vitest";

import { AGENT_STATES, createInitialAgentSnapshot } from "./index";

describe("agent snapshot", () => {
  it("starts unregistered without an identity or active stream", () => {
    expect(createInitialAgentSnapshot("macos")).toEqual({
      platform: "macos",
      state: "unregistered",
      proxyId: null,
      activeStreams: 0,
      connectedAt: null,
    });
  });

  it("keeps the documented state vocabulary stable", () => {
    expect(AGENT_STATES).toEqual([
      "unregistered",
      "stopped",
      "connecting",
      "online",
      "degraded",
      "backoff",
      "paused",
      "revoked",
    ]);
  });
});
