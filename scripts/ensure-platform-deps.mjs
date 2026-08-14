import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const rollupPackage = JSON.parse(readFileSync(require.resolve("rollup/package.json"), "utf8"));
const nativePackage = resolveRollupNativePackage(process.platform, process.arch);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packagePath = path.join(...nativePackage.split("/"));
const localPackageDirectory = path.join(process.cwd(), "node_modules", packagePath);

if (!existsSync(path.join(localPackageDirectory, "package.json"))) {
  execFileSync(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-save",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      `${nativePackage}@${rollupPackage.version}`,
    ],
    { stdio: "inherit" },
  );
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
