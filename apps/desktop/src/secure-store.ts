import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { safeStorage } from "electron";

export interface SecretStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

export class SafeStorageSecretStore implements SecretStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<string | null> {
    assertAvailable();
    try {
      const encrypted = await readFile(this.filePath, "utf8");
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch (error) {
      if (isMissingFile(error)) {
        return null;
      }
      throw new Error("SECURE_STORAGE_READ_FAILED");
    }
  }

  async write(value: string): Promise<void> {
    assertAvailable();
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const encrypted = safeStorage.encryptString(value).toString("base64");
      await writeFile(temporaryPath, encrypted, { encoding: "utf8", mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch {
      throw new Error("SECURE_STORAGE_WRITE_FAILED");
    }
  }

  async clear(): Promise<void> {
    assertAvailable();
    try {
      await unlink(this.filePath);
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error("SECURE_STORAGE_CLEAR_FAILED");
      }
    }
  }
}

function assertAvailable() {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("SECURE_STORAGE_UNAVAILABLE");
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
