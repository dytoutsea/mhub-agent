import { describe, expect, it, vi } from "vitest";

import { createForegroundLifecycleController } from "./lifecycle-controller";

describe("foreground mobile tunnel lifecycle", () => {
  it("stops on inactive and resumes only when the user still wants it running", async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const controller = createForegroundLifecycleController({ start, stop }, "active");

    await controller.setDesiredRunning(true);
    await controller.handleAppState("inactive");
    await controller.handleAppState("background");
    await controller.handleAppState("active");

    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("MOBILE_APP_BACKGROUND");
  });

  it("does not resume after an explicit stop while backgrounded", async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const controller = createForegroundLifecycleController({ start, stop }, "active");

    await controller.setDesiredRunning(true);
    await controller.handleAppState("background");
    await controller.setDesiredRunning(false);
    await controller.handleAppState("active");

    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("serializes racing lifecycle transitions and closes during disposal", async () => {
    const calls: string[] = [];
    const controller = createForegroundLifecycleController(
      {
        start: async () => {
          calls.push("start");
        },
        stop: async (reason) => {
          calls.push(`stop:${reason}`);
        },
      },
      "active",
    );

    await controller.setDesiredRunning(true);
    await Promise.all([
      controller.handleAppState("background"),
      controller.handleAppState("active"),
    ]);
    await controller.dispose();

    expect(calls).toEqual([
      "start",
      "stop:MOBILE_APP_BACKGROUND",
      "start",
      "stop:APP_CONTEXT_DESTROYED",
    ]);
  });

  it("recovers the lifecycle queue after a native command fails", async () => {
    const start = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("MOBILE_DATA_TUNNEL_REQUIRES_FOREGROUND"))
      .mockResolvedValue(undefined);
    const stop = vi.fn(async () => undefined);
    const controller = createForegroundLifecycleController({ start, stop }, "active");

    await expect(controller.setDesiredRunning(true)).rejects.toThrow(
      "MOBILE_DATA_TUNNEL_REQUIRES_FOREGROUND",
    );
    await controller.handleAppState("background");
    await controller.handleAppState("active");

    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).not.toHaveBeenCalled();
  });

  it("can restart after the runtime reports an independent stop", async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const controller = createForegroundLifecycleController({ start, stop }, "active");

    await controller.setDesiredRunning(true);
    controller.runtimeStopped();
    await controller.handleAppState("background");
    await controller.handleAppState("active");
    expect(start).toHaveBeenCalledTimes(1);
    await controller.setDesiredRunning(true);

    expect(start).toHaveBeenCalledTimes(2);
  });
});
