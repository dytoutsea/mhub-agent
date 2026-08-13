import { nativeMobileDataTunnel } from "./native-module";
import type {
  EventSubscription,
  MobileDataTunnel,
  MobileStreamOpenRequest,
  MobileStreamOpenResult,
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
  openStream(request: MobileStreamOpenRequest): Promise<MobileStreamOpenResult> {
    return requireModule().openStream(
      request.connectionId,
      request.connectionToken,
      request.host,
      request.port,
      request.connectTimeoutMs,
    );
  },
  closeStream(connectionId: string): Promise<MobileTunnelSnapshot> {
    return requireModule().closeStream(connectionId);
  },
  addListener<EventName extends keyof MobileTunnelEvents>(
    eventName: EventName,
    listener: MobileTunnelEvents[EventName],
  ): EventSubscription {
    return requireModule().addListener(eventName, listener);
  },
};
