import { chmod, readFile, rename, writeFile } from "node:fs/promises";

export interface DesktopPreferences {
  readonly runAtLogin: boolean;
}

export interface DesktopPreferencesStore {
  read(): Promise<DesktopPreferences>;
  write(value: DesktopPreferences): Promise<void>;
}

export class FileDesktopPreferencesStore implements DesktopPreferencesStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<DesktopPreferences> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return isObject(value) && typeof value.runAtLogin === "boolean"
        ? { runAtLogin: value.runAtLogin }
        : { runAtLogin: false };
    } catch {
      return { runAtLogin: false };
    }
  }

  async write(value: DesktopPreferences): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.filePath);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
