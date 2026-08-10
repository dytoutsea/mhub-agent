export const AGENT_STATES = [
  "unregistered",
  "stopped",
  "connecting",
  "online",
  "degraded",
  "backoff",
  "paused",
  "revoked",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export const AGENT_PLATFORMS = ["windows", "macos", "android", "ios"] as const;

export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

export interface AgentSnapshot {
  readonly platform: AgentPlatform;
  readonly state: AgentState;
  readonly proxyId: string | null;
  readonly activeStreams: number;
  readonly connectedAt: string | null;
}

export function createInitialAgentSnapshot(platform: AgentPlatform): AgentSnapshot {
  return Object.freeze({
    platform,
    state: "unregistered",
    proxyId: null,
    activeStreams: 0,
    connectedAt: null,
  });
}
