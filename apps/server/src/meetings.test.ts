import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { callBotTool } from "./botTools.ts";
import { canTransition, turnCap } from "./meetings.ts";
import { type EventStore, openEventStore } from "./store.ts";

let dataDir: string;
let store: EventStore;
let db: DatabaseSync;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-meetings-"));
  store = openEventStore(dataDir);
  cleanups.push(() => store.close());
  db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"), { timeout: 5000 });
  db.exec("PRAGMA foreign_keys = ON");
  cleanups.push(() => db.close());
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

function team(...names: string[]) {
  const bots = names.map((name) =>
    store.createBot({ name, personality: "", engineAccountId: "fake" }),
  );
  const room = store.rooms.createGroupRoom({ name: "Team", memberIds: bots.map(({ id }) => id) });
  if (!room) {
    throw new Error("no room");
  }
  return { bots, room };
}

function start(botId: string) {
  const now = new Date().toISOString();
  const wake = store.dueWakes(now).find((due) => due.botId === botId);
  if (!wake) {
    throw new Error(`no wake for ${botId}`);
  }
  store.queueRun(wake);
  const queued = store.queuedRuns().find((run) => run.botId === botId);
  const claimed = queued && store.claimRun(queued.id, "boot", now);
  if (!claimed) {
    throw new Error(`no run for ${botId}`);
  }
  return claimed;
}

function insertMeeting(input: { id: string; roomId: string; botId: string; status: string }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO meetings (id, room_id, facilitator_bot_id, title, scheduled_at, timebox_min,
       status, participants_json, agenda_json, created_at, updated_at)
     VALUES (?, ?, ?, 'Sync', ?, 30, ?, '[]', '[]', ?, ?)`,
  ).run(input.id, input.roomId, input.botId, now, input.status, now, now);
}

function insertRecord(input: { meetingId: string; kind: string; taskId?: string }) {
  db.prepare(
    `INSERT INTO meeting_records (id, meeting_id, kind, text, task_id, created_by_bot_id,
       created_at)
     VALUES (?, ?, ?, 'Ship it', ?, 'bot', ?)`,
  ).run(crypto.randomUUID(), input.meetingId, input.kind, input.taskId ?? null, "now");
}

const rows = (sql: string) => db.prepare(sql).all();

// Ava delegates to Dee, so the task's requester is Ava and its owner is Dee.
function actionTask() {
  const { bots, room } = team("Ava", "Dee");
  const [ava, dee] = bots;
  if (!ava || !dee) {
    throw new Error("no team");
  }
  store.sendMessage({ id: crypto.randomUUID(), roomId: ava.roomId, body: "go", attended: true });
  const run = start(ava.id);
  callBotTool(store, { id: run.id, botId: ava.id }, "delegate", { to: "Dee", goal: "Do it" });
  store.finishRun(run.id, "boot", {
    status: "Completed",
    reason: null,
    reply: "Asked.",
    tools: [],
  });
  const [task] = store.state().tasks;
  if (!task) {
    throw new Error("no task");
  }
  insertMeeting({ id: "m1", roomId: room.id, botId: ava.id, status: "running" });
  insertRecord({ meetingId: "m1", kind: "action", taskId: task.id });
  return { ava, dee };
}

describe("the meetings migration", () => {
  it("allows one live meeting per room and rejects an unknown record kind", () => {
    const { bots, room } = team("Ava");
    const botId = bots[0]?.id ?? "";
    insertMeeting({ id: "m1", roomId: room.id, botId, status: "scheduled" });
    expect(() => insertMeeting({ id: "m2", roomId: room.id, botId, status: "open" })).toThrow(
      /UNIQUE/,
    );
    insertMeeting({ id: "m3", roomId: room.id, botId, status: "closed" });
    expect(() => insertRecord({ meetingId: "m1", kind: "vote" })).toThrow(/CHECK/);
  });

  it("deleting a facilitator removes its meetings and unlinks action tasks it owned", () => {
    const { ava } = actionTask();
    store.deleteBot(ava.id);
    expect(rows("SELECT id FROM meetings")).toEqual([]);
    expect(rows("SELECT id FROM meeting_records")).toEqual([]);
  });

  it("unlinks an action's task when the task's owner is deleted, keeping the record", () => {
    const { dee } = actionTask();
    store.deleteBot(dee.id);
    expect(rows("SELECT task_id FROM meeting_records")).toEqual([{ task_id: null }]);
  });
});

function seedMeeting(input: { status: string; turnCap?: number; turnsUsed?: number }) {
  const { bots, room } = team("Ava");
  const id = crypto.randomUUID();
  insertMeeting({ id, roomId: room.id, botId: bots[0]?.id ?? "", status: input.status });
  db.prepare("UPDATE meetings SET turn_cap = ?, turns_used = ? WHERE id = ?").run(
    input.turnCap ?? null,
    input.turnsUsed ?? 0,
    id,
  );
  const meeting = store.meetings.get(id);
  if (!meeting) {
    throw new Error("no meeting");
  }
  return meeting;
}

describe("meeting rules", () => {
  const now = new Date().toISOString();

  it("caps turns by the contract formula", () => {
    expect(turnCap(3, 3, 2)).toBe(18 + 13);
    expect(turnCap(4, 3, 2)).toBe(24 + 13);
  });

  it("allows only forward transitions and treats closed and cancelled as terminal", () => {
    expect(canTransition("scheduled", "open")).toBe(true);
    expect(canTransition("scheduled", "running")).toBe(false);
    expect(canTransition("open", "running")).toBe(true);
    expect(canTransition("running", "closed")).toBe(true);
    expect(canTransition("closed", "running")).toBe(false);
    expect(canTransition("cancelled", "open")).toBe(false);
  });

  it("refuses an illegal transition in the store and leaves the row unchanged", () => {
    const m = seedMeeting({ status: "scheduled" });
    expect(store.meetings.transition(m.id, "running", now)).toEqual({
      refused: "illegal_transition",
    });
    expect(store.meetings.get(m.id)?.status).toBe("scheduled");
  });

  it("ends a meeting on a terminal transition and frees the room", () => {
    const m = seedMeeting({ status: "running" });
    expect(store.meetings.transition(m.id, "closed", now)).toMatchObject({
      status: "closed",
      endedAt: now,
    });
    expect(store.meetings.live(m.roomId)).toBeUndefined();
    expect(store.state().meetings).toEqual([]);
  });

  it("never reserves past the cap", () => {
    const m = seedMeeting({ status: "running", turnCap: 5, turnsUsed: 3 });
    expect(store.meetings.reserve(m.id, 3)).toBe(false);
    expect(store.meetings.reserve(m.id, 2)).toBe(true);
    expect(store.meetings.get(m.id)?.turnsUsed).toBe(5);
  });

  it("keeps a closed meeting visible while an owner action is open", () => {
    const m = seedMeeting({ status: "closed" });
    db.prepare(
      `INSERT INTO meeting_records (id, meeting_id, kind, text, owner_is_human,
         created_by_bot_id, created_at) VALUES (?, ?, 'action', 'Get keys', 1, 'bot', ?)`,
    ).run(crypto.randomUUID(), m.id, now);
    expect(store.state().meetings.map(({ id }) => id)).toEqual([m.id]);
    expect(store.state().meetings[0]?.records[0]).toMatchObject({ ownerIsHuman: true });
  });
});
