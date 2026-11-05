import type { Bot, ChatMessage, ChatState, Run, ServerEvent } from "@beebot/contracts";
import { beforeAll, expect, it, vi } from "vite-plus/test";

import type { ConnectionState } from "./serverConnection";

const bot: Bot = {
  id: "bot",
  name: "Ada",
  personality: "",
  status: "ready",
  pauseReason: null,
  roomId: "room",
  engineAccountId: "fake",
};
const message = (id: string): ChatMessage => ({
  id,
  roomId: "room",
  author: "human",
  body: id,
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

const emptyChat: ChatState = { bots: [], accounts: [], messages: [], runs: [] };

const state = (seq: number, chat: Partial<ChatState> = {}): ConnectionState => ({
  status: "connected",
  notice: undefined,
  seq,
  chat: { ...emptyChat, ...chat },
  drafts: {},
  commandError: undefined,
});

let applyServerMessage: typeof import("./serverConnection").applyServerMessage;

beforeAll(async () => {
  vi.stubGlobal("window", { location: { search: "" } });
  ({ applyServerMessage } = await import("./serverConnection"));
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
