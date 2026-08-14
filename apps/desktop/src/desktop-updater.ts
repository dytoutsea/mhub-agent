import { autoUpdater } from "electron-updater";

import { type UpdateSnapshot, updateSnapshotSchema } from "./contracts";

const UPDATE_ERROR_CODES = new Set([
  "UPDATE_NOT_CONFIGURED",
  "UPDATE_UNSUPPORTED",
  "UPDATE_CHECK_FAILED",
  "UPDATE_DOWNLOAD_FAILED",
  "UPDATE_INSTALL_FAILED",
  "UPDATE_ALREADY_RUNNING",
]);

export interface DesktopUpdaterOptions {
  readonly enabled: boolean;
  readonly currentVersion: string;
  readonly feedUrl?: string;
  readonly onSnapshot?: (snapshot: UpdateSnapshot) => void;
}

export class DesktopUpdater {
  private snapshot: UpdateSnapshot;
  private configured = false;
  private operation: "check" | "download" | null = null;

  constructor(private readonly options: DesktopUpdaterOptions) {
    this.snapshot = updateSnapshotSchema.parse({
      state: "idle",
      currentVersion: options.currentVersion,
      availableVersion: null,
      downloadPercent: null,
      errorCode: null,
    });
    if (!options.enabled) {
      this.setError("UPDATE_UNSUPPORTED");
      return;
    }
    const feedUrl = normalizeFeedUrl(options.feedUrl);
    if (!feedUrl) {
      this.setError("UPDATE_NOT_CONFIGURED");
      return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    this.configured = true;
    this.snapshot = updateSnapshotSchema.parse({
      ...this.snapshot,
      currentVersion: autoUpdater.currentVersion.version,
      errorCode: null,
    });
    autoUpdater.on("checking-for-update", () => this.setState("checking"));
    autoUpdater.on("update-available", (info) =>
      this.update({
        state: "available",
        availableVersion: boundedVersion(info.version),
        downloadPercent: null,
        errorCode: null,
      }),
    );
    autoUpdater.on("update-not-available", () =>
      this.update({
        state: "not-available",
        availableVersion: null,
        downloadPercent: null,
        errorCode: null,
      }),
    );
    autoUpdater.on("download-progress", (progress) =>
      this.update({
        state: "downloading",
        downloadPercent: Math.max(0, Math.min(100, Math.round(progress.percent * 100) / 100)),
        errorCode: null,
      }),
    );
    autoUpdater.on("update-downloaded", (info) =>
      this.update({
        state: "downloaded",
        availableVersion: boundedVersion(info.version),
        downloadPercent: 100,
        errorCode: null,
      }),
    );
    autoUpdater.on("error", (error) => {
      const operation = this.operation;
      this.operation = null;
      this.setError(
        operation === "download" ? "UPDATE_DOWNLOAD_FAILED" : "UPDATE_CHECK_FAILED",
        error,
      );
    });
  }

  getSnapshot(): UpdateSnapshot {
    return this.snapshot;
  }

  async check(): Promise<UpdateSnapshot> {
    this.requireConfigured();
    this.requireIdle();
    this.operation = "check";
    this.setState("checking");
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.operation = null;
      this.setError("UPDATE_CHECK_FAILED", error);
    }
    this.operation = null;
    return this.snapshot;
  }

  async download(): Promise<UpdateSnapshot> {
    this.requireConfigured();
    this.requireIdle();
    if (this.snapshot.state !== "available") {
      return this.snapshot;
    }
    this.operation = "download";
    this.update({ state: "downloading", downloadPercent: 0, errorCode: null });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.operation = null;
      this.setError("UPDATE_DOWNLOAD_FAILED", error);
    }
    this.operation = null;
    return this.snapshot;
  }

  install(): UpdateSnapshot {
    this.requireConfigured();
    if (this.snapshot.state !== "downloaded") {
      return this.snapshot;
    }
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      this.setError("UPDATE_INSTALL_FAILED", error);
    }
    return this.snapshot;
  }

  private requireConfigured(): void {
    if (!this.configured) {
      throw new Error(this.snapshot.errorCode ?? "UPDATE_NOT_CONFIGURED");
    }
  }

  private requireIdle(): void {
    if (this.operation) {
      throw new Error("UPDATE_ALREADY_RUNNING");
    }
  }

  private setState(state: UpdateSnapshot["state"]): void {
    this.update({ state, errorCode: null });
  }

  private setError(code: string, _error?: unknown): void {
    this.update({
      state: "error",
      errorCode: UPDATE_ERROR_CODES.has(code) ? code : "UPDATE_CHECK_FAILED",
      downloadPercent: null,
    });
  }

  private update(patch: Partial<UpdateSnapshot>): void {
    this.snapshot = updateSnapshotSchema.parse({ ...this.snapshot, ...patch });
    this.options.onSnapshot?.(this.snapshot);
  }
}

function normalizeFeedUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

function boundedVersion(value: unknown): string | null {
  return typeof value === "string" && /^[0-9A-Za-z.+-]{1,32}$/.test(value) ? value : null;
}
