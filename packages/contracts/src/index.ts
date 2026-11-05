import { z } from "zod";

export const protocolVersion = 1;

// Restarting can't fix these, so the desktop supervisor gives up on them.
export const noRestartExitCodes = {
  invalidBootstrap: 78,
  storageFailed: 79,
} as const;

export const Bootstrap = z.object({
  port: z.number().int().min(0).max(65535),
  token: z.string().min(32),
  dataDir: z.string().min(1),
  allowedOrigins: z.array(z.string()),
});
export type Bootstrap = z.infer<typeof Bootstrap>;

export const ServerEvent = z.object({
  seq: z.number().int().positive(),
  type: z.literal("diagnostic"),
  createdAt: z.string(),
});
export type ServerEvent = z.infer<typeof ServerEvent>;

export const ClientMessage = z.object({
  type: z.literal("subscribe"),
  afterSeq: z.number().int().nonnegative(),
});
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: ServerEvent }),
  z.object({ type: z.literal("replay"), events: z.array(ServerEvent) }),
  // Replaces client state: the cursor was pruned or is ahead of the server.
  z.object({
    type: z.literal("snapshot"),
    seq: z.number().int().nonnegative(),
    events: z.array(ServerEvent),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

export const DiagnosticResult = z.object({ event: ServerEvent });
export type DiagnosticResult = z.infer<typeof DiagnosticResult>;

export const ProtocolNotice = z.object({
  code: z.literal("protocol_mismatch"),
  message: z.string(),
  serverProtocolVersion: z.number().int(),
});
export type ProtocolNotice = z.infer<typeof ProtocolNotice>;
