import { z } from "zod";

export const protocolVersion = 2;

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

export const Bot = z.object({
  id: z.string(),
  name: z.string(),
  personality: z.string(),
  status: z.enum(["ready", "paused"]),
  pauseReason: z.enum(["owner", "auth_failed"]).nullable(),
  roomId: z.string(),
  engineAccountId: z.string(),
});
export type Bot = z.infer<typeof Bot>;

export const ChatMessage = z.object({
  id: z.string(),
  roomId: z.string(),
  author: z.enum(["human", "bot"]),
  body: z.string(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const RunStatus = z.enum([
  "Queued",
  "Refused",
  "Running",
  "Completed",
  "Failed",
  "Cancelled",
  "Interrupted",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunReason = z.enum([
  "unattended",
  "bot_paused",
  "daily_cap",
  "engine_failed",
  "limited",
  "auth_failed",
  "timeout",
  "stopped",
  "server_restarted",
]);
export type RunReason = z.infer<typeof RunReason>;

export const Run = z.object({
  id: z.string(),
  botId: z.string(),
  status: RunStatus,
  reason: RunReason.nullable(),
  createdAt: z.string(),
});
export type Run = z.infer<typeof Run>;

export const EngineAccount = z.object({
  id: z.string(),
  label: z.string(),
  blockedUntil: z.string().nullable(),
});
export type EngineAccount = z.infer<typeof EngineAccount>;

// `runs` holds only the latest run of each bot.
export const ChatState = z.object({
  bots: z.array(Bot),
  accounts: z.array(EngineAccount),
  messages: z.array(ChatMessage),
  runs: z.array(Run),
});
export type ChatState = z.infer<typeof ChatState>;

export const EventBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bot.changed"), bot: Bot }),
  z.object({ type: z.literal("account.changed"), account: EngineAccount }),
  z.object({ type: z.literal("message.created"), message: ChatMessage }),
  z.object({ type: z.literal("run.changed"), run: Run }),
]);
export type EventBody = z.infer<typeof EventBody>;

export const ServerEvent = z.intersection(
  EventBody,
  z.object({ seq: z.number().int().positive(), createdAt: z.string() }),
);
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
    state: ChatState,
  }),
  // Live output of a running turn. Never persisted, so it has no seq.
  z.object({ type: z.literal("delta"), runId: z.string(), text: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

const botFields = {
  name: z.string().trim().min(1).max(80),
  personality: z.string().trim().max(4000),
};

export const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create-bot"), ...botFields }),
  z.object({ type: z.literal("update-bot"), botId: z.uuid(), ...botFields }),
  z.object({ type: z.literal("set-bot-paused"), botId: z.uuid(), paused: z.boolean() }),
  z.object({
    type: z.literal("send-message"),
    messageId: z.uuid(),
    roomId: z.uuid(),
    body: z.string().trim().min(1).max(32_000),
  }),
  z.object({ type: z.literal("stop-bot"), botId: z.uuid() }),
  z.object({ type: z.literal("stop-all") }),
  z.object({ type: z.literal("continue-run"), runId: z.uuid() }),
]);
export type Command = z.infer<typeof Command>;

export const ProtocolNotice = z.object({
  code: z.literal("protocol_mismatch"),
  message: z.string(),
  serverProtocolVersion: z.number().int(),
});
export type ProtocolNotice = z.infer<typeof ProtocolNotice>;
