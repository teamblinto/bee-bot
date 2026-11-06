import { z } from "zod";

export const protocolVersion = 6;

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
  // Dev and tests only: lets bots be created on the fake engine.
  fakeEngine: z.boolean().optional(),
  // Tests only: replaces the `claude` binary, so they never touch the real CLI.
  claudeCommand: z.array(z.string().min(1)).min(1).optional(),
});
export type Bootstrap = z.infer<typeof Bootstrap>;

export const PauseReason = z.enum([
  "owner",
  "auth_failed",
  "cli_missing",
  "cli_version",
  "config_dir",
]);
export type PauseReason = z.infer<typeof PauseReason>;

export const BotModel = z.enum(["haiku", "sonnet", "opus"]);
export type BotModel = z.infer<typeof BotModel>;
export const defaultBotModel: BotModel = "sonnet";

export const Bot = z.object({
  id: z.string(),
  name: z.string(),
  personality: z.string(),
  status: z.enum(["ready", "paused"]),
  pauseReason: PauseReason.nullable(),
  roomId: z.string(),
  engineAccountId: z.string(),
  model: BotModel,
});
export type Bot = z.infer<typeof Bot>;

export const ChatMessage = z.object({
  id: z.string(),
  roomId: z.string(),
  author: z.enum(["human", "bot"]),
  body: z.string(),
  // Names only, in call order. Tool input is never kept here.
  tools: z.array(z.string()),
  // How long the turn behind a bot message ran. Null for owners and for rows older than the column.
  workedMs: z.number().nullable(),
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
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type Run = z.infer<typeof Run>;

export const EngineAccount = z.object({
  id: z.string(),
  label: z.string(),
  blockedUntil: z.string().nullable(),
});
export type EngineAccount = z.infer<typeof EngineAccount>;

export const ApprovalTool = z.enum(["Read", "Write", "Edit", "Glob", "Grep", "Bash"]);
export type ApprovalTool = z.infer<typeof ApprovalTool>;

// Durable, so it must never carry tool input: that can hold secrets.
export const Approval = z.object({
  id: z.string(),
  runId: z.string(),
  botId: z.string(),
  tool: ApprovalTool,
  digest: z.string(),
  status: z.enum(["pending", "allowed", "denied", "expired"]),
  reason: z.enum(["owner", "timeout", "stopped", "server_restarted"]).nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type Approval = z.infer<typeof Approval>;

// The card's content. Lives only in server memory, for as long as the tool call is held.
export const PendingApproval = z.object({
  id: z.string(),
  detail: z.string(),
  canAlwaysAllow: z.boolean(),
  expiresAt: z.string(),
});
export type PendingApproval = z.infer<typeof PendingApproval>;

export const MemoryType = z.enum(["user", "feedback", "project", "reference"]);
export type MemoryType = z.infer<typeof MemoryType>;
export const MemorySource = z.enum(["user", "agent"]);
export type MemorySource = z.infer<typeof MemorySource>;
export const MemoryStatus = z.enum(["pending", "active", "superseded", "forgotten"]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;

// One limit for the owner and the bot, so one item can never fill the primer.
export const MemoryText = z.string().trim().min(1).max(2000);

export const MemoryItem = z.object({
  id: z.uuid(),
  botId: z.string(),
  type: MemoryType,
  source: MemorySource,
  sourceRef: z.string(),
  status: MemoryStatus,
  created: z.string(),
  supersededBy: z.string().nullable(),
  text: z.string(),
});
export type MemoryItem = z.infer<typeof MemoryItem>;

// A pending item can be a request about another item. Its `text` is then the new text (supersede)
// or the bot's reason (forget).
export function memoryRequest({ status, sourceRef }: Pick<MemoryItem, "status" | "sourceRef">) {
  if (status !== "pending") {
    return undefined;
  }
  const [kind, targetId] = sourceRef.split(":");
  return (kind === "supersede" || kind === "forget") && targetId ? { kind, targetId } : undefined;
}

// `runs` holds only the latest run of each bot.
export const ChatState = z.object({
  bots: z.array(Bot),
  accounts: z.array(EngineAccount),
  messages: z.array(ChatMessage),
  runs: z.array(Run),
  approvals: z.array(Approval),
  // Active and pending only, for every bot.
  memories: z.array(MemoryItem),
  noticeAcknowledgedAt: z.string().nullable(),
});
export type ChatState = z.infer<typeof ChatState>;

export const EventBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bot.changed"), bot: Bot }),
  z.object({ type: z.literal("account.changed"), account: EngineAccount }),
  z.object({ type: z.literal("message.created"), message: ChatMessage }),
  z.object({ type: z.literal("run.changed"), run: Run }),
  z.object({ type: z.literal("approval.changed"), approval: Approval }),
  z.object({ type: z.literal("memory.changed"), memory: MemoryItem }),
  z.object({ type: z.literal("notice.acknowledged"), acknowledgedAt: z.string() }),
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
  // Live thinking state. `text` is what to append, and is empty when the CLI hides the thought.
  z.object({
    type: z.literal("thinking"),
    runId: z.string(),
    active: z.boolean(),
    text: z.string(),
  }),
  // A tool call started, or its detail became known: same `toolId`, so clients upsert.
  // `detail` is a short path or command. Memory only, like all of tool input.
  z.object({
    type: z.literal("tool-start"),
    runId: z.string(),
    toolId: z.string(),
    name: z.string(),
    detail: z.string().nullable(),
  }),
  z.object({
    type: z.literal("tool-end"),
    runId: z.string(),
    toolId: z.string(),
    failed: z.boolean(),
  }),
  // The whole pending set, sent on subscribe and on every change. Never persisted.
  z.object({ type: z.literal("pending-approvals"), approvals: z.array(PendingApproval) }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

const botFields = {
  name: z.string().trim().min(1).max(80),
  personality: z.string().trim().max(4000),
  model: BotModel.optional(),
};

export const Command = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create-bot"),
    ...botFields,
    engineAccountId: z.enum(["claude", "fake"]).optional(),
  }),
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
  z.object({
    type: z.literal("decide-approval"),
    approvalId: z.uuid(),
    digest: z.string(),
    decision: z.enum(["allow", "deny", "always"]),
  }),
  z.object({
    type: z.literal("add-memory"),
    botId: z.uuid(),
    text: MemoryText,
    memoryType: MemoryType,
    // Also how the owner edits an item.
    supersedes: z.uuid().optional(),
  }),
  z.object({
    type: z.literal("decide-memory"),
    memoryId: z.uuid(),
    decision: z.enum(["approve", "reject"]),
  }),
  z.object({ type: z.literal("forget-memory"), memoryId: z.uuid() }),
  z.object({ type: z.literal("acknowledge-notice") }),
]);
export type Command = z.infer<typeof Command>;

// Strict, because the probe reads output holding the owner's email and organization.
export const EngineStatus = z.strictObject({
  cliFound: z.boolean(),
  versionOk: z.boolean(),
  loggedIn: z.boolean(),
  pauseReason: PauseReason.nullable(),
  testedVersion: z.string(),
});
export type EngineStatus = z.infer<typeof EngineStatus>;

export const ProtocolNotice = z.object({
  code: z.literal("protocol_mismatch"),
  message: z.string(),
  serverProtocolVersion: z.number().int(),
});
export type ProtocolNotice = z.infer<typeof ProtocolNotice>;
