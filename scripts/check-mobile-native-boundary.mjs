import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import expoPlist from "@expo/plist";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, "apps/mobile/android/app/src/main/AndroidManifest.xml");
const secureStoreAndroidRoot = resolve(
  root,
  "node_modules/expo-secure-store/android/src/main/res/xml",
);
const iosRoot = resolve(root, "apps/mobile/ios");
const iosProjectDirectory = readdirSync(iosRoot, { withFileTypes: true }).find(
  (entry) => entry.isDirectory() && !entry.name.endsWith(".xcodeproj") && entry.name !== "Pods",
);
if (!iosProjectDirectory) {
  throw new Error("Mobile native boundary check could not locate the generated iOS project");
}
const iosProjectRoot = resolve(iosRoot, iosProjectDirectory.name);
const iosTunnelSource = readFileSync(
  resolve(root, "modules/mobile-data-tunnel/ios/IOSDataStream.swift"),
  "utf8",
);
const iosTunnelModule = readFileSync(
  resolve(root, "modules/mobile-data-tunnel/ios/MHubMobileDataTunnelModule.swift"),
  "utf8",
);
const infoPlistPath = resolve(iosProjectRoot, "Info.plist");
const entitlementFiles = readdirSync(iosProjectRoot).filter((name) =>
  name.endsWith(".entitlements"),
);

const manifest = readFileSync(manifestPath, "utf8");
const secureStoreBackupRules = readFileSync(
  resolve(secureStoreAndroidRoot, "secure_store_backup_rules.xml"),
  "utf8",
);
const secureStoreExtractionRules = readFileSync(
  resolve(secureStoreAndroidRoot, "secure_store_data_extraction_rules.xml"),
  "utf8",
);
const infoPlist = readFileSync(infoPlistPath, "utf8");
const parsedInfoPlist = expoPlist.default.parse(infoPlist);
const allowInsecureDevelopmentEndpoints =
  process.env.EXPO_PUBLIC_MHUB_RELEASE_CHANNEL?.trim() === "dev";
const entitlements = entitlementFiles
  .map((name) => readFileSync(resolve(iosProjectRoot, name), "utf8"))
  .join("\n");
const requestedAndroidPermissions = new Set(
  [...manifest.matchAll(/<uses-permission\b([^>]*)\/?\s*>/g)]
    .filter((match) => !match[1]?.includes('tools:node="remove"'))
    .map((match) => match[1]?.match(/android:name="([^"]+)"/)?.[1])
    .filter((permission) => permission !== undefined),
);

const forbiddenAndroid = [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
  "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
  "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  "android.permission.WAKE_LOCK",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.VIBRATE",
];

const failures = [];
for (const permission of forbiddenAndroid) {
  if (requestedAndroidPermissions.has(permission)) {
    failures.push(`forbidden Android permission: ${permission}`);
  }
}
if (!requestedAndroidPermissions.has("android.permission.INTERNET")) {
  failures.push("missing Android INTERNET permission");
}
const expectedCleartextValue = allowInsecureDevelopmentEndpoints ? "true" : "false";
if (!manifest.includes(`android:usesCleartextTraffic="${expectedCleartextValue}"`)) {
  failures.push("Android cleartext policy does not match the release channel");
}
if (/<service\b/.test(manifest)) {
  failures.push("Android services are outside the foreground-only MVP boundary");
}
if (
  !manifest.includes('android:fullBackupContent="@xml/secure_store_backup_rules"') ||
  !manifest.includes('android:dataExtractionRules="@xml/secure_store_data_extraction_rules"') ||
  !secureStoreBackupRules.includes('<exclude domain="sharedpref" path="SecureStore"') ||
  !secureStoreExtractionRules.includes('<exclude domain="sharedpref" path="SecureStore"')
) {
  failures.push("Android SecureStore must remain excluded from backup and device transfer");
}
if (infoPlist.includes("UIBackgroundModes")) {
  failures.push("forbidden iOS UIBackgroundModes");
}
if (
  parsedInfoPlist.NSAppTransportSecurity?.NSAllowsArbitraryLoads !==
  allowInsecureDevelopmentEndpoints
) {
  failures.push("iOS transport security policy does not match the release channel");
}
if (entitlements.includes("com.apple.developer.networking.networkextension")) {
  failures.push("forbidden iOS Network Extension entitlement");
}
if (
  !iosTunnelSource.includes("URLSessionWebSocketTask") ||
  !iosTunnelSource.includes("NWConnection") ||
  iosTunnelModule.includes("MOBILE_DATA_TUNNEL_STREAMS_NOT_IMPLEMENTED")
) {
  failures.push("iOS foreground native data stream implementation is missing");
}
if (
  readdirSync(iosProjectRoot, { recursive: true }).some((path) => String(path).endsWith(".appex"))
) {
  failures.push("iOS app extensions are outside the foreground-only MVP boundary");
}

if (failures.length > 0) {
  throw new Error(`Mobile native boundary check failed:\n${failures.join("\n")}`);
}

console.log("Mobile native boundary check passed");
