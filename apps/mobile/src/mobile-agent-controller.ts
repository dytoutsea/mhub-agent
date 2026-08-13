import {
  createForegroundLifecycleController,
  type ForegroundAppState,
} from "@mhub/mobile-data-tunnel/lifecycle-controller";
import type {
  MobileAgentRegistration,
  MobileRuntimeSnapshot,
  SessionTicketProvider,
} from "@mhub/mobile-runtime";

export type MobileAgentViewState =
  | "loading"
  | "unregistered"
  | "stopped"
  | "connecting"
  | "online"
  | "backoff"
  | "unavailable";

export interface MobileAgentControllerSnapshot {
  readonly state: MobileAgentViewState;
  readonly registration: MobileAgentRegistration | null;
  readonly activeStreams: number;
  readonly connectedAt: string | null;
  readonly errorCode: string | null;
}

export interface MobileIdentityManager {
  loadRegistration(): Promise<MobileAgentRegistration | null>;
  activate(activationCode: string): Promise<MobileAgentRegistration>;
  createTicketProvider(): SessionTicketProvider;
  clear(): Promise<void>;
}

export interface MobileRuntime {
  start(): Promise<void>;
  stop(
    reason?: "USER_REQUESTED" | "MOBILE_APP_BACKGROUND" | "APP_CONTEXT_DESTROYED",
  ): Promise<void>;
  getSnapshot(): MobileRuntimeSnapshot;
}

export interface MobileAgentControllerOptions {
  readonly identity: MobileIdentityManager;
  readonly initialAppState: ForegroundAppState;
  readonly createRuntime: (
    registration: MobileAgentRegistration,
    ticketProvider: SessionTicketProvider,
    onSnapshot: (snapshot: MobileRuntimeSnapshot) => void,
  ) => MobileRuntime;
  readonly onSnapshot?: (snapshot: MobileAgentControllerSnapshot) => void;
}

export class MobileAgentController {
  private runtime: MobileRuntime | null = null;
  private lifecycle: ReturnType<typeof createForegroundLifecycleController> | null = null;
  private disposed = false;
  private appState: ForegroundAppState;
  private lifecycleStopInProgress = false;
  private snapshot: MobileAgentControllerSnapshot = Object.freeze({
    state: "loading",
    registration: null,
    activeStreams: 0,
    connectedAt: null,
    errorCode: null,
  });

  constructor(private readonly options: MobileAgentControllerOptions) {
    this.appState = options.initialAppState;
  }

  getSnapshot(): MobileAgentControllerSnapshot {
    return this.snapshot;
  }

  async initialize(): Promise<void> {
    this.requireActive();
    try {
      const registration = await this.options.identity.loadRegistration();
      if (this.disposed) {
        return;
      }
      if (!registration) {
        this.publish("unregistered", null, null);
        return;
      }
      await this.installRegistration(registration);
    } catch (error) {
      if (!this.disposed) {
        this.publish("unavailable", null, stableError(error));
      }
    }
  }

  async activate(activationCode: string): Promise<void> {
    this.requireActive();
    if (this.snapshot.state !== "unregistered") {
      throw new Error("MOBILE_AGENT_ACTIVATION_NOT_READY");
    }
    try {
      const registration = await this.options.identity.activate(activationCode);
      if (!this.disposed) {
        await this.installRegistration(registration);
      }
    } catch (error) {
      if (!this.disposed) {
        this.publish(this.snapshot.state, this.snapshot.registration, stableError(error));
      }
      throw error;
    }
  }

  async start(): Promise<void> {
    this.requireActive();
    if (!this.lifecycle) {
      throw new Error("MOBILE_AGENT_NOT_ACTIVATED");
    }
    await this.lifecycle.setDesiredRunning(true);
  }

  async stop(): Promise<void> {
    if (!this.lifecycle || this.disposed) {
      return;
    }
    await this.lifecycle.setDesiredRunning(false);
  }

  async handleAppState(state: ForegroundAppState): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.appState = state;
    if (!this.lifecycle) {
      return;
    }
    await this.lifecycle.handleAppState(state);
  }

  async resetIdentity(): Promise<void> {
    this.requireActive();
    await this.lifecycle?.dispose();
    this.lifecycle = null;
    this.runtime = null;
    await this.options.identity.clear();
    this.publish("unregistered", null, null);
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.lifecycle?.dispose();
    this.lifecycle = null;
    this.runtime = null;
  }

  private async installRegistration(registration: MobileAgentRegistration): Promise<void> {
    await this.lifecycle?.dispose();
    const runtime = this.options.createRuntime(
      registration,
      this.options.identity.createTicketProvider(),
      (snapshot) => this.handleRuntimeSnapshot(runtime, snapshot),
    );
    this.runtime = runtime;
    this.lifecycle = createForegroundLifecycleController(
      {
        start: () => runtime.start(),
        stop: async (reason) => {
          this.lifecycleStopInProgress = true;
          try {
            await runtime.stop(reason);
          } finally {
            this.lifecycleStopInProgress = false;
          }
        },
      },
      this.appState,
    );
    this.publish("stopped", registration, null);
  }

  private handleRuntimeSnapshot(runtime: MobileRuntime, snapshot: MobileRuntimeSnapshot): void {
    if (this.disposed || this.runtime !== runtime) {
      return;
    }
    if (snapshot.state === "stopped" && !this.lifecycleStopInProgress) {
      this.lifecycle?.runtimeStopped();
    }
    this.snapshot = Object.freeze({
      state: snapshot.state,
      registration: this.snapshot.registration,
      activeStreams: snapshot.activeStreams,
      connectedAt: snapshot.connectedAt,
      errorCode: snapshot.errorCode,
    });
    this.options.onSnapshot?.(this.snapshot);
  }

  private publish(
    state: MobileAgentViewState,
    registration: MobileAgentRegistration | null,
    errorCode: string | null,
  ): void {
    this.snapshot = Object.freeze({
      state,
      registration,
      activeStreams: 0,
      connectedAt: null,
      errorCode,
    });
    this.options.onSnapshot?.(this.snapshot);
  }

  private requireActive(): void {
    if (this.disposed) {
      throw new Error("MOBILE_AGENT_CONTROLLER_DISPOSED");
    }
  }
}

function stableError(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) && error.message.length <= 64) {
    return error.message;
  }
  return "MOBILE_AGENT_FAILED";
}
