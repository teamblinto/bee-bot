import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { type EventStore, migrate, migrations, openEventStore } from "./store.ts";
import type { TaskInput } from "./tasks.ts";

let dataDir: string;
let store: EventStore | undefined;
const dbPath = () => NodePath.join(dataDir, "beebot.db");

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-coordination-"));
});

afterEach(() => {
  store?.close();
  store = undefined;
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

const rows = (db: DatabaseSync, sql: string) =>
  db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));

describe("the coordination migration", () => {
  it("keeps runs, approvals and their link from a v14 database", () => {
    const db = new DatabaseSync(dbPath());
    migrate(
      db,
      migrations.findIndex(({ name }) => name === "coordination"),
    );
    db.exec(`INSERT INTO bots (id, name, personality, status, created_at)
        VALUES ('ada', 'Ada', '', 'ready', 'then');
      INSERT INTO rooms (id, default_bot_id, created_at) VALUES ('room', 'ada', 'then');
      INSERT INTO scopes (id, room_id, bot_id) VALUES ('scope', 'room', 'ada');
      INSERT INTO messages (id, room_id, author, body, event_seq, created_at)
        VALUES ('m1', 'room', 'human', 'hi', 1, 'then'), ('m2', 'room', 'bot', 'hello', 2, 'then');
      INSERT INTO routines (id, bot_id, name, prompt, cron, timezone, enabled, created_at)
        VALUES ('routine', 'ada', 'Daily', 'Go', '0 9 * * *', 'UTC', 1, 'then');
      INSERT INTO routine_firings (id, routine_id, slot, status, missed_before, created_at)
        VALUES ('firing', 'routine', 'slot', 'ran', 0, 'then');
      INSERT INTO wakes (id, bot_id, scope_id, idempotency_key, attended, status, created_at)
        VALUES ('w1', 'ada', 'scope', 'message:m1', 1, 'done', 'then'),
          ('w2', 'ada', 'scope', 'message:firing', 1, 'done', 'then'),
          ('w3', 'ada', 'scope', 'continue:r2:x', 1, 'done', 'then');
      INSERT INTO runs (id, bot_id, scope_id, wake_id, engine_account_id, status, created_at)
        VALUES ('r2', 'ada', 'scope', 'w2', 'fake', 'Interrupted', 'then'),
          ('r1', 'ada', 'scope', 'w1', 'fake', 'Completed', 'then');
      INSERT INTO approvals (id, run_id, bot_id, tool, digest, status, created_at)
        VALUES ('a1', 'r1', 'ada', 'Read', 'd', 'allowed', 'then');`);
    db.close();

    store = openEventStore(dataDir);
    const { runs, approvals, messages, rooms } = store.state();
    expect(runs).toMatchObject([{ id: "r1", status: "Completed", chainId: null, hop: 0 }]);
    expect(approvals).toMatchObject([{ id: "a1", runId: "r1" }]);
    expect(messages.map(({ botId }) => botId)).toEqual([null, "ada"]);
    expect(rooms).toEqual([
      {
        id: "room",
        kind: "dm",
        name: null,
        defaultBotId: "ada",
        members: ["ada"],
        createdAt: "then",
      },
    ]);
    expect(store.state().bots.map(({ id }) => id)).toEqual(["ada"]);

    const check = new DatabaseSync(dbPath());
    expect(rows(check, "PRAGMA foreign_key_check")).toEqual([]);
    expect(rows(check, "PRAGMA foreign_key_list(approvals)")).toContainEqual(
      expect.objectContaining({ table: "runs", from: "run_id" }),
    );
    expect(rows(check, "SELECT id FROM runs ORDER BY rowid")).toEqual([{ id: "r2" }, { id: "r1" }]);
    expect(rows(check, "SELECT id, source FROM wakes ORDER BY id")).toEqual([
      { id: "w1", source: "human" },
      { id: "w2", source: "routine" },
      { id: "w3", source: "continue" },
    ]);
    expect(rows(check, "SELECT approved_at AS approvedAt FROM routines")).toEqual([
      { approvedAt: "then" },
    ]);
    check.close();
  });

  it("lets a waiting run free the bot's slot and the account gate", () => {
    store = openEventStore(dataDir);
    const bot = store.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
    const db = new DatabaseSync(dbPath());
    const insertRun = (id: string, status: string) =>
      db.exec(`INSERT INTO wakes (id, bot_id, scope_id, idempotency_key, attended, status, created_at)
          SELECT '${id}', '${bot.id}', id, '${id}', 1, 'done', 'now' FROM scopes;
        INSERT INTO runs (id, bot_id, scope_id, wake_id, engine_account_id, status, created_at)
          SELECT '${id}', '${bot.id}', id, '${id}', 'fake', '${status}', 'now' FROM scopes;`);
    insertRun("user", "WaitingUser");
    insertRun("quota", "WaitingQuota");
    insertRun("running", "Running");
    expect(() => insertRun("second", "Queued")).toThrow(/UNIQUE/);
    db.close();
  });
});

function parentRun(open: EventStore) {
  const bot = open.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
  open.sendMessage({ id: crypto.randomUUID(), roomId: bot.roomId, body: "go", attended: true });
  const [wake] = open.dueWakes(new Date().toISOString());
  if (!wake) {
    throw new Error("no wake");
  }
  open.queueRun(wake);
  const run = open.state().runs[0];
  if (!run) {
    throw new Error("no run");
  }
  return { bot, run };
}

function taskInput(open: EventStore, key: string): TaskInput {
  const { bot, run } = parentRun(open);
  return {
    kind: "delegate",
    chainId: "chain",
    hop: 1,
    depth: 1,
    parentRunId: run.id,
    requesterBotId: bot.id,
    ownerBotId: bot.id,
    roomId: bot.roomId,
    goal: "Look it up",
    deliveryKey: key,
  };
}

describe("tasks", () => {
  it("refuses a run's 4th task, and a repeated key spends nothing", () => {
    store = openEventStore(dataDir);
    const input = taskInput(store, "k0");
    const first = store.tasks.createTask(input, 3);
    expect(store.tasks.createTask(input, 3)).toEqual(first);
    store.tasks.createTask({ ...input, deliveryKey: "k1" }, 3);
    store.tasks.createTask({ ...input, deliveryKey: "k2" }, 3);
    expect(store.tasks.createTask({ ...input, deliveryKey: "k3" }, 3)).toEqual({
      refused: "fan_out",
    });
    expect(store.state().tasks).toHaveLength(3);
  });

  it("lets only 3 of 8 concurrent writers through", async () => {
    store = openEventStore(dataDir);
    const input = taskInput(store, "unused");
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const storeUrl = new URL("./store.ts", import.meta.url).href;
    const code = `
      const { workerData, parentPort } = require("node:worker_threads");
      import(workerData.storeUrl).then(({ openEventStore }) => {
        const store = openEventStore(workerData.dataDir);
        Atomics.wait(workerData.gate, 0, 0);
        const result = store.tasks.createTask(workerData.input, 3);
        store.close();
        parentPort.postMessage("refused" in result ? "refused" : "created");
      });`;
    const results = Array.from({ length: 8 }, (_, index) => {
      const worker = new Worker(code, {
        eval: true,
        workerData: { storeUrl, dataDir, gate, input: { ...input, deliveryKey: `k${index}` } },
      });
      return new Promise<string>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const outcomes = await Promise.all(results);
    expect(outcomes.filter((outcome) => outcome === "created")).toHaveLength(3);
    expect(store.state().tasks).toHaveLength(3);
  }, 30_000);

  it("hands an open task to another bot once", () => {
    store = openEventStore(dataDir);
    const input = taskInput(store, "k");
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    const task = store.tasks.createTask(input, 3);
    if ("refused" in task) {
      throw new Error("refused");
    }
    expect(store.tasks.handoff(task.id, ben.id)).toMatchObject({ ownerBotId: ben.id });
    expect(store.tasks.handoff(task.id, ben.id)).toBeUndefined();
    expect(store.tasks.finishTask(task.id, "done")).toMatchObject({ status: "done" });
    expect(store.tasks.handoff(task.id, input.ownerBotId)).toBeUndefined();
    expect(store.state().tasks).toEqual([]);
  });
});

describe("group rooms", () => {
  it("keeps a member's history when they leave, and lets them back", () => {
    store = openEventStore(dataDir);
    const { bot } = parentRun(store);
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    const room = store.rooms.createGroupRoom({
      name: "Team",
      memberIds: [bot.id, ben.id],
      defaultBotId: bot.id,
    });
    expect(room).toMatchObject({ kind: "group", members: [bot.id, ben.id] });
    const roomId = room?.id ?? "";
    expect(store.rooms.removeMember(roomId, bot.id)).toMatchObject({
      members: [ben.id],
      defaultBotId: null,
    });
    expect(store.rooms.addMember(roomId, bot.id)?.members).toEqual([bot.id, ben.id]);
    expect(store.rooms.addMember(bot.roomId, ben.id)).toBeUndefined();
    expect(store.state().bots.map(({ id }) => id)).toEqual([bot.id, ben.id]);
  });
});

describe("outbox", () => {
  it("backs off a failed delivery, then gives up", () => {
    store = openEventStore(dataDir);
    const { run } = parentRun(store);
    const { effects } = store;
    const item = effects.enqueueOutbox({
      runId: run.id,
      kind: "result",
      payload: { text: "done" },
      idempotencyKey: "once",
    });
    expect(effects.enqueueOutbox({ ...item, payload: {} })).toEqual(item);
    const now = "2026-01-01T00:00:00.000Z";
    const backoff = (attempts: number) => (attempts < 2 ? 60_000 : null);
    effects.markOutboxAttemptFailed(item.id, backoff, now);
    expect(effects.duePendingOutbox(now)).toEqual([]);
    expect(effects.duePendingOutbox("2026-01-01T00:01:00.000Z")).toMatchObject([
      { attempts: 1, payload: { text: "done" } },
    ]);
    expect(effects.markOutboxAttemptFailed(item.id, backoff, now)).toMatchObject({
      status: "failed",
    });
    expect(effects.markDelivered(item.id)).toBeUndefined();
  });
});
