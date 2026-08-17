import type { NativeImage } from "electron";
import { describe, expect, it, vi } from "vitest";

import { type DesktopWindow, prepareTrayIcon, revealDesktopWindow } from "./desktop-shell";

describe("desktop shell", () => {
  it("shows and focuses an existing hidden window", () => {
    const window = desktopWindow();
    const createWindow = vi.fn();

    revealDesktopWindow(window, createWindow);

    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("restores a minimized window and recreates a destroyed window", () => {
    const minimized = desktopWindow({ minimized: true });
    revealDesktopWindow(minimized, vi.fn());
    expect(minimized.restore).toHaveBeenCalledOnce();

    const createWindow = vi.fn();
    revealDesktopWindow(desktopWindow({ destroyed: true }), createWindow);
    expect(createWindow).toHaveBeenCalledOnce();
  });

  it("creates an 18 pixel macOS template tray icon", () => {
    const resized = trayImage();
    const source = trayImage({ resized: resized.image });

    expect(prepareTrayIcon(source.image, "darwin")).toBe(resized.image);
    expect(source.resize).toHaveBeenCalledWith({ width: 18, height: 18, quality: "best" });
    expect(resized.setTemplateImage).toHaveBeenCalledWith(true);
  });

  it("rejects empty tray icons and leaves Windows icons unchanged", () => {
    expect(prepareTrayIcon(trayImage({ empty: true }).image, "darwin")).toBeNull();
    const windowsIcon = trayImage();
    expect(prepareTrayIcon(windowsIcon.image, "win32")).toBe(windowsIcon.image);
    expect(windowsIcon.resize).not.toHaveBeenCalled();
  });
});

function desktopWindow(options: { destroyed?: boolean; minimized?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    isMinimized: vi.fn(() => options.minimized ?? false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  } satisfies DesktopWindow;
}

function trayImage(options: { empty?: boolean; resized?: NativeImage } = {}) {
  const isEmpty = vi.fn(() => options.empty ?? false);
  const resize = vi.fn<NativeImage["resize"]>();
  const setTemplateImage = vi.fn<NativeImage["setTemplateImage"]>();
  const image = { isEmpty, resize, setTemplateImage } as unknown as NativeImage;
  resize.mockImplementation(() => options.resized ?? image);
  return { image, isEmpty, resize, setTemplateImage };
}
