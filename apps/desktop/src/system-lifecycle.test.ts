import { describe, expect, it, vi } from "vitest";

import type { DesktopPreferences, DesktopPreferencesStore } from "./desktop-preferences";
import { type DesktopLifecycleRuntime, DesktopSystemLifecycle } from "./system-lifecycle";

describe("DesktopSystemLifecycle", () => {
  it("restores persisted run intent and login startup", async () => {
    const harness = createHarness(true);

    await harness.lifecycle.initialize();

    expect(harness.applyLoginItem).toHaveBeenCalledWith(true);
    expect(harness.runtime.start).toHaveBeenCalledOnce();
  });

  it("pauses for sleep and resumes only while user run intent remains active", async () => {
    const harness = createHarness(false);
    await harness.lifecycle.initialize();
    await harness.lifecycle.requestStart();

    await harness.lifecycle.suspend();
    expect(harness.runtime.pause).toHaveBeenCalledWith("SYSTEM_SUSPENDED");
    await harness.lifecycle.resume();
    expect(harness.runtime.start).toHaveBeenCalledTimes(2);

    await harness.lifecycle.requestStop();
    await harness.lifecycle.suspend();
    await harness.lifecycle.resume();
    expect(harness.runtime.start).toHaveBeenCalledTimes(2);
    expect(harness.store.value).toEqual({ runAtLogin: false });
    expect(harness.applyLoginItem).toHaveBeenLastCalledWith(false);
  });

  it("waits for network recovery before starting", async () => {
    const harness = createHarness(false, false);
    await harness.lifecycle.initialize();
    await harness.lifecycle.requestStart();

    expect(harness.runtime.start).not.toHaveBeenCalled();
    await harness.lifecycle.networkChanged(true);

    expect(harness.runtime.start).toHaveBeenCalledOnce();
  });
});

function createHarness(initialIntent: boolean, initiallyOnline = true) {
  const store = new MemoryPreferencesStore({ runAtLogin: initialIntent });
  let state = "stopped";
  const runtime: DesktopLifecycleRuntime = {
    getSnapshot: () => ({ state }),
    start: vi.fn(async () => {
      state = "online";
    }),
    stop: vi.fn(async () => {
      state = "stopped";
    }),
    pause: vi.fn(async () => {
      state = "paused";
    }),
  };
  const applyLoginItem = vi.fn();
  const lifecycle = new DesktopSystemLifecycle({
    runtime: () => runtime,
    preferences: store,
    applyLoginItem,
    isOnline: () => initiallyOnline,
  });
  return { lifecycle, runtime, store, applyLoginItem };
}

class MemoryPreferencesStore implements DesktopPreferencesStore {
  constructor(public value: DesktopPreferences) {}

  async read(): Promise<DesktopPreferences> {
    return this.value;
  }

  async write(value: DesktopPreferences): Promise<void> {
    this.value = value;
  }
}
