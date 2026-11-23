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

const open = () => {
  if (!store) {
    throw new Error("no store");
  }
  return store;
};

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

const owner = (open: EventStore, name: string) =>
  open.createBot({ name, personality: "", engineAccountId: "fake" }).id;

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
    attended: true,
  };
}

describe("tasks", () => {
  it("refuses a run's 4th task, and a repeated key spends nothing", () => {
    store = openEventStore(dataDir);
    const input = { ...taskInput(store, "k0"), ownerBotId: owner(store, "Ben") };
    const first = store.tasks.createTask(input, 3);
    expect(store.tasks.createTask(input, 3)).toEqual(first);
    expect(store.tasks.createTask({ ...input, deliveryKey: "k1" }, 3)).toMatchObject({
      status: "queued",
    });
    const next = (key: string, name: string) =>
      open().tasks.createTask({ ...input, deliveryKey: key, ownerBotId: owner(open(), name) }, 3);
    next("k1", "Cy");
    next("k2", "Di");
    expect(next("k3", "Ed")).toEqual({ refused: "fan_out" });
    expect(store.state().tasks).toHaveLength(3);
  });

  it("lets only 3 of 8 concurrent writers through", async () => {
    store = openEventStore(dataDir);
    const input = taskInput(store, "unused");
    const owners = ["B", "C", "D", "E", "F", "G", "H", "I"].map((name) => owner(open(), name));
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
        workerData: {
          storeUrl,
          dataDir,
          gate,
          input: { ...input, deliveryKey: `k${index}`, ownerBotId: owners[index] },
        },
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

  it("hands an open task on only from its owner", () => {
    store = openEventStore(dataDir);
    const input = taskInput(store, "k");
    const ben = owner(store, "Ben");
    const cy = owner(store, "Cy");
    const task = store.tasks.createTask(input, 3);
    if ("refused" in task) {
      throw new Error("refused");
    }
    const move = (fromBotId: string, toBotId: string) =>
      open().tasks.handoff(task.id, {
        fromBotId,
        toBotId,
        hop: 2,
        note: "Over to you",
      });
    expect(move(input.ownerBotId, ben)).toMatchObject({ ownerBotId: ben });
    expect(move(input.ownerBotId, cy)).toBeUndefined();
    expect(move(ben, ben)).toBeUndefined();
    expect(store.tasks.finishTask(task.id, "done")).toMatchObject({ status: "done" });
    expect(move(ben, cy)).toBeUndefined();
    expect(store.state().tasks).toEqual([]);
  });
});

describe("the tasks_v2 migration", () => {
  it("keeps tasks and the runs that point at them", () => {
    const db = new DatabaseSync(dbPath());
    migrate(
      db,
      migrations.findIndex(({ name }) => name === "tasks_v2"),
    );
    db.exec(`INSERT INTO bots (id, name, personality, status, created_at)
        VALUES ('ada', 'Ada', '', 'ready', 'then'), ('ben', 'Ben', '', 'ready', 'then');
      INSERT INTO rooms (id, default_bot_id, created_at) VALUES ('room', 'ada', 'then');
      INSERT INTO scopes (id, room_id, bot_id) VALUES ('scope', 'room', 'ada');
      INSERT INTO wakes (id, bot_id, scope_id, idempotency_key, attended, status, created_at)
        VALUES ('w1', 'ada', 'scope', 'message:m1', 1, 'done', 'then');
      INSERT INTO runs (id, bot_id, scope_id, wake_id, engine_account_id, status, created_at)
        VALUES ('r1', 'ada', 'scope', 'w1', 'fake', 'Completed', 'then');
      INSERT INTO tasks (id, kind, chain_id, hop, depth, parent_run_id, requester_bot_id,
          owner_bot_id, room_id, goal, status, delivery_key, created_at, updated_at)
        VALUES ('t1', 'delegate', 'chain', 1, 1, 'r1', 'ada', 'ben', 'room', 'Look', 'open', 'k1',
          'then', 'then');
      UPDATE runs SET task_id = 't1' WHERE id = 'r1';`);
    db.close();

    store = openEventStore(dataDir);
    expect(store.state().tasks).toMatchObject([{ id: "t1", status: "open" }]);
    const check = new DatabaseSync(dbPath());
    expect(rows(check, "PRAGMA foreign_key_list(runs)")).toContainEqual(
      expect.objectContaining({ table: "tasks", from: "task_id" }),
    );
    expect(rows(check, "PRAGMA foreign_key_check")).toEqual([]);
    const insert = (id: string, status: string) =>
      check.exec(`INSERT INTO tasks (id, kind, chain_id, hop, depth, parent_run_id,
          requester_bot_id, owner_bot_id, room_id, goal, status, delivery_key, created_at,
          updated_at)
        VALUES ('${id}', 'delegate', 'chain', 1, 1, 'r1', 'ada', 'ben', 'room', 'Look',
          '${status}', '${id}', 'then', 'then')`);
    insert("t2", "queued");
    expect(() => insert("t3", "bogus")).toThrow(/CHECK/);
    check.close();
  });
});

describe("task queue", () => {
  const dueWake = (botId: string) => {
    const wake = open()
      .dueWakes(new Date().toISOString())
      .find((w) => w.botId === botId);
    if (!wake) {
      throw new Error("no wake");
    }
    return wake;
  };
  const maybeRun = (botId: string) =>
    open()
      .state()
      .runs.find((r) => r.botId === botId);
  const latestRun = (botId: string) => {
    const run = maybeRun(botId);
    if (!run) {
      throw new Error("no run");
    }
    return run;
  };
  const requester = (name: string) => {
    const bot = open().createBot({ name, personality: "", engineAccountId: "fake" });
    open().sendMessage({ id: crypto.randomUUID(), roomId: bot.roomId, body: "go", attended: true });
    const wake = dueWake(bot.id);
    open().queueRun(wake);
    const check = new DatabaseSync(dbPath());
    const [chain] = rows(check, `SELECT chain_id AS chainId FROM wakes WHERE id = '${wake.id}'`);
    check.close();
    return { bot, run: latestRun(bot.id), chainId: String(chain?.chainId) };
  };
  const delegate = (from: ReturnType<typeof requester>, to: string, chainId = "chain") => {
    const task = open().tasks.createTask(
      {
        kind: "delegate",
        chainId,
        hop: 1,
        depth: 1,
        parentRunId: from.run.id,
        requesterBotId: from.bot.id,
        ownerBotId: to,
        roomId: from.bot.roomId,
        goal: `Goal from ${from.bot.name}`,
        deliveryKey: crypto.randomUUID(),
        attended: true,
      },
      3,
    );
    if ("refused" in task) {
      throw new Error("refused");
    }
    return task;
  };
  const queueOwnerRun = (bot: { id: string; roomId: string }) => {
    open().sendMessage({ id: crypto.randomUUID(), roomId: bot.roomId, body: "hi", attended: true });
    open().queueRun(dueWake(bot.id));
  };
  const startRun = (botId: string) => {
    if (maybeRun(botId)?.status !== "Queued") {
      open().queueRun(dueWake(botId));
    }
    const id = latestRun(botId).id;
    open().claimRun(id, "boot", new Date().toISOString());
    return id;
  };
  const finish = (botId: string, status: "Completed" | "WaitingUser" = "Completed") => {
    const running = maybeRun(botId);
    const id = running?.status === "Running" ? running.id : startRun(botId);
    open().finishRun(id, "boot", { status, reason: null, reply: "done" });
  };
  const statuses = () =>
    open()
      .state()
      .tasks.map(({ id, status }) => ({ id, status }));
  const dmBodies = (roomId: string) =>
    open()
      .state()
      .messages.filter((m) => m.roomId === roomId && m.body.startsWith("Goal"))
      .map(({ body }) => body);

  it("queues a task for a busy bot and opens it when the bot's run ends", () => {
    store = openEventStore(dataDir);
    const ada = requester("Ada");
    const cy = requester("Cy");
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    const first = delegate(ada, ben.id);
    const second = delegate(cy, ben.id);
    expect([first.status, second.status]).toEqual(["open", "queued"]);
    expect(dmBodies(ben.roomId)).toEqual(["Goal from Ada"]);

    startRun(ben.id);
    finish(ben.id);
    expect(store.tasks.getTask(first.id)?.status).toBe("done");
    expect(store.tasks.getTask(second.id)?.status).toBe("open");
    expect(dmBodies(ben.roomId)).toEqual(["Goal from Ada", "Goal from Cy"]);
    expect(store.dueWakes(new Date().toISOString()).map((w) => w.botId)).toContain(ben.id);
  });

  it("opens human-origin chains first, then oldest first", () => {
    store = openEventStore(dataDir);
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    queueOwnerRun(ben);
    const ada = requester("Ada");
    const cy = requester("Cy");
    const di = requester("Di");
    const t1 = delegate(ada, ben.id, "no-human");
    const t2 = delegate(cy, ben.id, cy.chainId);
    const t3 = delegate(di, ben.id, di.chainId);
    const opened: string[] = [];
    for (let turn = 0; turn < 3; turn++) {
      finish(ben.id);
      const open = statuses().find(({ status }) => status === "open");
      opened.push(open?.id ?? "none");
    }
    expect(opened).toEqual([t2.id, t3.id, t1.id]);
  });

  it("never opens a task on a bot with a Queued or Running run", () => {
    store = openEventStore(dataDir);
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    queueOwnerRun(ben);
    const task = delegate(requester("Ada"), ben.id);
    expect(task.status).toBe("queued");
    startRun(ben.id);
    expect(store.tasks.getTask(task.id)?.status).toBe("queued");
    finish(ben.id);
    expect(store.tasks.getTask(task.id)?.status).toBe("open");
  });

  it("opens a queued task when the bot's run parks, if the bot owns no open task", () => {
    store = openEventStore(dataDir);
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    queueOwnerRun(ben);
    startRun(ben.id);
    const task = delegate(requester("Ada"), ben.id);
    expect(task.status).toBe("queued");
    finish(ben.id, "WaitingUser");
    expect(store.tasks.getTask(task.id)?.status).toBe("open");
  });

  it("a refused run ends its task and opens the next", () => {
    store = openEventStore(dataDir);
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    const ada = requester("Ada");
    const t1 = delegate(ada, ben.id);
    const t2 = delegate(requester("Cy"), ben.id);
    store.refuseWake(dueWake(ben.id), "bot_paused");
    expect(store.tasks.getTask(t1.id)?.status).toBe("refused");
    expect(store.tasks.getTask(t2.id)?.status).toBe("open");
    const check = new DatabaseSync(dbPath());
    expect(
      rows(
        check,
        `SELECT idempotency_key AS key FROM wakes WHERE bot_id = '${ada.bot.id}' AND status = 'pending'`,
      ),
    ).toContainEqual({ key: `result:${t1.id}` });
    check.close();
  });

  const pendingKeys = (botId: string) => {
    const check = new DatabaseSync(dbPath());
    const keys = rows(
      check,
      `SELECT idempotency_key AS key FROM wakes WHERE bot_id = '${botId}' AND status = 'pending'`,
    ).map(({ key }) => key);
    check.close();
    return keys;
  };

  it("fails a queued handoff whose owner left the room, and still ends the owner's run", () => {
    store = openEventStore(dataDir);
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    queueOwnerRun(ben);
    const ada = requester("Ada");
    const roomId =
      store.rooms.createGroupRoom({ name: "Team", memberIds: [ada.bot.id, ben.id] })?.id ?? "";
    const task = store.tasks.createTask(
      {
        kind: "handoff",
        chainId: "chain",
        hop: 1,
        depth: 0,
        parentRunId: ada.run.id,
        requesterBotId: ada.bot.id,
        ownerBotId: ben.id,
        roomId,
        goal: "Take it",
        deliveryKey: "handoff",
        attended: true,
      },
      3,
    );
    expect(task).toMatchObject({ status: "queued" });
    store.rooms.removeMember(roomId, ben.id);
    const id = "id" in task ? task.id : "";
    finish(ben.id);
    expect(latestRun(ben.id).status).toBe("Completed");
    expect(store.tasks.getTask(id)?.status).toBe("failed");
    expect(pendingKeys(ada.bot.id)).toContain(`result:${id}`);
  });

  it("stopping a bot refuses its queued tasks instead of starting the next", () => {
    store = openEventStore(dataDir);
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    const ada = requester("Ada");
    const cy = requester("Cy");
    const t1 = delegate(ada, ben.id);
    const t2 = delegate(cy, ben.id);
    open().queueRun(dueWake(ben.id));
    store.stopBot(ben.id);
    expect(statuses().filter(({ id }) => id === t1.id || id === t2.id)).toEqual([]);
    expect(store.tasks.getTask(t2.id)?.status).toBe("refused");
    expect(pendingKeys(ben.id)).toEqual([]);
    expect(pendingKeys(ada.bot.id)).toContain(`result:${t1.id}`);
    expect(pendingKeys(cy.bot.id)).toContain(`result:${t2.id}`);
  });

  it("stopping a bot ends the task of its parked run, so its queue moves", () => {
    store = openEventStore(dataDir);
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    const ada = requester("Ada");
    const t1 = delegate(ada, ben.id);
    startRun(ben.id);
    finish(ben.id, "WaitingUser");
    store.stopBot(ben.id);
    expect(store.tasks.getTask(t1.id)?.status).toBe("cancelled");
    expect(pendingKeys(ada.bot.id)).toContain(`result:${t1.id}`);
    expect(delegate(requester("Cy"), ben.id).status).toBe("open");
  });

  it("opens a queued task when a run interrupted at boot is held", () => {
    store = openEventStore(dataDir);
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    queueOwnerRun(ben);
    startRun(ben.id);
    const task = delegate(requester("Ada"), ben.id);
    expect(task.status).toBe("queued");
    store.recover("next-boot", () => "hold");
    expect(store.tasks.getTask(task.id)?.status).toBe("open");
  });

  it("keeps queued tasks across a restart", () => {
    store = openEventStore(dataDir);
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    delegate(requester("Ada"), ben.id);
    delegate(requester("Cy"), ben.id);
    store.close();
    store = openEventStore(dataDir);
    expect(store.state().tasks.map((t) => t.status)).toEqual(["open", "queued"]);
  });
});

describe("account concurrency", () => {
  it("claims up to the account's cap, and no more", () => {
    store = openEventStore(dataDir);
    const queued = (name: string) => {
      const bot = open().createBot({ name, personality: "", engineAccountId: "fake" });
      open().sendMessage({
        id: crypto.randomUUID(),
        roomId: bot.roomId,
        body: "go",
        attended: true,
      });
      const wake = open()
        .dueWakes(new Date().toISOString())
        .find(({ botId }) => botId === bot.id);
      if (!wake) {
        throw new Error("no wake");
      }
      open().queueRun(wake);
      return open()
        .state()
        .runs.find(({ botId }) => botId === bot.id);
    };
    const claim = (run: ReturnType<typeof queued>) =>
      open().claimRun(run?.id ?? "", "boot", new Date().toISOString());
    const ada = queued("Ada");
    const ben = queued("Ben");
    const cy = queued("Cy");
    expect(claim(ada)).toBeDefined();
    expect(claim(ben)).toBeUndefined();
    store.setAccountConcurrency("fake", 2);
    expect(claim(ben)).toBeDefined();
    expect(claim(cy)).toBeUndefined();
    expect(store.state().accounts.find((a) => a.id === "fake")?.maxConcurrentRuns).toBe(2);
  });

  it("keeps account events from before the migration readable", () => {
    const db = new DatabaseSync(dbPath());
    migrate(
      db,
      migrations.findIndex(({ name }) => name === "account_concurrency"),
    );
    const account = { id: "fake", label: "Fake", lane: "subscription", blockedUntil: null };
    db.prepare("INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)").run(
      "account.changed",
      JSON.stringify({ type: "account.changed", account }),
      "then",
    );
    db.close();

    store = openEventStore(dataDir);
    expect(store.eventsAfter(0)).toMatchObject([
      { type: "account.changed", account: { ...account, maxConcurrentRuns: 1 } },
    ]);
    const check = new DatabaseSync(dbPath());
    expect(rows(check, "PRAGMA index_list(runs)").map(({ name }) => name)).not.toContain(
      "runs_one_running_per_account",
    );
    check.close();
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
