export type MobileTunnelState = "unconfigured" | "stopped" | "running";

export interface MobileTunnelSnapshot {
  readonly state: MobileTunnelState;
  readonly foreground: boolean;
  readonly activeStreams: number;
  readonly errorCode: string | null;
}

export interface MobileTunnelConfiguration {
  readonly dataWebSocketBaseUrl: string;
  readonly maxStreams: number;
}

export type MobileTunnelStopReason =
  | "USER_REQUESTED"
  | "MOBILE_APP_BACKGROUND"
  | "APP_CONTEXT_DESTROYED";

export type MobileTunnelEvents = {
  readonly onStateChanged: (snapshot: MobileTunnelSnapshot) => void;
};

export interface EventSubscription {
  remove(): void;
}

export interface MobileDataTunnel {
  configure(configuration: MobileTunnelConfiguration): Promise<MobileTunnelSnapshot>;
  start(): Promise<MobileTunnelSnapshot>;
  stop(reason: MobileTunnelStopReason): Promise<MobileTunnelSnapshot>;
  getSnapshot(): Promise<MobileTunnelSnapshot>;
  addListener(
    eventName: "onStateChanged",
    listener: MobileTunnelEvents["onStateChanged"],
  ): EventSubscription;
}
