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
    return configWithManifest;
  });

  config = withInfoPlist(config, (configWithPlist) => {
    const backgroundModes = configWithPlist.modResults.UIBackgroundModes;
    if (Array.isArray(backgroundModes) && backgroundModes.length > 0) {
      throw new Error("MHub mobile MVP forbids iOS UIBackgroundModes");
    }
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
