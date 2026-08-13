import {
  type EventSubscription,
  type NativeModule,
  requireOptionalNativeModule,
} from "expo-modules-core";

import type {
  MobileStreamOpenResult,
  MobileTunnelEvents,
  MobileTunnelSnapshot,
  MobileTunnelStopReason,
} from "./types";

interface NativeMobileDataTunnel extends NativeModule {
  configure(dataWebSocketBaseUrl: string, maxStreams: number): Promise<MobileTunnelSnapshot>;
  start(): Promise<MobileTunnelSnapshot>;
  stop(reason: MobileTunnelStopReason): Promise<MobileTunnelSnapshot>;
  getSnapshot(): Promise<MobileTunnelSnapshot>;
  openStream(
    connectionId: string,
    connectionToken: string,
    host: string,
    port: number,
    connectTimeoutMs: number,
  ): Promise<MobileStreamOpenResult>;
  closeStream(connectionId: string): Promise<MobileTunnelSnapshot>;
  addListener<EventName extends keyof MobileTunnelEvents>(
    eventName: EventName,
    listener: MobileTunnelEvents[EventName],
  ): EventSubscription;
}

export const nativeMobileDataTunnel =
  requireOptionalNativeModule<NativeMobileDataTunnel>("MHubMobileDataTunnel");
