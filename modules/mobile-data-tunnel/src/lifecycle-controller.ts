export type ForegroundAppState = "active" | "inactive" | "background" | "unknown";

export interface ForegroundLifecycleController {
  setDesiredRunning(desired: boolean): Promise<void>;
  handleAppState(nextState: ForegroundAppState): Promise<void>;
  dispose(): Promise<void>;
}

export interface MobileTunnelLifecycleCommands {
  start(): Promise<unknown>;
  stop(
    reason: "USER_REQUESTED" | "MOBILE_APP_BACKGROUND" | "APP_CONTEXT_DESTROYED",
  ): Promise<unknown>;
}

export function createForegroundLifecycleController(
  tunnel: MobileTunnelLifecycleCommands,
  initialAppState: ForegroundAppState,
): ForegroundLifecycleController {
  let desiredRunning = false;
  let appState = initialAppState;
  let disposed = false;
  let running = false;
  let operation = Promise.resolve();

  const reconcile = () => {
    const shouldRun = !disposed && desiredRunning && appState === "active";
    const stopReason = disposed
      ? "APP_CONTEXT_DESTROYED"
      : appState === "active"
        ? "USER_REQUESTED"
        : "MOBILE_APP_BACKGROUND";
    operation = operation
      .catch(() => undefined)
      .then(async () => {
        if (shouldRun === running) {
          return;
        }
        if (shouldRun) {
          await tunnel.start();
          running = true;
          return;
        }
        await tunnel.stop(stopReason);
        running = false;
      });
    return operation;
  };

  return {
    async setDesiredRunning(desired: boolean) {
      if (disposed) {
        return;
      }
      desiredRunning = desired;
      await reconcile();
    },
    async handleAppState(nextState: ForegroundAppState) {
      if (disposed) {
        return;
      }
      appState = nextState;
      await reconcile();
    },
    async dispose() {
      disposed = true;
      await reconcile();
    },
  };
}
