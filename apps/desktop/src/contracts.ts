import { z } from "zod";

export const hostInfoSchema = z.object({
  appVersion: z.string().min(1).max(32),
  platform: z.enum(["windows", "macos", "unsupported"]),
});

export type HostInfo = z.infer<typeof hostInfoSchema>;

export const agentStateSchema = z.enum([
  "unregistered",
  "stopped",
  "connecting",
  "online",
  "degraded",
  "backoff",
  "paused",
  "revoked",
]);

export const agentSnapshotSchema = z.object({
  platform: z.enum(["windows", "macos", "unsupported"]),
  state: agentStateSchema,
  proxyId: z.string().min(1).max(64).nullable(),
  activeStreams: z.number().int().min(0).max(256),
  connectedAt: z.string().datetime({ offset: true }).nullable(),
  errorCode: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .max(96)
    .nullable(),
});

export type AgentSnapshot = z.infer<typeof agentSnapshotSchema>;

export const agentEventSchema = z.object({
  snapshot: agentSnapshotSchema,
});

export type AgentEvent = z.infer<typeof agentEventSchema>;

export const activationRequestSchema = z.object({
  activationCode: z.string().trim().min(1).max(160),
});

export const activationResultSchema = z.object({
  proxyId: z.string().regex(/^cpx_[0-9A-HJKMNP-TV-Z]{26}$/),
  proxyName: z.string().min(1).max(128),
  platform: z.enum(["windows", "macos"]),
  activatedAt: z.string().datetime({ offset: true }),
  credentialExpiresAt: z.string().datetime({ offset: true }),
});

export type ActivationRequest = z.infer<typeof activationRequestSchema>;
export type ActivationResult = z.infer<typeof activationResultSchema>;

export const desktopChannels = Object.freeze({
  getHostInfo: "host:get-info",
  agentGetState: "agent:get-state",
  agentStart: "agent:start",
  agentStop: "agent:stop",
  agentStateChanged: "agent:state-changed",
  agentActivate: "agent:activate",
});
