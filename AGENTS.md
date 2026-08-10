# MHub Agent Repository Guidelines

## Scope

This repository owns the MHub client applications: shared Expo UI, the Windows/macOS Electron host, platform-independent client state, and the Android/iOS foreground native data-channel modules. The workspace-root `AGENTS.md` also applies and remains authoritative for security, deployment authorization, memory ownership, and repository boundaries.

Control-plane facts stay in `mhub-server`; relay payload forwarding stays in `mhub-relay`. Cross-repository behavior must follow `architecture/CONTRACTS.md` and accepted protocol/API schemas.

## Repository Structure

- `apps/mobile`: Expo application and shared Expo Web renderer.
- `apps/desktop`: Electron Main and preload processes; it loads the exported Expo Web UI.
- `packages/shared`: platform-independent types and behavior with no Electron or React Native dependency.
- Native Android/iOS tunnel code belongs behind an Expo Native Module boundary when that work starts.

Keep the renderer portable. Node, Electron, filesystem, credential-store, raw socket, and updater APIs must not leak into Expo UI or shared packages.

## Required Gates

- Use the repository-pinned Node/npm versions when available.
- `npm run verify` is the full local verification gate.
- Run `npm run expo:check` after changing Expo or React Native dependencies.
- Generated `dist/`, `build/`, coverage, packages, and local signing material must remain untracked.
- `android/` and `ios/` stay untracked during the initial CNG skeleton. Decide and document their ownership before native tunnel implementation; CI must inspect generated permissions and entitlements either way.

Do not declare implementation started or add an authoritative relay protocol schema until the initiative's SDK feasibility and schema-ownership gates are resolved.

## Desktop Security

- Keep `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`.
- Preload exposes a narrow, versioned API. Validate all IPC inputs and outputs at runtime.
- Never load a remote production renderer. Production loads only bundled local content.
- Validate external-link schemes and open only approved `https` URLs in the system browser.
- Electron Main owns AgentRuntime, sockets, secure storage, tray, lifecycle, and update behavior.

## Mobile Boundary

- Android/iOS MVP operation is foreground-only.
- Entering inactive/background state must stop new streams, drain or close existing streams, and make the relay session offline.
- Do not add Android Foreground Service, background keepalive permissions, iOS background-mode workarounds, or Network Extension entitlements in MVP.
- Binary application traffic must remain inside Kotlin/Swift native data-channel code and must never cross the React Native JS Bridge. JS may receive only bounded commands, state, counters, and sanitized errors.

## Secrets And Logs

- Store device credentials only in Windows Credential Manager/DPAPI, macOS Keychain, Android Keystore, or iOS Keychain through an approved adapter.
- Never log or commit activation codes, refresh credentials, device private keys, session tickets, one-time connection tokens, SOCKS5 credentials, or complete proxy URIs.
- Keep diagnostics bounded and redact before export. Do not persist or inspect forwarded payloads.
- Local `.env*`, signing files, certificates, provisioning profiles, and keychain exports must remain ignored.

## Coding Style

Use TypeScript with strict checking and Biome for formatting/linting. Prefer immutable data, explicit lifecycle ownership, exhaustive state handling, and small platform adapters. Tests live beside their package under `src/**/*.test.ts`. Do not add an abstraction unless it protects a real platform/security boundary or removes meaningful duplication.
