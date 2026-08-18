const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withEntitlementsPlist,
  withInfoPlist,
} = require("expo/config-plugins");

const packageJson = require("./package.json");

const FORBIDDEN_ANDROID_PERMISSIONS = new Set([
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
  "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
  "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
  "android.permission.WAKE_LOCK",
]);

function withMHubMobileDataTunnel(config) {
  const allowInsecureDevelopmentEndpoints =
    process.env.EXPO_PUBLIC_MHUB_RELEASE_CHANNEL?.trim() === "dev";
  config = withAndroidManifest(config, (configWithManifest) => {
    const manifest = configWithManifest.modResults.manifest;
    const permissions = manifest["uses-permission"] ?? [];
    for (const permission of permissions) {
      const name = permission.$?.["android:name"];
      if (name && FORBIDDEN_ANDROID_PERMISSIONS.has(name)) {
        throw new Error(`MHub mobile MVP forbids Android permission: ${name}`);
      }
    }
    AndroidConfig.Permissions.ensurePermission(
      configWithManifest.modResults,
      "android.permission.INTERNET",
    );
    const application = manifest.application?.[0];
    if (!application?.$) {
      throw new Error("MHub mobile plugin could not locate the Android application manifest");
    }
    application.$["android:usesCleartextTraffic"] = allowInsecureDevelopmentEndpoints
      ? "true"
      : "false";
    return configWithManifest;
  });

  config = withInfoPlist(config, (configWithPlist) => {
    const backgroundModes = configWithPlist.modResults.UIBackgroundModes;
    if (Array.isArray(backgroundModes) && backgroundModes.length > 0) {
      throw new Error("MHub mobile MVP forbids iOS UIBackgroundModes");
    }
    const transportSecurity = configWithPlist.modResults.NSAppTransportSecurity;
    configWithPlist.modResults.NSAppTransportSecurity = {
      ...(transportSecurity && typeof transportSecurity === "object" ? transportSecurity : {}),
      NSAllowsArbitraryLoads: allowInsecureDevelopmentEndpoints,
      NSAllowsLocalNetworking: true,
    };
    return configWithPlist;
  });

  return withEntitlementsPlist(config, (configWithEntitlements) => {
    const entitlements = configWithEntitlements.modResults;
    if (entitlements["com.apple.developer.networking.networkextension"] !== undefined) {
      throw new Error("MHub mobile MVP forbids iOS Network Extension entitlements");
    }
    return configWithEntitlements;
  });
}

module.exports = createRunOncePlugin(
  withMHubMobileDataTunnel,
  packageJson.name,
  packageJson.version,
);
