import { mobileDataTunnel } from "@mhub/mobile-data-tunnel";
import {
  MobileAgentIdentityManager,
  type MobileAgentRegistration,
  MobileAgentRuntime,
  type MobileSecretStore,
} from "@mhub/mobile-runtime";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";
import { createEd25519DeviceCrypto } from "./ed25519-device-crypto";
import { MobileAgentController } from "./mobile-agent-controller";
import type { MobilePublicConfiguration } from "./mobile-public-configuration";

const STORE_KEY = "mhub.agent.device-identity.v1";
const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  keychainService: "com.mhub.agent.device-identity.v1",
};

export function createMobileAgentController(
  configuration: MobilePublicConfiguration,
  onSnapshot: ConstructorParameters<typeof MobileAgentController>[0]["onSnapshot"],
): MobileAgentController {
  const platform = mobilePlatform();
  const identity = new MobileAgentIdentityManager({
    ...configuration,
    platform,
    store: secureStore(),
    crypto: createEd25519DeviceCrypto((length) => Crypto.getRandomBytesAsync(length)),
    osVersion: String(Platform.Version),
  });
  return new MobileAgentController({
    identity,
    initialAppState: foregroundState(AppState.currentState),
    createRuntime: (registration: MobileAgentRegistration, ticketProvider, runtimeSnapshot) =>
      new MobileAgentRuntime({
        controlUrl: configuration.controlUrl,
        allowInsecureDevelopmentEndpoints: configuration.allowInsecureDevelopmentEndpoints,
        proxyId: registration.proxyId,
        platform,
        ticketProvider,
        tunnel: mobileDataTunnel,
        onSnapshot: runtimeSnapshot,
      }),
    ...(onSnapshot ? { onSnapshot } : {}),
  });
}

function foregroundState(value: string): "active" | "inactive" | "background" | "unknown" {
  return value === "active" || value === "inactive" || value === "background" ? value : "unknown";
}

function mobilePlatform(): "android" | "ios" {
  if (Platform.OS !== "android" && Platform.OS !== "ios") {
    throw new Error("MOBILE_AGENT_UNSUPPORTED_PLATFORM");
  }
  return Platform.OS;
}

function secureStore(): MobileSecretStore {
  return {
    async read() {
      if (!(await SecureStore.isAvailableAsync())) {
        throw new Error("SECURE_STORAGE_UNAVAILABLE");
      }
      return SecureStore.getItemAsync(STORE_KEY, STORE_OPTIONS);
    },
    async write(value) {
      if (!(await SecureStore.isAvailableAsync())) {
        throw new Error("SECURE_STORAGE_UNAVAILABLE");
      }
      await SecureStore.setItemAsync(STORE_KEY, value, STORE_OPTIONS);
    },
    async clear() {
      if (!(await SecureStore.isAvailableAsync())) {
        throw new Error("SECURE_STORAGE_UNAVAILABLE");
      }
      await SecureStore.deleteItemAsync(STORE_KEY, STORE_OPTIONS);
    },
  };
}
