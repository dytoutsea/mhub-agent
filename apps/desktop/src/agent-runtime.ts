import {
  RelayAgent,
  type RelayAgentEvent,
  type RelayAgentOptions,
} from "../../../tools/relay-agent/src/relay-agent.js";
import { SessionTicketClient } from "../../../tools/relay-agent/src/session-ticket-client.js";

import { type AgentSnapshot, agentSnapshotSchema } from "./contracts";

export interface DesktopAgentRuntimeConfig {
  readonly controlUrl: string;
  readonly proxyId: string;
  readonly ticket?: string;
  readonly sessionTicketApiUrl?: string;
  readonly credentialId?: string;
  readonly devicePrivateKey?: string;
  readonly allowPrivateTargets?: boolean;
}

export type RuntimeEventListener = (snapshot: AgentSnapshot) => void;

export class DesktopAgentRuntime {
  private agent: RelayAgent | null = null;
  private readonly listeners = new Set<RuntimeEventListener>();
  private snapshot: AgentSnapshot;
  private connectedAt: string | null = null;

  constructor(
    platform: "windows" | "macos" | "unsupported",
    private readonly config: DesktopAgentRuntimeConfig | null = loadRuntimeConfig(),
  ) {
    this.snapshot = agentSnapshotSchema.parse({
      platform,
      state: config ? "stopped" : "unregistered",
      proxyId: config?.proxyId ?? null,
      activeStreams: 0,
      connectedAt: null,
      errorCode: null,
    });
  }

  getSnapshot(): AgentSnapshot {
    return this.snapshot;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<AgentSnapshot> {
    if (this.agent) {
      throw new Error("AGENT_ALREADY_STARTED");
    }
    if (!this.config) {
      this.update({ state: "unregistered", errorCode: "AGENT_CONFIGURATION_REQUIRED" });
      throw new Error("AGENT_CONFIGURATION_REQUIRED");
    }
    this.update({ state: "connecting", errorCode: null });
    const sessionTicketClient = createSessionTicketClient(this.config);
    const relayOptions: RelayAgentOptions = {
      controlUrl: this.config.controlUrl,
      proxyId: this.config.proxyId,
      onEvent: (event: RelayAgentEvent) => this.handleAgentEvent(event),
      ...(this.config.ticket ? { ticket: this.config.ticket } : {}),
      ...(sessionTicketClient ? { sessionTicketClient } : {}),
      ...(this.config.allowPrivateTargets !== undefined
        ? { allowPrivateTargets: this.config.allowPrivateTargets }
        : {}),
    };
    const relayAgent = new RelayAgent(relayOptions);
    this.agent = relayAgent;
    try {
      await relayAgent.start();
    } catch (error) {
      if (this.agent === relayAgent) {
        this.agent = null;
      }
      this.update({ state: "degraded", errorCode: stableRuntimeError(error) });
      throw error;
    }
    return this.snapshot;
  }

  async stop(): Promise<AgentSnapshot> {
    const agent = this.agent;
    this.agent = null;
    if (agent) {
      await agent.stop();
    } else if (this.snapshot.state !== "unregistered") {
      this.update({ state: "stopped", activeStreams: 0, connectedAt: null, errorCode: null });
    }
    return this.snapshot;
  }

  async pause(errorCode: "NETWORK_OFFLINE" | "SYSTEM_SUSPENDED"): Promise<AgentSnapshot> {
    const agent = this.agent;
    this.agent = null;
    if (agent) {
      await agent.stop();
    }
    if (this.snapshot.state !== "unregistered") {
      this.update({
        state: "paused",
        activeStreams: 0,
        connectedAt: null,
        errorCode,
      });
    }
    return this.snapshot;
  }

  private handleAgentEvent(event: RelayAgentEvent) {
    if (event.type === "online") {
      this.connectedAt = new Date().toISOString();
      this.update({ state: "online", connectedAt: this.connectedAt, errorCode: null });
    } else if (event.type === "stream_opened") {
      this.update({ activeStreams: this.snapshot.activeStreams + 1 });
    } else if (event.type === "stream_closed") {
      this.update({ activeStreams: Math.max(0, this.snapshot.activeStreams - 1) });
    } else if (event.type === "stopped") {
      this.update({ state: "stopped", activeStreams: 0, connectedAt: null });
    }
  }

  private update(patch: Partial<AgentSnapshot>) {
    this.snapshot = agentSnapshotSchema.parse({ ...this.snapshot, ...patch });
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}

function loadRuntimeConfig(): DesktopAgentRuntimeConfig | null {
  const controlUrl = process.env.MHUB_RELAY_CONTROL_URL?.trim();
  const proxyId = process.env.MHUB_PROXY_ID?.trim();
  if (!controlUrl || !proxyId) {
    return null;
  }
  const config: DesktopAgentRuntimeConfig = {
    controlUrl,
    proxyId,
    allowPrivateTargets: process.env.MHUB_ALLOW_PRIVATE_TARGETS === "true",
    ...(process.env.MHUB_RELAY_TICKET?.trim()
      ? { ticket: process.env.MHUB_RELAY_TICKET.trim() }
      : {}),
    ...(process.env.MHUB_AGENT_API_URL?.trim()
      ? { sessionTicketApiUrl: process.env.MHUB_AGENT_API_URL.trim() }
      : {}),
    ...(process.env.MHUB_CREDENTIAL_ID?.trim()
      ? { credentialId: process.env.MHUB_CREDENTIAL_ID.trim() }
      : {}),
    ...(process.env.MHUB_DEVICE_PRIVATE_KEY?.trim()
      ? { devicePrivateKey: process.env.MHUB_DEVICE_PRIVATE_KEY.trim() }
      : {}),
  };
  if (
    !config.ticket &&
    !(config.sessionTicketApiUrl && config.credentialId && config.devicePrivateKey)
  ) {
    return null;
  }
  return config;
}

function createSessionTicketClient(config: DesktopAgentRuntimeConfig) {
  if (!config.sessionTicketApiUrl || !config.credentialId || !config.devicePrivateKey) {
    return undefined;
  }
  return new SessionTicketClient({
    apiUrl: config.sessionTicketApiUrl,
    credentialId: config.credentialId,
    devicePrivateKey: config.devicePrivateKey,
  });
}

function stableRuntimeError(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) {
    return error.message;
  }
  return "AGENT_START_FAILED";
}
