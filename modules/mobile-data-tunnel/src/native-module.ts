import {
  type EventSubscription,
  type NativeModule,
  requireOptionalNativeModule,
} from "expo-modules-core";

import type { MobileTunnelEvents, MobileTunnelSnapshot, MobileTunnelStopReason } from "./types";

interface NativeMobileDataTunnel extends NativeModule {
  configure(dataWebSocketBaseUrl: string, maxStreams: number): Promise<MobileTunnelSnapshot>;
  start(): Promise<MobileTunnelSnapshot>;
  stop(reason: MobileTunnelStopReason): Promise<MobileTunnelSnapshot>;
  getSnapshot(): Promise<MobileTunnelSnapshot>;
  addListener(
    eventName: "onStateChanged",
    listener: MobileTunnelEvents["onStateChanged"],
  ): EventSubscription;
}

export const nativeMobileDataTunnel =
  requireOptionalNativeModule<NativeMobileDataTunnel>("MHubMobileDataTunnel");
