export * from "./lifecycle-controller";
export * from "./types";

import type { MobileDataTunnel } from "./types";

function unsupported(): never {
  throw new Error("MOBILE_DATA_TUNNEL_UNSUPPORTED_PLATFORM");
}

export const mobileDataTunnel: MobileDataTunnel = {
  configure: async () => unsupported(),
  start: async () => unsupported(),
  stop: async () => unsupported(),
  getSnapshot: async () => unsupported(),
  openStream: async () => unsupported(),
  closeStream: async () => unsupported(),
  addListener: () => unsupported(),
};
