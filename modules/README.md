# Native Module Boundary

`mobile-data-tunnel` owns the Android/iOS foreground data-channel boundary. The
module source and its Expo config plugin are versioned; Expo CNG generates
`apps/mobile/android` and `apps/mobile/ios`, which remain ignored.

The JavaScript API contains only bounded lifecycle commands and sanitized
state/counter events. Target TCP bytes and data-WebSocket binary frames must
remain entirely in Kotlin/Swift and must never cross the React Native bridge.

The config plugin fails generation if Android foreground-service permissions,
iOS background modes, or Network Extension entitlements are introduced. CI is
expected to run Expo prebuild and inspect the generated manifests before a
mobile release.
