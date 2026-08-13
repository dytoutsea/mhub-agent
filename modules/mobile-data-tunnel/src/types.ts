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

export interface MobileStreamOpenRequest {
  readonly connectionId: string;
  readonly connectionToken: string;
  readonly host: string;
  readonly port: number;
  readonly connectTimeoutMs: number;
}

export interface MobileStreamOpenResult {
  readonly connectionId: string;
  readonly status: "ready" | "failed";
  readonly reason: string | null;
}

export interface MobileStreamClosedEvent {
  readonly connectionId: string;
  readonly reason: string;
}

export type MobileTunnelStopReason =
  | "USER_REQUESTED"
  | "MOBILE_APP_BACKGROUND"
  | "APP_CONTEXT_DESTROYED";

export type MobileTunnelEvents = {
  readonly onStateChanged: (snapshot: MobileTunnelSnapshot) => void;
  readonly onStreamClosed: (event: MobileStreamClosedEvent) => void;
};

export interface EventSubscription {
  remove(): void;
}

export interface MobileDataTunnel {
  configure(configuration: MobileTunnelConfiguration): Promise<MobileTunnelSnapshot>;
  start(): Promise<MobileTunnelSnapshot>;
  stop(reason: MobileTunnelStopReason): Promise<MobileTunnelSnapshot>;
  getSnapshot(): Promise<MobileTunnelSnapshot>;
  openStream(request: MobileStreamOpenRequest): Promise<MobileStreamOpenResult>;
  closeStream(connectionId: string): Promise<MobileTunnelSnapshot>;
  addListener<EventName extends keyof MobileTunnelEvents>(
    eventName: EventName,
    listener: MobileTunnelEvents[EventName],
  ): EventSubscription;
}
