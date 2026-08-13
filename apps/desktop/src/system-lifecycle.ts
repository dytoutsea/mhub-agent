import type { DesktopPreferencesStore } from "./desktop-preferences";

type PauseReason = "network" | "suspend";
type PauseError = "NETWORK_OFFLINE" | "SYSTEM_SUSPENDED";

export interface DesktopLifecycleRuntime {
  getSnapshot(): { readonly state: string };
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  pause(errorCode: PauseError): Promise<unknown>;
}

export interface DesktopSystemLifecycleOptions {
  readonly runtime: () => DesktopLifecycleRuntime | null;
  readonly preferences: DesktopPreferencesStore;
  readonly applyLoginItem: (enabled: boolean) => void;
  readonly isOnline: () => boolean;
}

export class DesktopSystemLifecycle {
  private readonly pauseReasons = new Set<PauseReason>();
  private desiredRunning = false;
  private operations = Promise.resolve();

  constructor(private readonly options: DesktopSystemLifecycleOptions) {}

  initialize(): Promise<void> {
    return this.enqueue(async () => {
      const preferences = await this.options.preferences.read();
      this.desiredRunning = preferences.runAtLogin;
      this.options.applyLoginItem(this.desiredRunning);
      if (!this.options.isOnline()) {
        this.pauseReasons.add("network");
      }
      await this.reconcile();
    });
  }

  requestStart(): Promise<void> {
    return this.enqueue(async () => {
      this.desiredRunning = true;
      await this.persistIntent();
      await this.reconcile();
    });
  }

  requestStop(): Promise<void> {
    return this.enqueue(async () => {
      this.desiredRunning = false;
      await this.persistIntent();
      await this.options.runtime()?.stop();
    });
  }

  suspend(): Promise<void> {
    return this.pause("suspend", "SYSTEM_SUSPENDED");
  }

  resume(): Promise<void> {
    return this.unpause("suspend");
  }

  networkChanged(online: boolean): Promise<void> {
    return online ? this.unpause("network") : this.pause("network", "NETWORK_OFFLINE");
  }

  activated(): Promise<void> {
    return this.enqueue(() => this.reconcile());
  }

  private pause(reason: PauseReason, errorCode: PauseError): Promise<void> {
    return this.enqueue(async () => {
      if (this.pauseReasons.has(reason)) {
        return;
      }
      this.pauseReasons.add(reason);
      if (this.desiredRunning) {
        await this.options.runtime()?.pause(errorCode);
      }
    });
  }

  private unpause(reason: PauseReason): Promise<void> {
    return this.enqueue(async () => {
      this.pauseReasons.delete(reason);
      await this.reconcile();
    });
  }

  private async reconcile(): Promise<void> {
    const runtime = this.options.runtime();
    if (!runtime || !this.desiredRunning || this.pauseReasons.size > 0) {
      return;
    }
    const state = runtime.getSnapshot().state;
    if (state === "stopped" || state === "paused" || state === "degraded") {
      await runtime.start();
    }
  }

  private async persistIntent(): Promise<void> {
    await this.options.preferences.write({ runAtLogin: this.desiredRunning });
    this.options.applyLoginItem(this.desiredRunning);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operations.then(operation, operation);
    this.operations = next.catch(() => undefined);
    return next;
  }
}
