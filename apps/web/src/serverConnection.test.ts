import type {
  Approval,
  Bot,
  ChatMessage,
  ChatState,
  PendingApproval,
  Run,
  ServerEvent,
} from "@beebot/contracts";
import { beforeAll, expect, it, vi } from "vite-plus/test";

import type { ConnectionState } from "./serverConnection";
import { buildTranscript } from "./transcript";

const bot: Bot = {
  id: "bot",
  name: "Ada",
  personality: "",
  status: "ready",
  pauseReason: null,
  roomId: "room",
  engineAccountId: "fake",
  model: "sonnet",
};
const message = (id: string): ChatMessage => ({
  id,
  roomId: "room",
  author: "human",
  body: id,
  tools: [],
  createdAt: "now",
});
const run = (status: Run["status"]): Run => ({
  id: "run",
  botId: "bot",
  status,
  reason: null,
  createdAt: "now",
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
  canAlwaysAllow: false,
  expiresAt: "later",
});

const emptyChat: ChatState = {
  bots: [],
  accounts: [],
  messages: [],
  runs: [],
  approvals: [],
  noticeAcknowledgedAt: null,
};

const state = (seq: number, chat: Partial<ChatState> = {}): ConnectionState => ({
  status: "connected",
  loaded: true,
  seq,
  chat: { ...emptyChat, ...chat },
  drafts: {},
  liveTools: {},
  pending: [],
  engine: undefined,
  engineChecking: false,
  lastSeen: {},
  commandError: undefined,
});

let applyServerMessage: typeof import("./serverConnection").applyServerMessage;
let notificationBodies: typeof import("./serverConnection").notificationBodies;

beforeAll(async () => {
  vi.stubGlobal("window", { location: { search: "" } });
  ({ applyServerMessage, notificationBodies } = await import("./serverConnection"));
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
    noticeAcknowledgedAt: null,
  };
  const replayed = applyServerMessage(state(0), { type: "replay", events });
  const snapshotted = applyServerMessage(state(0), { type: "snapshot", seq: 6, state: chat });
  expect(replayed).toEqual(snapshotted);
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
    buildTranscript(chat.messages, chat.approvals, pending);

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
  const items = buildTranscript([], [approval("denied")], [pending("approval")]);
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
  );
  expect(items.map(({ kind }) => kind)).toEqual(["message", "approval", "message"]);
});

it("collects live tools and clears them when the run ends", () => {
  const running = state(3, { runs: [run("Running")] });
  const first = applyServerMessage(running, { type: "tool", runId: "run", name: "Read" });
  const second = applyServerMessage(first, { type: "tool", runId: "run", name: "Read" });
  expect(second.liveTools).toEqual({ run: ["Read", "Read"] });

  const ended = applyServerMessage(second, {
    type: "event",
    event: { seq: 4, createdAt: "now", type: "run.changed", run: run("Completed") },
  });
  expect(ended.liveTools).toEqual({});
});

it("drops live tools on a snapshot once their run is over", () => {
  const working = { ...state(3), liveTools: { run: ["Bash"] } };
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
