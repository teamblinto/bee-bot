import { z } from "zod";

export const protocolVersion = 21;

// Restarting can't fix these, so the desktop supervisor gives up on them.
export const noRestartExitCodes = {
  invalidBootstrap: 78,
  storageFailed: 79,
} as const;

// Why the vault can't hold a secret. Bee never falls back to keeping one unprotected.
export const VaultProblem = z.enum([
  // Linux with no keyring: safeStorage's `basic_text` uses a key built into Chromium.
  "insecure_keyring",
  "keyring_unavailable",
  "key_unreadable",
  // Headless, with no key file.
  "no_key",
  // The key doesn't open the secrets already stored.
  "wrong_key",
]);
export type VaultProblem = z.infer<typeof VaultProblem>;

// The vault's key-encryption key: 32 bytes. Only ever travels on the bootstrap channel.
export const VaultKey = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), key: z.base64().length(44) }),
  z.object({ status: z.literal("unavailable"), problem: VaultProblem }),
]);
export type VaultKey = z.infer<typeof VaultKey>;

export const Bootstrap = z.object({
  port: z.number().int().min(0).max(65535),
  token: z.string().min(32),
  dataDir: z.string().min(1),
  allowedOrigins: z.array(z.string()),
  // Dev and tests only: lets bots be created on the fake engine.
  fakeEngine: z.boolean().optional(),
  // Tests only: replaces the `claude` binary, so they never touch the real CLI.
  claudeCommand: z.array(z.string().min(1)).min(1).optional(),
  // Tests only: replaces the `codex` binary, so they never touch the real CLI.
  codexCommand: z.array(z.string().min(1)).min(1).optional(),
  // Sent by the desktop, which unwraps it with the OS keyring. Headless reads a key file instead.
  vault: VaultKey.optional(),
});
export type Bootstrap = z.infer<typeof Bootstrap>;

// Each later stdin line from the desktop: the OS is about to sleep, or just woke.
export const PowerSignal = z.object({ power: z.enum(["suspend", "resume"]) });
export type PowerSignal = z.infer<typeof PowerSignal>;

// Served at `GET /.well-known/bee-bot` without auth, so a client can identify a server before it connects.
export const ServerInfo = z.object({
  environmentId: z.string(),
  version: z.string(),
  protocolVersion: z.number().int(),
  capabilities: z.array(z.string()),
});
export type ServerInfo = z.infer<typeof ServerInfo>;

export const PauseReason = z.enum([
  "owner",
  "auth_failed",
  "cli_missing",
  // No longer set, since no CLI version blocks a bot. Kept so stored pauses still parse and clear.
  "cli_version",
  // The CLI was found but didn't start or answer.
  "cli_failed",
  "config_dir",
  // The CLI authenticated with a different credential source than the account's lane.
  "credential_source",
  // A site wants a sign-in or a challenge solved, or a browser action is the owner's to do.
  "browser_session",
]);
export type PauseReason = z.infer<typeof PauseReason>;

// What the catalog allows is decided by the server, which knows what the CLI offers today.
export const BotModel = z.string().trim().min(1).max(100);
export type BotModel = z.infer<typeof BotModel>;
export const defaultBotModel: BotModel = "sonnet";

export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof Effort>;

export const BotMode = z.enum(["build", "plan"]);
export type BotMode = z.infer<typeof BotMode>;

export const BotAccess = z.enum(["supervised", "auto-edits", "full"]);
export type BotAccess = z.infer<typeof BotAccess>;

// Rule of Two: Reader holds untrusted input and private data, Researcher untrusted input and side
// effects, Operator private data and side effects. A session with all three needs a person.
export const BotProfile = z.enum(["reader", "researcher", "operator"]);
export type BotProfile = z.infer<typeof BotProfile>;

// Only a box run may be unattended.
export const BotBoundary = z.enum(["host", "box"]);
export type BotBoundary = z.infer<typeof BotBoundary>;

// Grants as data, such as `browser` or `gmail.send(to-allowlist)`.
export const Manifest = z.array(z.string().trim().min(1).max(200)).max(100);
export type Manifest = z.infer<typeof Manifest>;
export const browserGrant = "browser";

export const EngineModel = z.object({
  id: BotModel,
  label: z.string(),
  efforts: z.array(Effort),
});
export type EngineModel = z.infer<typeof EngineModel>;

// By engine account. Absent accounts aren't offered on this server.
export const ModelCatalog = z.record(z.string(), z.array(EngineModel));
export type ModelCatalog = z.infer<typeof ModelCatalog>;

export const EngineAccountId = z.enum(["claude", "codex", "fake"]);

export const maxAvatarSeed = 0xffffffff;
export const AvatarSeed = z.number().int().min(0).max(maxAvatarSeed);

// On the host the credential stays in the vendor CLI's own store. In a box an API key lives in
// Bee's vault, and only the egress proxy ever sees it.
export const EngineLane = z.enum(["subscription", "api_key"]);
export type EngineLane = z.infer<typeof EngineLane>;

// Names only, checked again by the server: no scheme, port, path, wildcard or IP literal.
export const EgressHosts = z.array(z.string().trim().min(1).max(253)).max(100);

export const Bot = z.object({
  id: z.string(),
  name: z.string(),
  personality: z.string(),
  // Shown in chat instead of the personality. Null until written, and for an empty personality.
  summary: z.string().nullable(),
  status: z.enum(["ready", "paused"]),
  pauseReason: PauseReason.nullable(),
  roomId: z.string(),
  engineAccountId: z.string(),
  model: BotModel,
  // Null leaves the choice to the CLI.
  effort: Effort.nullable(),
  mode: BotMode,
  access: BotAccess,
  profile: BotProfile,
  boundary: BotBoundary,
  manifest: Manifest,
  // Hosts a boxed bot may reach besides its engine's own, granted by the owner.
  egressHosts: EgressHosts,
  // R7: what a boxed bot uses on its own when an API key is saved. A subscription is an opt-in.
  unattendedLane: EngineLane,
  avatarSeed: AvatarSeed,
  // The real path of the owner's folder. Null keeps the bot in its private workspace.
  projectPath: z.string().nullable(),
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
  // The bot that wrote it. Null for owners.
  botId: z.string().nullable(),
  replyToId: z.string().nullable(),
  chainId: z.string().nullable(),
  hop: z.number(),
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
  // Both hold neither the bot's slot nor the account gate.
  "WaitingUser",
  "WaitingQuota",
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
  "folder_missing",
  // Unattended on a box bot while boxes can't run, or with no lane R7 allows.
  "box_unavailable",
  "automated_access",
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
  chainId: z.string().nullable(),
  hop: z.number(),
  depth: z.number(),
  taskId: z.string().nullable(),
});
export type Run = z.infer<typeof Run>;

export const EngineAccount = z.object({
  id: z.string(),
  label: z.string(),
  lane: EngineLane,
  blockedUntil: z.string().nullable(),
});
export type EngineAccount = z.infer<typeof EngineAccount>;

export const ApprovalTool = z.enum(["Read", "Write", "Edit", "Patch", "Glob", "Grep", "Bash"]);
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

export const ApprovalChange = z.object({
  action: z.enum(["create", "replace", "write", "edit", "patch"]),
  removed: z.string().nullable(),
  added: z.string(),
  hiddenChars: z.number(),
  replaceAll: z.boolean(),
  // Only a patch has these. It can touch many files, so `removed` and `added` stay empty.
  files: z.array(z.object({ path: z.string(), removed: z.string(), added: z.string() })).optional(),
});
export type ApprovalChange = z.infer<typeof ApprovalChange>;

// The card's content. Lives only in server memory, for as long as the tool call is held.
export const PendingApproval = z.object({
  id: z.string(),
  detail: z.string(),
  change: ApprovalChange.nullable(),
  canAlwaysAllow: z.boolean(),
  expiresAt: z.string(),
});
export type PendingApproval = z.infer<typeof PendingApproval>;

export const BoxState = z.enum(["absent", "creating", "stopped", "starting", "running", "failed"]);
export type BoxState = z.infer<typeof BoxState>;

export const BoxStatus = z.object({
  botId: z.string(),
  state: BoxState,
  reason: z.string().nullable(),
  updatedAt: z.string(),
});
export type BoxStatus = z.infer<typeof BoxStatus>;

export const BoxMachineName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

// Whether box bots can run on this computer, and what is missing if not. Never persisted.
export const BoxAvailability = z.object({
  machine: z.string(),
  machineFound: z.boolean(),
  boxdInstalled: z.boolean(),
  imageBuilt: z.boolean(),
  available: z.boolean(),
  settingUp: z.boolean(),
  // Plain words for the owner. Null when boxes are available.
  problem: z.string().nullable(),
});
export type BoxAvailability = z.infer<typeof BoxAvailability>;

// Bee never runs a hand_off: the owner does it, and approving records that it was done.
export const ContinuationKind = z.enum(["approval", "hand_off"]);
export type ContinuationKind = z.infer<typeof ContinuationKind>;

// `claimed` is the broker running the action. A crash then leaves it `unknown`, never retried.
export const ContinuationStatus = z.enum([
  "waiting",
  "approved",
  "denied",
  "expired",
  "claimed",
  "succeeded",
  "failed",
  "unknown",
]);
export type ContinuationStatus = z.infer<typeof ContinuationStatus>;

export const ContinuationReason = z.enum([
  "owner",
  "timeout",
  "no_surface",
  "payload_changed",
  "stopped",
  "server_restarted",
]);
export type ContinuationReason = z.infer<typeof ContinuationReason>;

// `shown` is the whole action as the owner sees it, and `digest` binds a decision to it.
export const Continuation = z.object({
  id: z.string(),
  botId: z.string(),
  runId: z.string(),
  kind: ContinuationKind,
  tool: z.string(),
  shown: z.string(),
  digest: z.string(),
  status: ContinuationStatus,
  reason: ContinuationReason.nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type Continuation = z.infer<typeof Continuation>;

export const AuditInitiator = z.enum(["human", "routine", "bot", "system"]);
export type AuditInitiator = z.infer<typeof AuditInitiator>;

// Only what crossed Bee's gateways: native CLI shell and file tools never do.
export const AuditEntry = z.object({
  id: z.number(),
  runId: z.string().nullable(),
  botId: z.string().nullable(),
  // Both null on rows from before M3.
  initiator: AuditInitiator.nullable(),
  attended: z.boolean().nullable(),
  status: z.string(),
  reason: z.string().nullable(),
  tool: z.string().nullable(),
  // Of the action's payload, which is never kept here.
  digest: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

// Engine accounts whose API key the vault holds. Never the key itself.
export const VaultStatus = z.object({ apiKeys: z.array(z.string()) });
export type VaultStatus = z.infer<typeof VaultStatus>;

// Newest first. brokenRowId is the first row whose hash does not follow from the one before it.
export const AuditPage = z.object({
  entries: z.array(AuditEntry),
  brokenRowId: z.number().nullable(),
});
export type AuditPage = z.infer<typeof AuditPage>;

export const ApiKeyAccountId = EngineAccountId.exclude(["fake"]);
export type ApiKeyAccountId = z.infer<typeof ApiKeyAccountId>;

// The handoff socket: the owner watches the bot's browser and may take control of it. Nothing sent
// up this socket is logged, stored or shown to the bot.
export const HandoffReason = z.enum(["login", "captcha", "hand_off"]);
export type HandoffReason = z.infer<typeof HandoffReason>;

// Coordinates are page CSS pixels.
export const HandoffInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse"),
    action: z.enum(["down", "up", "move", "wheel"]),
    x: z.number().min(0).max(10_000),
    y: z.number().min(0).max(10_000),
    button: z.enum(["none", "left", "middle", "right"]),
    deltaX: z.number().min(-10_000).max(10_000).optional(),
    deltaY: z.number().min(-10_000).max(10_000).optional(),
  }),
  z.object({
    type: z.literal("key"),
    action: z.enum(["down", "up"]),
    key: z.string().min(1).max(32),
    code: z.string().max(32),
  }),
]);
export type HandoffInput = z.infer<typeof HandoffInput>;

export const HandoffClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("take") }),
  z.object({ type: z.literal("give") }),
  z.object({ type: z.literal("input"), input: HandoffInput }),
  // The private sign-in field: typed into the page's focused field in one go.
  z.object({ type: z.literal("text"), text: z.string().min(1).max(1000) }),
]);
export type HandoffClientMessage = z.infer<typeof HandoffClientMessage>;

export const HandoffServerMessage = z.discriminatedUnion("type", [
  // `mine` is this socket holding the lease. `requested` is why the bot asked for a person.
  z.object({
    type: z.literal("lease"),
    holder: z.enum(["bot", "human"]),
    mine: z.boolean(),
    requested: HandoffReason.nullable(),
    note: z.string().nullable(),
  }),
  // A JPEG, base64, of a viewport `width` by `height` CSS pixels.
  z.object({ type: z.literal("frame"), data: z.string(), width: z.number(), height: z.number() }),
  z.object({ type: z.literal("unavailable") }),
]);
export type HandoffServerMessage = z.infer<typeof HandoffServerMessage>;

export const MemoryType = z.enum(["user", "feedback", "project", "reference"]);
export type MemoryType = z.infer<typeof MemoryType>;
export const MemorySource = z.enum(["user", "agent"]);
export type MemorySource = z.infer<typeof MemorySource>;
export const MemoryStatus = z.enum(["pending", "active", "superseded", "forgotten"]);
export type MemoryStatus = z.infer<typeof MemoryStatus>;
// Team items are read by every bot and written only by the owner, who promotes a bot's proposal.
export const MemoryScope = z.enum(["bot", "team"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

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
  scope: MemoryScope.default("bot"),
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

// Rows for the owner's limit bars. `usedPercent` is null when only a status or reset time is known:
// nothing may turn that into 0.
export const UsageWindow = z.object({
  id: z.string(),
  kind: z.enum(["session", "weekly", "monthly", "other"]),
  label: z.string(),
  windowDurationMins: z.number().nullable(),
  usedPercent: z.number().min(0).max(100).nullable(),
  resetsAt: z.string().nullable(),
  status: z.string().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

export const UsageLimits = z.object({
  accountId: z.string(),
  checkedAt: z.string().nullable(),
  windows: z.array(UsageWindow),
  unavailable: z
    .object({ reason: z.enum(["unsupported", "probeFailed"]), message: z.string().nullable() })
    .nullable(),
});
export type UsageLimits = z.infer<typeof UsageLimits>;

export const UsageRefreshResult = z.object({
  outcome: z.enum(["refreshed", "busy", "throttled", "unavailable"]),
});
export type UsageRefreshResult = z.infer<typeof UsageRefreshResult>;

const usageTokens = {
  input: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
};
export const UsageTokens = z.object(usageTokens);
export type UsageTokens = z.infer<typeof UsageTokens>;

// `costUsd` is an API-equivalent estimate, never spend. It leaves out `unpricedTokens`.
export const UsageRow = z.object({
  ...usageTokens,
  costUsd: z.number(),
  unpricedTokens: z.number(),
});
export type UsageRow = z.infer<typeof UsageRow>;

export const usageDays = [1, 7, 30, 90] as const;

export const UsageSummary = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unavailable") }),
  z.object({
    status: z.literal("ok"),
    days: z.number(),
    generatedAt: z.string(),
    // The oldest record on disk: transcripts older than this are gone.
    oldestAt: z.string().nullable(),
    files: z.number(),
    skippedLines: z.number(),
    unreadableFiles: z.number(),
    duplicatesDropped: z.number(),
    totals: UsageRow.extend({ sessions: z.number() }),
    models: z.array(UsageRow.extend({ model: z.string() })),
    // A null bot is work done outside Bee.
    bots: z.array(UsageRow.extend({ botId: z.string().nullable() })),
    // Local days, or ISO hours for a one-day window. Empty buckets included.
    series: z.array(UsageRow.extend({ start: z.string() })),
  }),
]);
export type UsageSummary = z.infer<typeof UsageSummary>;

const MessageBody = z.string().trim().min(1).max(32_000);
const RoutineName = z.string().trim().min(1).max(80);
const RoomName = z.string().trim().min(1).max(80);
const maxRoomMembers = 12;

export const Routine = z.object({
  id: z.string(),
  botId: z.string(),
  name: RoutineName,
  prompt: MessageBody,
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  skipIfLaterMins: z.number().nullable(),
  // The cron slot. The routine comes due `staggerMs` after it. Null while disabled.
  nextFireAt: z.string().nullable(),
  staggerMs: z.number(),
  // `owner_away` keeps scheduling and records each slot as skipped. `setup_failed` turned it off.
  pausedReason: z.enum(["owner_away", "setup_failed"]).nullable(),
  lastTickAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Routine = z.infer<typeof Routine>;

export const FiringReason = z.enum([
  "no_boundary",
  "asleep",
  "bot_paused",
  "disabled",
  "too_late",
  "owner_away",
  "catch_up",
]);
export type FiringReason = z.infer<typeof FiringReason>;

export const RoutineFiring = z.object({
  id: z.string(),
  routineId: z.string(),
  slot: z.string(),
  status: z.enum(["ready", "ran", "skipped", "missed"]),
  reason: FiringReason.nullable(),
  // Earlier slots this one passed over. They have no rows of their own.
  missedBefore: z.number(),
  attempts: z.number(),
  // Set after a failed attempt: the card reopens then, once.
  retryAt: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
export type RoutineFiring = z.infer<typeof RoutineFiring>;

// `mention` is a bot's room message naming another bot.
export const WakeSource = z.enum(["human", "routine", "task", "approval", "continue", "mention"]);
export type WakeSource = z.infer<typeof WakeSource>;

export const LimitRefusal = z.enum([
  "hop",
  "depth",
  "fan_out",
  "mentions",
  "post_budget",
  "backoff",
  "repeated_failure",
  "chain_turns",
  "chain_time",
  "routine_approval",
]);
export type LimitRefusal = z.infer<typeof LimitRefusal>;

export const Room = z.object({
  id: z.string(),
  kind: z.enum(["dm", "group"]),
  // Null for a DM, which goes by its bot's name.
  name: z.string().nullable(),
  defaultBotId: z.string().nullable(),
  // Bot IDs, in the order they joined.
  members: z.array(z.string()),
  createdAt: z.string(),
});
export type Room = z.infer<typeof Room>;

// How an @mention names a room member: the name lowercased, without its spaces. A mention matches
// the member whose key it equals, or else the one member whose key it starts.
export const mentionKey = (name: string) => name.toLowerCase().replace(/\s+/g, "");

export const Task = z.object({
  id: z.string(),
  kind: z.enum(["delegate", "handoff"]),
  chainId: z.string(),
  hop: z.number(),
  depth: z.number(),
  parentRunId: z.string(),
  requesterBotId: z.string(),
  ownerBotId: z.string(),
  roomId: z.string(),
  goal: z.string(),
  status: z.enum(["open", "done", "refused", "failed", "cancelled"]),
  resultMessageId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

// `runs` holds only the latest run of each bot.
export const ChatState = z.object({
  bots: z.array(Bot),
  accounts: z.array(EngineAccount),
  messages: z.array(ChatMessage),
  runs: z.array(Run),
  approvals: z.array(Approval),
  // Active and pending only, for every bot.
  memories: z.array(MemoryItem),
  usageLimits: z.array(UsageLimits),
  routines: z.array(Routine),
  // Only the latest of each routine. An open card always is its routine's latest.
  firings: z.array(RoutineFiring),
  rooms: z.array(Room),
  // Open tasks only.
  tasks: z.array(Task),
  noticeAcknowledgedAt: z.string().nullable(),
  boxes: z.array(BoxStatus),
  // Waiting only.
  continuations: z.array(Continuation),
  vault: VaultStatus,
  // The owner was told the vendor's automated-access terms bind them for unattended bots (R7).
  automatedAccessAcknowledgedAt: z.string().nullable(),
});
export type ChatState = z.infer<typeof ChatState>;

export const EventBody = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bot.changed"), bot: Bot }),
  z.object({ type: z.literal("account.changed"), account: EngineAccount }),
  z.object({ type: z.literal("message.created"), message: ChatMessage }),
  z.object({ type: z.literal("run.changed"), run: Run }),
  z.object({ type: z.literal("approval.changed"), approval: Approval }),
  z.object({ type: z.literal("memory.changed"), memory: MemoryItem }),
  z.object({ type: z.literal("usage.changed"), limits: UsageLimits }),
  z.object({ type: z.literal("notice.acknowledged"), acknowledgedAt: z.string() }),
  z.object({ type: z.literal("routine.changed"), routine: Routine }),
  z.object({ type: z.literal("routine.deleted"), routineId: z.string() }),
  z.object({ type: z.literal("firing.changed"), firing: RoutineFiring }),
  z.object({ type: z.literal("room.changed"), room: Room }),
  z.object({ type: z.literal("task.changed"), task: Task }),
  z.object({ type: z.literal("box.changed"), box: BoxStatus }),
  z.object({ type: z.literal("continuation.changed"), continuation: Continuation }),
  z.object({ type: z.literal("vault.changed"), vault: VaultStatus }),
  z.object({ type: z.literal("automated-access.acknowledged"), acknowledgedAt: z.string() }),
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
  // The whole catalog, sent on subscribe and on every change. Never persisted.
  z.object({ type: z.literal("model-catalog"), models: ModelCatalog }),
  // Sent on subscribe and on every change, by a server that can run boxes.
  z.object({ type: z.literal("box-availability"), availability: BoxAvailability }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

const botFields = {
  name: z.string().trim().min(1).max(80),
  personality: z.string().trim().max(4000),
  model: BotModel.optional(),
  // Sent so a saved bot keeps the face its form previewed. The server picks one when it's missing.
  avatarSeed: AvatarSeed.optional(),
  // Missing keeps the value, and null clears it.
  projectPath: z.string().trim().min(1).max(1024).nullable().optional(),
};

// Cron and timezone are checked by the server, which gives each its own refusal.
const routineFields = {
  name: RoutineName,
  prompt: MessageBody,
  cron: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  skipIfLaterMins: z.number().int().min(1).max(1440).nullable(),
};

export const Command = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create-bot"),
    ...botFields,
    engineAccountId: EngineAccountId.optional(),
  }),
  z.object({
    type: z.literal("update-bot"),
    botId: z.uuid(),
    ...botFields,
    // Only so a change can be refused: a session belongs to one vendor.
    engineAccountId: EngineAccountId.optional(),
  }),
  // A partial update. A missing field keeps its value, and a null effort clears it.
  z.object({
    type: z.literal("set-bot-engine"),
    botId: z.uuid(),
    engineAccountId: EngineAccountId.optional(),
    model: BotModel.optional(),
    effort: Effort.nullable().optional(),
    mode: BotMode.optional(),
    access: BotAccess.optional(),
  }),
  z.object({ type: z.literal("set-bot-paused"), botId: z.uuid(), paused: z.boolean() }),
  z.object({
    type: z.literal("send-message"),
    messageId: z.uuid(),
    roomId: z.uuid(),
    body: MessageBody,
    replyToId: z.uuid().optional(),
  }),
  z.object({
    type: z.literal("create-room"),
    name: RoomName,
    memberIds: z.array(z.uuid()).min(1).max(maxRoomMembers),
    defaultBotId: z.uuid().nullable().optional(),
  }),
  // Missing keeps the value, and a null default clears it.
  z.object({
    type: z.literal("update-room"),
    roomId: z.uuid(),
    name: RoomName.optional(),
    defaultBotId: z.uuid().nullable().optional(),
  }),
  z.object({ type: z.literal("add-room-member"), roomId: z.uuid(), botId: z.uuid() }),
  z.object({ type: z.literal("remove-room-member"), roomId: z.uuid(), botId: z.uuid() }),
  z.object({ type: z.literal("stop-bot"), botId: z.uuid() }),
  z.object({ type: z.literal("stop-all") }),
  z.object({
    type: z.literal("set-account-lane"),
    engineAccountId: EngineAccountId,
    lane: EngineLane,
  }),
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
  z.object({ type: z.literal("create-routine"), botId: z.uuid(), ...routineFields }),
  z.object({ type: z.literal("update-routine"), routineId: z.uuid(), ...routineFields }),
  z.object({ type: z.literal("delete-routine"), routineId: z.uuid() }),
  z.object({ type: z.literal("start-firing"), firingId: z.uuid() }),
  z.object({ type: z.literal("skip-firing"), firingId: z.uuid() }),
  z.object({ type: z.literal("set-bot-profile"), botId: z.uuid(), profile: BotProfile }),
  // Box mode (R17). On a hand_off, "approve" means the owner did it themselves.
  z.object({
    type: z.literal("decide-continuation"),
    continuationId: z.uuid(),
    digest: z.string(),
    decision: z.enum(["approve", "deny"]),
  }),
  z.object({
    type: z.literal("store-api-key"),
    engineAccountId: ApiKeyAccountId,
    key: z.string().trim().min(1).max(1000),
  }),
  z.object({ type: z.literal("delete-api-key"), engineAccountId: ApiKeyAccountId }),
  z.object({ type: z.literal("acknowledge-automated-access") }),
  z.object({ type: z.literal("set-bot-manifest"), botId: z.uuid(), manifest: Manifest }),
  z.object({ type: z.literal("set-bot-boundary"), botId: z.uuid(), boundary: BotBoundary }),
  z.object({ type: z.literal("set-box-machine"), machine: BoxMachineName }),
  z.object({ type: z.literal("set-up-boxes") }),
  z.object({ type: z.literal("set-bot-egress-hosts"), botId: z.uuid(), hosts: EgressHosts }),
  z.object({ type: z.literal("set-bot-unattended-lane"), botId: z.uuid(), lane: EngineLane }),
]);
export type Command = z.infer<typeof Command>;

// Strict, because the probe reads output holding the owner's organization and more. The email goes
// only to the owner's own screen, and is never logged or stored.
export const EngineStatus = z.strictObject({
  cliFound: z.boolean(),
  // Shown, never required: no CLI version blocks a bot.
  version: z.string().nullable(),
  // `unknown` when this CLI version can't report its login. It doesn't block: each run checks again.
  auth: z.enum(["authenticated", "unauthenticated", "unknown"]),
  email: z.string().nullable(),
  pauseReason: PauseReason.nullable(),
});
export type EngineStatus = z.infer<typeof EngineStatus>;

export const ProtocolNotice = z.object({
  code: z.literal("protocol_mismatch"),
  message: z.string(),
  serverProtocolVersion: z.number().int(),
});
export type ProtocolNotice = z.infer<typeof ProtocolNotice>;
