// @vitest-environment jsdom
import type {
  Approval,
  Bot,
  ChatState,
  Continuation,
  Meeting,
  MeetingRecord,
  MemoryItem,
  Routine,
  RoutineFiring,
  TeamRequest,
} from "@beebot/contracts";
import { expect, it } from "vite-plus/test";

import { memoriesToReview, ownerActions, waitingItems, waitingKind } from "./needsYou";

const bot = (id: string, archivedAt: string | null = null) => ({ id, name: id, archivedAt }) as Bot;

const approval = (id: string, botId: string, status: Approval["status"], createdAt: string) =>
  ({ id, botId, status, createdAt, tool: "Bash" }) as Approval;

const chat = (parts: Partial<ChatState>) =>
  ({
    bots: [],
    approvals: [],
    continuations: [],
    routines: [],
    firings: [],
    memories: [],
    runs: [],
    teamRequests: [],
    ...parts,
  }) as unknown as ChatState;

it("lists pending approvals, waiting continuations and ready routine cards, oldest first", () => {
  const items = waitingItems(
    chat({
      bots: [bot("ada"), bot("max")],
      approvals: [
        approval("a1", "ada", "pending", "2026-01-01T00:03:00Z"),
        approval("a2", "ada", "allowed", "2026-01-01T00:00:00Z"),
      ],
      continuations: [
        {
          id: "c1",
          botId: "max",
          kind: "hand_off",
          createdAt: "2026-01-01T00:01:00Z",
        } as Continuation,
      ],
      routines: [{ id: "r1", botId: "max" } as Routine],
      firings: [
        { id: "f1", routineId: "r1", status: "ready", createdAt: "2026-01-01T00:02:00Z" },
        { id: "f2", routineId: "r1", status: "ran", createdAt: "2026-01-01T00:00:00Z" },
      ] as RoutineFiring[],
    }),
  );
  expect(items.map(({ id }) => id)).toEqual(["c1", "f1", "a1"]);
  expect(items.map(waitingKind)).toEqual(["Hand-off", "Routine", "Command"]);
});

it("leaves out archived bots, whose chats can't be opened", () => {
  const state = chat({
    bots: [bot("ada", "2026-01-01T00:00:00Z")],
    approvals: [approval("a1", "ada", "pending", "2026-01-01T00:00:00Z")],
    memories: [{ id: "m1", botId: "ada", status: "pending" } as MemoryItem],
  });
  expect(waitingItems(state)).toEqual([]);
  expect(memoriesToReview(state)).toEqual([]);
});

it("lists a bot paused for budget, and drops an archived one", () => {
  const ada = { ...bot("ada"), pauseReason: "budget" } as Bot;
  const items = waitingItems(
    chat({
      bots: [
        ada,
        { ...bot("max", "2026-01-01T00:00:00Z"), pauseReason: "budget" } as Bot,
        { ...bot("eve"), pauseReason: "owner" } as Bot,
      ],
      runs: [{ botId: "ada", endedAt: "2026-01-01T00:05:00Z" }] as ChatState["runs"],
    }),
  );
  expect(items).toEqual([
    { kind: "budget", id: "budget:ada", botId: "ada", createdAt: "2026-01-01T00:05:00Z", bot: ada },
  ]);
});

it("lists pending team requests with the other waiting items, oldest first, and leaves out an archived lead's", () => {
  const request = (id: string, requestedByBotId: string, createdAt: string) =>
    ({ id, kind: "create_bot", requestedByBotId, createdAt }) as TeamRequest;
  const items = waitingItems(
    chat({
      bots: [bot("ada"), bot("max", "2026-01-01T00:00:00Z")],
      approvals: [approval("a1", "ada", "pending", "2026-01-01T00:02:00Z")],
      teamRequests: [
        request("t1", "ada", "2026-01-01T00:03:00Z"),
        request("t2", "ada", "2026-01-01T00:01:00Z"),
        request("t3", "max", "2026-01-01T00:00:00Z"),
      ],
    }),
  );
  expect(items.map(({ id }) => id)).toEqual(["t2", "a1", "t1"]);
  expect(items.map(({ botId }) => botId)).toEqual(["ada", "ada", "ada"]);
  expect(items.map(waitingKind)).toEqual(["New bot", "Command", "New bot"]);
});

it("lists owner-owned meeting actions until they are done, oldest first", () => {
  const action = (id: string, createdAt: string, fields: Partial<MeetingRecord> = {}) =>
    ({
      id,
      kind: "action",
      ownerIsHuman: true,
      doneAt: null,
      createdAt,
      ...fields,
    }) as MeetingRecord;
  const open = action("open", "2026-01-01T00:02:00Z");
  const done = action("done", "2026-01-01T00:00:00Z", { doneAt: "2026-01-01T00:03:00Z" });
  const botOwned = action("bot", "2026-01-01T00:00:00Z", { ownerIsHuman: false });
  const older = action("older", "2026-01-01T00:01:00Z");
  const meetings = [
    { id: "m1", records: [open, done, botOwned] },
    { id: "m2", records: [older, { ...older, id: "note", kind: "note" }] },
  ] as Meeting[];
  expect(ownerActions(chat({ meetings })).map(({ record }) => record.id)).toEqual([
    "older",
    "open",
  ]);
});
