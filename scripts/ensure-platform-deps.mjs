import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const rollupPackage = JSON.parse(readFileSync(require.resolve("rollup/package.json"), "utf8"));
const nativePackage = resolveRollupNativePackage(process.platform, process.arch);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "mhub-rollup-native-"));
const packagePath = path.join(...nativePackage.split("/"));
const temporaryPackageDirectory = path.join(temporaryDirectory, "node_modules", packagePath);
const localPackageDirectory = path.join(process.cwd(), "node_modules", packagePath);

try {
  writeFileSync(
    path.join(temporaryDirectory, "package.json"),
    JSON.stringify({ private: true, version: "0.0.0" }),
  );
  execFileSync(
    npmCommand,
    [
      "install",
      "--prefix",
      temporaryDirectory,
      "--ignore-scripts",
      "--no-save",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      `${nativePackage}@${rollupPackage.version}`,
    ],
    { stdio: "inherit" },
  );
  mkdirSync(path.dirname(localPackageDirectory), { recursive: true });
  cpSync(temporaryPackageDirectory, localPackageDirectory, { recursive: true });
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function resolveRollupNativePackage(platform, arch) {
  if (platform === "darwin") {
    if (arch === "arm64") {
      return "@rollup/rollup-darwin-arm64";
    }
    if (arch === "x64") {
      return "@rollup/rollup-darwin-x64";
    }
  }
  if (platform === "win32") {
    if (arch === "arm64") {
      return "@rollup/rollup-win32-arm64-msvc";
    }
    if (arch === "x64") {
      return "@rollup/rollup-win32-x64-msvc";
    }
    if (arch === "ia32") {
      return "@rollup/rollup-win32-ia32-msvc";
    }
  }
  if (platform === "linux") {
    if (arch === "arm64") {
      return "@rollup/rollup-linux-arm64-gnu";
    }
    if (arch === "x64") {
      return "@rollup/rollup-linux-x64-gnu";
    }
  }
  throw new Error(`Unsupported Rollup platform: ${platform}/${arch}`);
}
