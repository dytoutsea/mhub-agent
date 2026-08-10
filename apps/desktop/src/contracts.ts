import { z } from "zod";

export const hostInfoSchema = z.object({
  appVersion: z.string().min(1).max(32),
  platform: z.enum(["windows", "macos", "unsupported"]),
});

export type HostInfo = z.infer<typeof hostInfoSchema>;

export const desktopChannels = Object.freeze({
  getHostInfo: "host:get-info",
});
