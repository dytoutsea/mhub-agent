# Native Module Boundary

The Android/iOS foreground data-channel Expo Native Module will live here after the SDK feasibility gate and protocol ownership are resolved.

The module will accept bounded connection commands and emit sanitized state/counter events. Target TCP bytes and data-WebSocket binary frames must remain entirely in Kotlin/Swift and must never cross the React Native JS Bridge.
