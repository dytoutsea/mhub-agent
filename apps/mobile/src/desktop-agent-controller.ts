export type DesktopPlatform = "windows" | "macos" | "unsupported";

export type DesktopAgentState =
  | "unregistered"
  | "stopped"
  | "connecting"
  | "online"
  | "degraded"
  | "backoff"
  | "paused"
  | "revoked";

export interface DesktopHostInfo {
  readonly appVersion: string;
  readonly platform: DesktopPlatform;
}

export interface DesktopAgentSnapshot {
  readonly platform: DesktopPlatform;
  readonly state: DesktopAgentState;
  readonly proxyId: string | null;
  readonly activeStreams: number;
  readonly connectedAt: string | null;
  readonly errorCode: string | null;
}

export interface DesktopActivationResult {
  readonly proxyId: string;
  readonly proxyName: string;
  readonly platform: Exclude<DesktopPlatform, "unsupported">;
  readonly activatedAt: string;
  readonly credentialExpiresAt: string;
}

export interface DesktopBridge {
  readonly getHostInfo: () => Promise<DesktopHostInfo>;
  readonly agent: {
    readonly activate: (payload: {
      readonly activationCode: string;
    }) => Promise<DesktopActivationResult>;
    readonly getState: () => Promise<DesktopAgentSnapshot>;
    readonly start: () => Promise<DesktopAgentSnapshot>;
    readonly stop: () => Promise<DesktopAgentSnapshot>;
    readonly onStateChanged: (listener: (snapshot: DesktopAgentSnapshot) => void) => () => void;
  };
}

declare global {
  interface Window {
    readonly mhubDesktop?: DesktopBridge;
  }
}

export type DesktopAgentViewState = DesktopAgentState | "loading" | "unavailable";

export interface DesktopControllerSnapshot {
  readonly appVersion: string | null;
  readonly platform: DesktopPlatform;
  readonly state: DesktopAgentViewState;
  readonly proxyId: string | null;
  readonly activeStreams: number;
  readonly connectedAt: string | null;
  readonly errorCode: string | null;
}

export const INITIAL_DESKTOP_SNAPSHOT: DesktopControllerSnapshot = Object.freeze({
  appVersion: null,
  platform: "unsupported",
  state: "loading",
  proxyId: null,
  activeStreams: 0,
  connectedAt: null,
  errorCode: null,
});

export function findDesktopBridge(value: unknown = globalThis): DesktopBridge | null {
  if (!isObject(value) || !isObject(value.window)) {
    return null;
  }
  const bridge = value.window.mhubDesktop;
  if (!isObject(bridge) || typeof bridge.getHostInfo !== "function" || !isObject(bridge.agent)) {
    return null;
  }
  const agent = bridge.agent;
  if (
    typeof agent.activate !== "function" ||
    typeof agent.getState !== "function" ||
    typeof agent.start !== "function" ||
    typeof agent.stop !== "function" ||
    typeof agent.onStateChanged !== "function"
  ) {
    return null;
  }
  return bridge as unknown as DesktopBridge;
}

export class DesktopAgentController {
  private snapshot = INITIAL_DESKTOP_SNAPSHOT;
  private unsubscribe: (() => void) | null = null;
  private initializePromise: Promise<void> | null = null;
  private initialized = false;
  private operationInProgress = false;
  private disposed = false;
  private eventRevision = 0;

  constructor(
    private readonly bridge: DesktopBridge | null,
    private readonly onSnapshot?: (snapshot: DesktopControllerSnapshot) => void,
  ) {}

  getSnapshot(): DesktopControllerSnapshot {
    return this.snapshot;
  }

  initialize(): Promise<void> {
    this.requireActive();
    if (this.initializePromise) {
      return this.initializePromise;
    }
    this.initializePromise = this.initializeOnce();
    return this.initializePromise;
  }

  async activate(activationCode: string): Promise<void> {
    const code = activationCode.trim();
    if (!code || code.length > 160) {
      this.publishError("ACTIVATION_CODE_INVALID");
      throw new Error("ACTIVATION_CODE_INVALID");
    }
    await this.runOperation("DESKTOP_ACTIVATION_FAILED", async (bridge) => {
      await bridge.agent.activate({ activationCode: code });
      this.publishAgentSnapshot(await bridge.agent.getState());
    });
  }

  async start(): Promise<void> {
    await this.runOperation("DESKTOP_START_FAILED", async (bridge) => {
      this.publishAgentSnapshot(await bridge.agent.start());
    });
  }

  async stop(): Promise<void> {
    await this.runOperation("DESKTOP_STOP_FAILED", async (bridge) => {
      this.publishAgentSnapshot(await bridge.agent.stop());
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async initializeOnce(): Promise<void> {
    if (!this.bridge) {
      this.publishUnavailable("DESKTOP_BRIDGE_UNAVAILABLE");
      this.initialized = true;
      return;
    }
    try {
      const revision = this.eventRevision;
      this.unsubscribe = this.bridge.agent.onStateChanged((snapshot) => {
        if (!this.disposed) {
          this.eventRevision += 1;
          this.publishAgentSnapshot(snapshot);
        }
      });
      const [hostInfo, agentSnapshot] = await Promise.all([
        this.bridge.getHostInfo(),
        this.bridge.agent.getState(),
      ]);
      if (this.disposed) {
        return;
      }
      this.snapshot = Object.freeze({ ...this.snapshot, ...hostInfo });
      if (this.eventRevision === revision) {
        this.publishAgentSnapshot(agentSnapshot);
      } else {
        this.onSnapshot?.(this.snapshot);
      }
    } catch (error) {
      if (!this.disposed) {
        this.publishUnavailable(stableDesktopError(error, "DESKTOP_INITIALIZATION_FAILED"));
      }
    } finally {
      this.initialized = true;
    }
  }

  private async runOperation(
    fallbackError: string,
    operation: (bridge: DesktopBridge) => Promise<void>,
  ): Promise<void> {
    this.requireActive();
    if (!this.initialized) {
      throw new Error("DESKTOP_OPERATION_IN_PROGRESS");
    }
    if (!this.bridge) {
      this.publishUnavailable("DESKTOP_BRIDGE_UNAVAILABLE");
      throw new Error("DESKTOP_BRIDGE_UNAVAILABLE");
    }
    if (this.operationInProgress) {
      throw new Error("DESKTOP_OPERATION_IN_PROGRESS");
    }
    this.operationInProgress = true;
    try {
      await operation(this.bridge);
    } catch (error) {
      this.publishError(stableDesktopError(error, fallbackError));
      throw error;
    } finally {
      this.operationInProgress = false;
    }
  }

  private publishAgentSnapshot(snapshot: DesktopAgentSnapshot): void {
    this.snapshot = Object.freeze({ ...snapshot, appVersion: this.snapshot.appVersion });
    this.onSnapshot?.(this.snapshot);
  }

  private publishError(errorCode: string): void {
    this.snapshot = Object.freeze({ ...this.snapshot, errorCode });
    this.onSnapshot?.(this.snapshot);
  }

  private publishUnavailable(errorCode: string): void {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      state: "unavailable",
      errorCode,
    });
    this.onSnapshot?.(this.snapshot);
  }

  private requireActive(): void {
    if (this.disposed) {
      throw new Error("DESKTOP_CONTROLLER_DISPOSED");
    }
  }
}

const ALLOWED_ERROR_CODES = new Set([
  "ACTIVATION_CODE_INVALID",
  "ACTIVATION_CONFIGURATION_REQUIRED",
  "ACTIVATION_RESPONSE_INVALID",
  "AGENT_ALREADY_STARTED",
  "AGENT_CONFIGURATION_REQUIRED",
  "AGENT_RUNTIME_UNAVAILABLE",
  "AGENT_START_FAILED",
  "CONTROL_CHANNEL_CLOSED",
  "SECURE_STORAGE_DATA_INVALID",
  "SECURE_STORAGE_READ_FAILED",
  "SECURE_STORAGE_UNAVAILABLE",
  "SECURE_STORAGE_WRITE_FAILED",
]);

function stableDesktopError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) {
    return fallback;
  }
  const candidates = error.message.match(/[A-Z][A-Z0-9_]{2,95}/g) ?? [];
  for (const candidate of candidates.reverse()) {
    if (
      ALLOWED_ERROR_CODES.has(candidate) ||
      /^ACTIVATION_REQUEST_FAILED_[0-9]{3}$/.test(candidate)
    ) {
      return candidate;
    }
  }
  return fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
