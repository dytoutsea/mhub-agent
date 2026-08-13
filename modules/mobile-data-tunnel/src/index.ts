import { nativeMobileDataTunnel } from "./native-module";
import type {
  EventSubscription,
  MobileDataTunnel,
  MobileTunnelConfiguration,
  MobileTunnelEvents,
  MobileTunnelSnapshot,
  MobileTunnelStopReason,
} from "./types";

export * from "./lifecycle-controller";
export * from "./types";

function requireModule() {
  if (!nativeMobileDataTunnel) {
    throw new Error("MOBILE_DATA_TUNNEL_NATIVE_MODULE_UNAVAILABLE");
  }
  return nativeMobileDataTunnel;
}

export const mobileDataTunnel: MobileDataTunnel = {
  configure(configuration: MobileTunnelConfiguration): Promise<MobileTunnelSnapshot> {
    return requireModule().configure(configuration.dataWebSocketBaseUrl, configuration.maxStreams);
  },
  start(): Promise<MobileTunnelSnapshot> {
    return requireModule().start();
  },
  stop(reason: MobileTunnelStopReason): Promise<MobileTunnelSnapshot> {
    return requireModule().stop(reason);
  },
  getSnapshot(): Promise<MobileTunnelSnapshot> {
    return requireModule().getSnapshot();
  },
  addListener(
    eventName: "onStateChanged",
    listener: MobileTunnelEvents["onStateChanged"],
  ): EventSubscription {
    return requireModule().addListener(eventName, listener);
  },
};
