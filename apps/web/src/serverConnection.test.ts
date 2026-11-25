import type {
  Approval,
  Bot,
  ChatMessage,
  ChatState,
  Meeting,
  MeetingRecord,
  MemoryItem,
  PendingApproval,
  Routine,
  RoutineFiring,
  Run,
  ServerEvent,
  ServerMessage,
  Task,
} from "@beebot/contracts";
import { limitDefaults } from "@beebot/contracts";
import { beforeAll, expect, it, vi } from "vite-plus/test";

import type { ConnectionState, LiveTool } from "./serverConnection";
import { buildTranscript, isOpenItem } from "./transcript";

const bot: Bot = {
  id: "bot",
  name: "Ada",
  personality: "",
  summary: null,
  status: "ready",
  pauseReason: null,
  roomId: "room",
  engineAccountId: "fake",
  model: "sonnet",
  effort: null,
  mode: "build",
  access: "supervised",
  boundary: "host",
  manifest: [],
  control: "none",
  egressAnySite: true,
  egressHosts: [],
  unattendedLane: "api_key",
  avatarSeed: 7,
  projectPath: null,
  archivedAt: null,
  dailyTokenCap: null,
  dailyUsdCap: null,
  parentBotId: null,
  version: 1,
};
const message = (id: string): ChatMessage => ({
  id,
  roomId: "room",
  author: "human",
  body: id,
  tools: [],
  workedMs: null,
  botId: null,
  replyToId: null,
  chainId: null,
  hop: 0,
  attachments: [],
  createdAt: "now",
});
const run = (status: Run["status"]): Run => ({
  id: "run",
  botId: "bot",
  status,
  reason: null,
  createdAt: "now",
  startedAt: "now",
  endedAt: null,
  chainId: null,
  hop: 0,
  depth: 0,
  taskId: null,
});

const messageEvent = (seq: number): ServerEvent => ({
  seq,
  createdAt: "now",
  type: "message.created",
  message: message(`m${seq}`),
});

const approval = (status: Approval["status"]): Approval => ({
  id: "approval",
  runId: "run",
  botId: "bot",
  tool: "Bash",
  digest: "digest",
  status,
  reason: null,
  createdAt: "now",
  decidedAt: null,
});
const pending = (id: string): PendingApproval => ({
  id,
  detail: "ls",
  change: null,
  canAlwaysAllow: false,
  expiresAt: "later",
});

const memory = (id: string, status: MemoryItem["status"]): MemoryItem => ({
  id,
  botId: "bot",
  type: "user",
  source: "agent",
  sourceRef: "run:run",
  status,
  created: "now",
  supersededBy: null,
  text: id,
  scope: "bot",
});
const memoryEvent = (seq: number, item: MemoryItem): ServerEvent => ({
  seq,
  createdAt: "now",
  type: "memory.changed",
  memory: item,
});

const emptyChat: ChatState = {
  bots: [],
  accounts: [],
  messages: [],
  runs: [],
  approvals: [],
  memories: [],
  usageLimits: [],
  routines: [],
  skills: [],
  connectors: [],
  firings: [],
  rooms: [],
  tasks: [],
  noticeAcknowledgedAt: null,
  usageData: null,
  limits: limitDefaults,
  boxes: [],
  continuations: [],
  vault: { apiKeys: [] },
  automatedAccessAcknowledgedAt: null,
  teamRequests: [],
  leadsActWithoutAsking: false,
  meetings: [],
};

const state = (seq: number, chat: Partial<ChatState> = {}): ConnectionState => ({
  status: "connected",
  loaded: true,
  seq,
  chat: { ...emptyChat, ...chat },
  models: undefined,
  boxAvailability: undefined,
  hostControl: undefined,
  drafts: {},
  liveTools: {},
  thinking: {},
  pending: [],
  engine: undefined,
  engineChecking: false,
  lastSeen: {},
  commandError: undefined,
  thumbnails: {},
  held: [],
  activity: {},
});

let applyServerMessage: typeof import("./serverConnection").applyServerMessage;
let notificationBodies: typeof import("./serverConnection").notificationBodies;
let openCards: typeof import("./serverConnection").openCards;

beforeAll(async () => {
  vi.stubGlobal("window", { location: { search: "" } });
  ({ applyServerMessage, notificationBodies, openCards } = await import("./serverConnection"));
});

it("drops replayed and live events it already has", () => {
  const replayed = applyServerMessage(state(2, { messages: [message("m2")] }), {
    type: "replay",
    events: [messageEvent(1), messageEvent(2), messageEvent(3)],
  });
  expect(replayed.seq).toBe(3);
  expect(replayed.chat.messages.map(({ id }) => id)).toEqual(["m2", "m3"]);

  const live = applyServerMessage(replayed, { type: "event", event: messageEvent(3) });
  expect(live.chat.messages.map(({ id }) => id)).toEqual(["m2", "m3"]);
});

it("replaces its state on a snapshot, even when the cursor moves back", () => {
  const chat = { ...emptyChat, messages: [message("m4")] };
  const next = applyServerMessage(state(9, { messages: [message("m9")] }), {
    type: "snapshot",
    seq: 4,
    state: chat,
  });
  expect(next.seq).toBe(4);
  expect(next.chat).toEqual(chat);
});

it("reaches the same state by replay as by snapshot", () => {
  const events: ServerEvent[] = [
    { seq: 1, createdAt: "now", type: "bot.changed", bot },
    { ...messageEvent(2) },
    { seq: 3, createdAt: "now", type: "run.changed", run: run("Queued") },
    { seq: 4, createdAt: "now", type: "run.changed", run: run("Running") },
    { seq: 5, createdAt: "now", type: "bot.changed", bot: { ...bot, name: "Ben" } },
    { seq: 6, createdAt: "now", type: "run.changed", run: run("Interrupted") },
  ];
  const chat: ChatState = {
    bots: [{ ...bot, name: "Ben" }],
    accounts: [],
    messages: [message("m2")],
    runs: [run("Interrupted")],
    approvals: [],
    memories: [],
    usageLimits: [],
    routines: [],
    skills: [],
    connectors: [],
    firings: [],
    rooms: [],
    tasks: [],
    noticeAcknowledgedAt: null,
    usageData: null,
    limits: limitDefaults,
    boxes: [],
    continuations: [],
    vault: { apiKeys: [] },
    automatedAccessAcknowledgedAt: null,
    teamRequests: [],
    leadsActWithoutAsking: false,
    meetings: [],
  };
  const replayed = applyServerMessage(state(0), { type: "replay", events });
  const snapshotted = applyServerMessage(state(0), { type: "snapshot", seq: 6, state: chat });
  expect(replayed).toEqual(snapshotted);
});

it("replaces limits on limits.changed", () => {
  const limits = { ...limitDefaults, depth: 4 };
  const next = applyServerMessage(state(0), {
    type: "event",
    event: { seq: 1, createdAt: "now", type: "limits.changed", limits },
  });
  expect(next.chat.limits).toEqual(limits);
});

it("keeps queued and waiting tasks, and drops finished ones", () => {
  const task = (status: Task["status"]): ServerEvent => ({
    seq: 1,
    createdAt: "now",
    type: "task.changed",
    task: {
      id: "task",
      kind: "delegate",
      chainId: "chain",
      hop: 1,
      depth: 1,
      parentRunId: "run",
      requesterBotId: "bot",
      ownerBotId: "ben",
      roomId: "room",
      goal: "Look it up",
      status,
      resultMessageId: null,
      parentTaskId: null,
      rootTaskId: "task",
      origin: "human",
      doneWhen: null,
      outcome: null,
      progressAt: null,
      needsApproval: null,
      blockedBy: [],
      createdAt: "now",
      updatedAt: "now",
    },
  });
  const apply = (from: ConnectionState, status: Task["status"]) =>
    applyServerMessage(from, { type: "event", event: { ...task(status), seq: from.seq + 1 } });
  const queued = apply(state(0), "queued");
  expect(queued.chat.tasks.map(({ status }) => status)).toEqual(["queued"]);
  const waiting = apply(queued, "needs_input");
  expect(waiting.chat.tasks.map(({ status }) => status)).toEqual(["needs_input"]);
  expect(apply(waiting, "done").chat.tasks).toEqual([]);
});

it("reaches the same memories by replay as by snapshot, without superseded or forgotten items", () => {
  const events = [
    memoryEvent(1, memory("old", "active")),
    memoryEvent(2, memory("doomed", "active")),
    memoryEvent(3, memory("rejected", "pending")),
    memoryEvent(4, memory("approved", "pending")),
    memoryEvent(5, memory("waiting", "pending")),
    memoryEvent(6, memory("new", "active")),
    memoryEvent(7, { ...memory("old", "superseded"), supersededBy: "new" }),
    memoryEvent(8, memory("doomed", "forgotten")),
    memoryEvent(9, memory("rejected", "forgotten")),
    memoryEvent(10, memory("approved", "active")),
  ];
  const chat = {
    ...emptyChat,
    memories: [memory("approved", "active"), memory("waiting", "pending"), memory("new", "active")],
  };
  const replayed = applyServerMessage(state(0), { type: "replay", events });
  const snapshotted = applyServerMessage(state(0), { type: "snapshot", seq: 10, state: chat });
  expect(replayed).toEqual(snapshotted);
});

const meeting = (
  id: string,
  status: Meeting["status"],
  records: Meeting["records"] = [],
): Meeting => ({
  id,
  roomId: "room",
  facilitatorBotId: "bot",
  title: id,
  scheduledAt: "now",
  timeboxMin: 30,
  status,
  participants: [],
  agenda: [],
  currentItem: null,
  round: 0,
  maxRoundsPerItem: 2,
  minutesMessageId: null,
  turnCap: null,
  turnsUsed: 0,
  startedAt: null,
  endsAt: null,
  timesUpAt: null,
  endedAt: null,
  createdAt: "now",
  records,
});
const meetingEvent = (seq: number, changed: Meeting): ServerEvent => ({
  seq,
  createdAt: "now",
  type: "meeting.changed",
  meeting: changed,
});

it("reaches the same meetings by replay as by snapshot, dropping closed meetings with no open owner action", () => {
  const ownerAction: MeetingRecord = {
    id: "r1",
    meetingId: "m2",
    kind: "action",
    itemId: "1",
    text: "Get keys",
    ownerBotId: null,
    ownerIsHuman: true,
    taskId: null,
    due: null,
    proposalId: null,
    options: [],
    doneAt: null,
    createdByBotId: "bot",
    createdAt: "now",
  };
  const events = [
    meetingEvent(1, meeting("m1", "scheduled")),
    meetingEvent(2, meeting("m2", "running")),
    meetingEvent(3, meeting("m1", "running")),
    meetingEvent(4, meeting("m1", "closed")),
    meetingEvent(5, meeting("m2", "closed", [ownerAction])),
  ];
  const snapshot = { ...emptyChat, meetings: [meeting("m2", "closed", [ownerAction])] };
  const replayed = applyServerMessage(state(0), { type: "replay", events });
  const snapshotted = applyServerMessage(state(0), { type: "snapshot", seq: 5, state: snapshot });
  expect(replayed).toEqual(snapshotted);
  expect(replayed.chat.meetings.map(({ id }) => id)).toEqual(["m2"]);

  const done = { ...ownerAction, doneAt: "later" };
  const finished = applyServerMessage(replayed, {
    type: "event",
    event: meetingEvent(6, meeting("m2", "closed", [done])),
  });
  expect(finished.chat.meetings).toEqual([]);

  const deleted = applyServerMessage(replayed, {
    type: "event",
    event: { seq: 6, createdAt: "now", type: "bot.deleted", botId: "bot" },
  });
  expect(deleted.chat.meetings).toEqual([]);
});

it("accumulates deltas and clears them when the run ends, keeping the cursor", () => {
  const running = state(3, { runs: [run("Running")] });
  const first = applyServerMessage(running, { type: "delta", runId: "run", text: "Hel" });
  const second = applyServerMessage(first, { type: "delta", runId: "run", text: "lo" });
  expect(second.drafts).toEqual({ run: "Hello" });
  expect(second.seq).toBe(3);

  const ended = applyServerMessage(second, {
    type: "event",
    event: { seq: 4, createdAt: "now", type: "run.changed", run: run("Completed") },
  });
  expect(ended.drafts).toEqual({});
});

it("drops a draft on a snapshot once its run is over, and keeps a live one", () => {
  const drafting = { ...state(3), drafts: { run: "Hel" } };
  const snapshot = (status: Run["status"]) =>
    applyServerMessage(drafting, {
      type: "snapshot",
      seq: 5,
      state: { ...emptyChat, runs: [run(status)] },
    });
  expect(snapshot("Interrupted").drafts).toEqual({});
  expect(snapshot("Running").drafts).toEqual({ run: "Hel" });
});

it("replaces the pending set instead of merging it", () => {
  const first = applyServerMessage(state(1), {
    type: "pending-approvals",
    approvals: [pending("a"), pending("b")],
  });
  const second = applyServerMessage(first, {
    type: "pending-approvals",
    approvals: [pending("c")],
  });
  expect(second.pending.map(({ id }) => id)).toEqual(["c"]);
});

it("shows a pending card again after a reconnect snapshot, and not before its detail arrives", () => {
  const chat = { ...emptyChat, approvals: [approval("pending")] };
  const cards = ({ chat, pending }: ConnectionState) =>
    buildTranscript(chat.messages, chat.approvals, pending, []);

  const snapshotted = applyServerMessage(state(9), { type: "snapshot", seq: 4, state: chat });
  expect(cards(snapshotted)).toEqual([]);

  const resent = applyServerMessage(snapshotted, {
    type: "pending-approvals",
    approvals: [pending("approval")],
  });
  expect(cards(resent)).toMatchObject([{ kind: "approval", pending: { detail: "ls" } }]);

  const stale = { ...state(9), pending: [pending("approval")] };
  const again = applyServerMessage(stale, { type: "snapshot", seq: 4, state: chat });
  expect(cards(again)).toMatchObject([{ kind: "approval", pending: { detail: "ls" } }]);
});

it("keeps an answered approval in the transcript with no card content", () => {
  const items = buildTranscript([], [approval("denied")], [pending("approval")], []);
  expect(items).toMatchObject([{ kind: "approval", pending: undefined }]);
});

it("merges messages and approvals by time", () => {
  const items = buildTranscript(
    [
      { ...message("first"), createdAt: "2026-01-01T00:00:01.000Z" },
      { ...message("third"), createdAt: "2026-01-01T00:00:03.000Z" },
    ],
    [{ ...approval("allowed"), createdAt: "2026-01-01T00:00:02.000Z" }],
    [],
    [],
  );
  expect(items.map(({ kind }) => kind)).toEqual(["message", "approval", "message"]);
});

const toolStart = (toolId: string, detail: string | null = null): ServerMessage => ({
  type: "tool-start",
  runId: "run",
  toolId,
  name: "Read",
  detail,
});
const tool = (id: string, fields: Partial<LiveTool> = {}): LiveTool => ({
  id,
  name: "Read",
  detail: null,
  status: "running",
  ...fields,
});

it("upserts live tools by id and marks how they ended", () => {
  const running = state(3, { runs: [run("Running")] });
  const started = [toolStart("a"), toolStart("a", "notes.md"), toolStart("b")].reduce(
    applyServerMessage,
    running,
  );
  expect(started.liveTools.run).toEqual([tool("a", { detail: "notes.md" }), tool("b")]);

  const ended = [
    { type: "tool-end", runId: "run", toolId: "a", failed: true },
    { type: "tool-end", runId: "run", toolId: "b", failed: false },
  ] satisfies ServerMessage[];
  expect(ended.reduce(applyServerMessage, started).liveTools.run?.map((t) => t.status)).toEqual([
    "failed",
    "done",
  ]);
});

it.each(["Completed", "WaitingUser"] as const)(
  "drops the live tools of a turn that ends %s, since its reply carries them",
  (status) => {
    const working = {
      ...state(3, { bots: [bot], runs: [run("Running")] }),
      liveTools: { run: [tool("a", { detail: "notes.md" })] },
    };
    const reply = { ...message("reply"), author: "bot" as const };
    const replied = applyServerMessage(working, {
      type: "event",
      event: { seq: 4, createdAt: "now", type: "message.created", message: reply },
    });
    const ended = applyServerMessage(replied, {
      type: "event",
      event: { seq: 5, createdAt: "now", type: "run.changed", run: run(status) },
    });
    expect(ended.liveTools).toEqual({});
  },
);

it("keeps the tools of a turn with no reply until the bot's next run", () => {
  const working = {
    ...state(3, { bots: [bot], runs: [run("Running")] }),
    liveTools: { run: [tool("a")] },
  };
  const failed = applyServerMessage(working, {
    type: "event",
    event: { seq: 4, createdAt: "now", type: "run.changed", run: run("Failed") },
  });
  expect(failed.liveTools.run).toHaveLength(1);
  const next = applyServerMessage(failed, {
    type: "event",
    event: {
      seq: 5,
      createdAt: "now",
      type: "run.changed",
      run: { ...run("Queued"), id: "next" },
    },
  });
  expect(next.liveTools).toEqual({});
});

it("appends thought text and drops it with the run", () => {
  const thinking = (active: boolean, text: string): ServerMessage => ({
    type: "thinking",
    runId: "run",
    active,
    text,
  });
  const live = [thinking(true, ""), thinking(true, "one "), thinking(true, "two")].reduce(
    applyServerMessage,
    state(3, { runs: [run("Running")] }),
  );
  expect(live.thinking).toEqual({ run: { active: true, text: "one two" } });
  const ended = applyServerMessage(live, {
    type: "event",
    event: { seq: 4, createdAt: "now", type: "run.changed", run: run("Failed") },
  });
  expect(ended.thinking).toEqual({});
});

it("drops live tools on a snapshot once their run is over", () => {
  const working = { ...state(3), liveTools: { run: [tool("a")] } };
  const next = applyServerMessage(working, {
    type: "snapshot",
    seq: 5,
    state: { ...emptyChat, runs: [run("Cancelled")] },
  });
  expect(next.liveTools).toEqual({});
});

it("notifies once per finished run or new approval, and never from history", () => {
  const known = {
    ...state(3, { bots: [bot], approvals: [approval("pending")] }),
    pending: [pending("old")],
  };
  const finished: ServerEvent = {
    seq: 4,
    createdAt: "now",
    type: "run.changed",
    run: run("Completed"),
  };

  expect(notificationBodies(known, { type: "event", event: finished })).toEqual(["Ada finished"]);
  expect(notificationBodies({ ...known, seq: 4 }, { type: "replay", events: [finished] })).toEqual(
    [],
  );
  expect(
    notificationBodies(known, {
      type: "snapshot",
      seq: 9,
      state: { ...emptyChat, runs: [run("Completed")] },
    }),
  ).toEqual([]);
  expect(
    notificationBodies(known, {
      type: "pending-approvals",
      approvals: [pending("old"), pending("approval")],
    }),
  ).toEqual(["Ada needs your approval"]);
});

const routine = (id: string): Routine => ({
  id,
  botId: "bot",
  name: "Standup",
  prompt: "Say hi",
  kind: "cron",
  cron: "0 9 * * *",
  fireAt: null,
  timezone: "UTC",
  enabled: true,
  skipIfLaterMins: null,
  nextFireAt: "later",
  staggerMs: 0,
  pausedReason: null,
  lastTickAt: null,
  lastAttemptAt: null,
  createdAt: "now",
});
const firing = (
  id: string,
  routineId: string,
  status: RoutineFiring["status"],
  reason: RoutineFiring["reason"] = null,
): RoutineFiring => ({
  id,
  routineId,
  slot: id,
  status,
  reason,
  missedBefore: 0,
  attempts: 0,
  retryAt: null,
  createdAt: "now",
  decidedAt: null,
});
const firingEvent = (seq: number, changed: RoutineFiring): ServerEvent => ({
  seq,
  createdAt: "now",
  type: "firing.changed",
  firing: changed,
});

it("reaches the same routines and firings by replay as by snapshot", () => {
  const routineEvent = (seq: number, id: string): ServerEvent => ({
    seq,
    createdAt: "now",
    type: "routine.changed",
    routine: routine(id),
  });
  const events: ServerEvent[] = [
    routineEvent(1, "a"),
    routineEvent(2, "b"),
    routineEvent(3, "gone"),
    firingEvent(4, firing("a1", "a", "ready")),
    firingEvent(5, firing("b1", "b", "ready")),
    firingEvent(6, firing("gone1", "gone", "ready")),
    // A new slot: the old card closes first, then the new firing replaces it.
    firingEvent(7, firing("a1", "a", "skipped", "no_boundary")),
    firingEvent(8, firing("a2", "a", "ready")),
    firingEvent(9, firing("b1", "b", "ran")),
    { seq: 10, createdAt: "now", type: "routine.deleted", routineId: "gone" },
  ];
  const chat: ChatState = {
    ...emptyChat,
    routines: [routine("a"), routine("b")],
    firings: [firing("b1", "b", "ran"), firing("a2", "a", "ready")],
  };
  const replayed = applyServerMessage(state(0), { type: "replay", events });
  const snapshotted = applyServerMessage(state(0), { type: "snapshot", seq: 10, state: chat });
  const byRoutine = (firings: RoutineFiring[]) =>
    firings.toSorted((a, b) => a.routineId.localeCompare(b.routineId));
  expect(byRoutine(replayed.chat.firings)).toEqual(byRoutine(snapshotted.chat.firings));
  expect(replayed.chat.routines).toEqual(snapshotted.chat.routines);
  expect(replayed.seq).toBe(snapshotted.seq);
});

it("notifies once for a new ready firing, never for a closed one or from history", () => {
  const known = state(3, { bots: [bot], routines: [routine("a")] });
  const ready = firingEvent(4, firing("a1", "a", "ready"));

  expect(notificationBodies(known, { type: "event", event: ready })).toEqual([
    "Standup is ready to run",
  ]);
  const seen = applyServerMessage(known, { type: "event", event: ready });
  expect(notificationBodies(seen, { type: "replay", events: [ready] })).toEqual([]);
  expect(
    notificationBodies(known, { type: "event", event: firingEvent(5, firing("a1", "a", "ran")) }),
  ).toEqual([]);
  expect(
    notificationBodies(known, {
      type: "snapshot",
      seq: 9,
      state: { ...emptyChat, firings: [firing("a1", "a", "ready")] },
    }),
  ).toEqual([]);
});

it("shows only a bot's open firings as cards, among the items waiting at the bottom", () => {
  const chat: ChatState = {
    ...emptyChat,
    routines: [routine("a"), { ...routine("b"), botId: "other" }, routine("c")],
    firings: [firing("a1", "a", "ready"), firing("b1", "b", "ready"), firing("c1", "c", "ran")],
  };
  const cards = openCards(chat, "bot");
  expect(cards.map(({ firing: { id } }) => id)).toEqual(["a1"]);
  expect(buildTranscript([message("m")], [], [], cards).map(isOpenItem)).toEqual([false, true]);
});
