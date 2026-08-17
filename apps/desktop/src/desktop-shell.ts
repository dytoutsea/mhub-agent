import type { NativeImage } from "electron";

export interface DesktopWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export function revealDesktopWindow(window: DesktopWindow | null, createWindow: () => void): void {
  if (!window || window.isDestroyed()) {
    createWindow();
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

export function prepareTrayIcon(
  source: NativeImage,
  platform: NodeJS.Platform,
): NativeImage | null {
  if (source.isEmpty()) {
    return null;
  }
  if (platform !== "darwin") {
    return source;
  }
  const icon = source.resize({ width: 18, height: 18, quality: "best" });
  if (icon.isEmpty()) {
    return null;
  }
  icon.setTemplateImage(true);
  return icon;
}
