import * as NodeCrypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as NodeFS from "node:fs";
import type * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";

import type { Bot } from "@beebot/contracts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { callBotTool } from "./botTools.ts";
import { type EventStore, openEventStore } from "./store.ts";
import { createWaitEvaluator, probeUrl, type WaitCondition, type WaitProbes } from "./waits.ts";

vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeHttps>();
  const get = vi.fn(actual.get);
  return { ...actual, default: { ...actual, get }, get };
});

let dataDir: string;
let store: EventStore;

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-waits-"));
  store = openEventStore(dataDir);
});

afterEach(() => {
  store.close();
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const noProbes: WaitProbes = { url: async () => null, file: async () => null };

function query(sql: string) {
  const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

const createBot = (name: string) =>
  store.createBot({ name, personality: "", engineAccountId: "fake" });

// A bot with a queued run, whose DM then has no unanswered input.
function requester(name: string) {
  const bot = createBot(name);
  store.sendMessage({ id: crypto.randomUUID(), roomId: bot.roomId, body: "go", attended: true });
  const wake = store.dueWakes(at(0)).find((w) => w.botId === bot.id);
  if (!wake) {
    throw new Error("no wake");
  }
  store.queueRun(wake);
  const run = store.state().runs.find((r) => r.botId === bot.id);
  if (!run) {
    throw new Error("no run");
  }
  query(`UPDATE scopes SET acked_event_seq = 1000000 WHERE bot_id = '${bot.id}'`);
  return { bot, runId: run.id };
}

function delegate(from: ReturnType<typeof requester>, to: string) {
  const task = store.tasks.createTask(
    {
      kind: "delegate",
      chainId: "chain",
      hop: 1,
      depth: 1,
      parentRunId: from.runId,
      requesterBotId: from.bot.id,
      ownerBotId: to,
      roomId: from.bot.roomId,
      goal: "Goal",
      deliveryKey: crypto.randomUUID(),
      attended: true,
    },
    3,
  );
  if ("refused" in task) {
    throw new Error("refused");
  }
  return task;
}

function wait(bot: Bot, runId: string, condition: WaitCondition, timeoutMinutes = 60) {
  const created = store.waits.createWait(
    {
      botId: bot.id,
      taskId: null,
      condition,
      note: "Carry on",
      timeoutMinutes,
      createdByRunId: runId,
    },
    10,
  );
  if ("refused" in created) {
    throw new Error("refused");
  }
  return created;
}

const notices = (bot: Bot) =>
  store.state().messages.filter((m) => m.roomId === bot.roomId && m.id.startsWith("wait:"));
const wakeSources = (bot: Bot) =>
  query(`SELECT source FROM wakes WHERE bot_id = '${bot.id}' AND status = 'pending'`).map(
    (row) => row.source,
  );

describe("waits", () => {
  it("posts one wait notice with source wait when a task it watches finishes", () => {
    const ada = requester("Ada");
    const ben = createBot("Ben");
    const task = delegate(ada, ben.id);
    const created = wait(ada.bot, ada.runId, { kind: "task_done", task_id: task.id });
    const evaluator = createWaitEvaluator(store, noProbes, () => {});

    evaluator.tick(at(0));
    expect(notices(ada.bot)).toEqual([]);
    store.tasks.finishTask(task.id, "done");
    evaluator.tick(at(0));
    evaluator.tick(at(1000));

    const [notice, ...rest] = notices(ada.bot);
    expect(rest).toEqual([]);
    expect(notice?.id).toBe(`wait:${created.id}`);
    expect(notice?.body).toBe(
      `[Wait met after 0 minutes: task ${task.id} finished (done)]\n\nCarry on`,
    );
    expect(store.dueWakes(at(0)).filter((w) => w.botId === ada.bot.id)).toHaveLength(1);
    expect(wakeSources(ada.bot)).toEqual(["wait"]);
  });

  it("expires at the timeout with the expired notice, and checks a URL at most every 30 seconds", async () => {
    const ada = requester("Ada");
    let calls = 0;
    const probes: WaitProbes = {
      url: async () => {
        calls += 1;
        return { status: 500, sha256: "a" };
      },
      file: async () => null,
    };
    const url = "https://example.com/health";
    wait(ada.bot, ada.runId, { kind: "url_status", url, status: 200 }, 1);
    const evaluator = createWaitEvaluator(store, probes, () => {});

    for (const ms of [1000, 2000, 31_000, 32_000]) {
      evaluator.tick(at(ms));
      await evaluator.idle();
    }
    expect(calls).toBe(2);
    expect(notices(ada.bot)).toEqual([]);

    evaluator.tick(at(61_000));
    await evaluator.idle();
    expect(calls).toBe(2);
    expect(notices(ada.bot).map((m) => m.body)).toEqual([
      `[Wait timed out after 1 minutes: ${url} answered 200 didn't happen]\n\nCarry on`,
    ]);
  });

  it("sets a baseline on the first url_changes probe and is met on a different hash", async () => {
    const ada = requester("Ada");
    const hashes = ["a", "a", "b"];
    const probes: WaitProbes = {
      url: async () => ({ status: 200, sha256: hashes.shift() ?? "" }),
      file: async () => null,
    };
    const url = "https://example.com/page";
    const created = wait(ada.bot, ada.runId, { kind: "url_changes", url });
    let settled = 0;
    const evaluator = createWaitEvaluator(store, probes, () => {
      settled += 1;
    });

    for (const ms of [1000, 32_000]) {
      evaluator.tick(at(ms));
      await evaluator.idle();
    }
    expect(store.waits.dueWaits(at(3_600_000))[0]?.condition).toEqual({
      kind: "url_changes",
      url,
      baseline: "a",
    });
    expect(notices(ada.bot)).toEqual([]);

    evaluator.tick(at(63_000));
    await evaluator.idle();
    expect(settled).toBe(1);
    expect(notices(ada.bot).map((m) => m.id)).toEqual([`wait:${created.id}`]);
    expect(notices(ada.bot)[0]?.body).toMatch(
      /^\[Wait met after 0 minutes: https:\/\/example\.com\/page changed\]/,
    );
  });

  it("stop cancels a bot's waits and nothing wakes it after", () => {
    const ada = requester("Ada");
    const ben = createBot("Ben");
    const cy = createBot("Cy");
    const evaluator = createWaitEvaluator(store, noProbes, () => {});
    wait(ben, ada.runId, { kind: "bot_idle", bot_id: cy.id });
    wait(cy, ada.runId, { kind: "bot_idle", bot_id: ben.id });

    store.stopBot(ben.id);
    store.archiveBot(cy.id);
    evaluator.tick(at(1000));
    expect([...notices(ben), ...notices(cy)]).toEqual([]);
    expect([...wakeSources(ben), ...wakeSources(cy)]).toEqual([]);
    expect(store.waits.dueWaits(at(3_600_000))).toEqual([]);

    store.refuseQueuedRun(ada.runId, "stopped");
    wait(ben, ada.runId, { kind: "bot_idle", bot_id: cy.id });
    expect(store.deleteBot(ada.bot.id)).toBe("deleted");
    expect(query("SELECT id FROM waits")).toHaveLength(0);
    expect(query("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("keeps pending waits across a restart", () => {
    const ada = requester("Ada");
    const ben = createBot("Ben");
    const created = wait(ada.bot, ada.runId, { kind: "bot_idle", bot_id: ben.id });
    store.close();
    store = openEventStore(dataDir);

    expect(store.waits.dueWaits(at(0)).map((w) => w.id)).toEqual([created.id]);
    createWaitEvaluator(store, noProbes, () => {}).tick(at(0));
    expect(notices(ada.bot).map((m) => m.body)).toEqual([
      "[Wait met after 0 minutes: @Ben is idle]\n\nCarry on",
    ]);
  });

  it("refuses an 11th pending wait", () => {
    const ada = requester("Ada");
    const condition = { kind: "bot_idle", bot_id: ada.bot.id } as const;
    const input = {
      botId: ada.bot.id,
      taskId: null,
      condition,
      note: "n",
      timeoutMinutes: 60,
      createdByRunId: ada.runId,
    };
    for (let index = 0; index < 10; index += 1) {
      expect(store.waits.createWait(input, 10)).not.toHaveProperty("refused");
    }
    expect(store.waits.createWait(input, 10)).toEqual({ refused: "too_many_waits" });
  });

  it("merges a notice into a pending wake without releasing its backoff", () => {
    const ada = requester("Ada");
    const ben = createBot("Ben");
    const cy = createBot("Cy");
    store.sendMessage({ id: crypto.randomUUID(), roomId: ben.roomId, body: "hi", attended: false });
    const [pending] = store.dueWakes(at(0)).filter((w) => w.botId === ben.id);
    if (!pending) {
      throw new Error("no wake");
    }
    store.deferWake(pending.id, at(3_600_000));
    wait(ben, ada.runId, { kind: "bot_idle", bot_id: cy.id });

    createWaitEvaluator(store, noProbes, () => {}).tick(at(0));
    expect(notices(ben)).toHaveLength(1);
    expect(wakeSources(ben)).toEqual(["human"]);
    expect(store.dueWakes(at(0)).filter((w) => w.botId === ben.id)).toEqual([]);
  });

  it("doesn't treat a wait notice as the owner's input", () => {
    const ada = requester("Ada");
    const ben = createBot("Ben");
    const cy = createBot("Cy");
    wait(ben, ada.runId, { kind: "bot_idle", bot_id: cy.id });
    createWaitEvaluator(store, noProbes, () => {}).tick(at(0));
    const [wake] = store.dueWakes(at(0)).filter((w) => w.botId === ben.id);
    if (!wake) {
      throw new Error("no wake");
    }

    expect(store.wakeContext(wake, at(0)).source).toBe("wait");
    expect(delegate(ada, ben.id).status).toBe("open");
  });

  it("refuses a URL outside the bot's allowlist or on a private address, and never follows a redirect", async () => {
    const ada = requester("Ada");
    store.claimRun(ada.runId, "boot", at(0));
    query(`UPDATE bots SET egress_any_site = 0 WHERE id = '${ada.bot.id}'`);
    query(
      `INSERT INTO bot_egress_hosts (bot_id, host, created_at)
       VALUES ('${ada.bot.id}', 'docs.example.com', '${at(0)}') RETURNING host`,
    );
    const waitFor = (url: string) =>
      JSON.parse(
        callBotTool(store, { id: ada.runId, botId: ada.bot.id }, "wait_until", {
          condition: { kind: "url_status", url, status: 200 },
          note: "Check it",
          timeout_minutes: 5,
        }),
      ) as Record<string, unknown>;
    for (const url of [
      "https://evil.example/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://localhost/",
      "https://docs.example.com:8443/",
    ]) {
      expect(waitFor(url)).toMatchObject({ status: "refused", reason: "egress_not_allowed" });
    }
    expect(waitFor("http://docs.example.com/")).toMatchObject({ reason: "url_not_https" });
    expect(waitFor("https://docs.example.com/ready")).toMatchObject({ status: "waiting" });
    expect(store.waits.dueWaits(at(0))).toHaveLength(1);

    const get = vi.mocked(NodeHttps.get);
    get.mockClear();
    for (const addresses of [["10.0.0.1"], ["127.0.0.1"], ["93.184.216.34", "169.254.169.254"]]) {
      expect(await probeUrl("https://docs.example.com/", async () => addresses)).toBeNull();
    }
    expect(await probeUrl("http://docs.example.com/", async () => ["93.184.216.34"])).toBeNull();
    expect(get).not.toHaveBeenCalled();

    const moved = ((_options: NodeHttps.RequestOptions, respond: (r: unknown) => void) => {
      respond(
        Object.assign(Readable.from([Buffer.from("moved")]), {
          statusCode: 302,
          headers: { location: "https://elsewhere.example/" },
        }),
      );
      return new EventEmitter() as NodeHttp.ClientRequest;
    }) as unknown as typeof NodeHttps.get;
    get.mockImplementationOnce(moved);
    expect(
      await probeUrl("https://docs.example.com/ready?x=1", async () => ["93.184.216.34"]),
    ).toEqual({
      status: 302,
      sha256: NodeCrypto.createHash("sha256").update("moved").digest("hex"),
    });
    expect(get).toHaveBeenCalledOnce();
    expect(get.mock.calls[0]?.[0]).toMatchObject({
      host: "93.184.216.34",
      servername: "docs.example.com",
      path: "/ready?x=1",
      headers: { host: "docs.example.com" },
      agent: false,
    });
  });
});

describe("timer-held tasks", () => {
  function runOn(bot: Bot) {
    const wake = store.dueWakes(at(0)).find((w) => w.botId === bot.id);
    if (!wake) {
      throw new Error("no wake");
    }
    store.queueRun(wake);
    const run = store.state().runs.find((r) => r.botId === bot.id && r.status === "Queued");
    if (!run) {
      throw new Error("no run");
    }
    store.claimRun(run.id, "boot", at(0));
    return run.id;
  }
  const finish = (runId: string) =>
    store.finishRun(runId, "boot", { status: "Completed", reason: null, reply: "done" });
  const runTask = (runId: string) => store.state().runs.find((r) => r.id === runId)?.taskId;
  const pendingKeys = (bot: Bot) =>
    query(
      `SELECT idempotency_key AS key FROM wakes WHERE bot_id = '${bot.id}' AND status = 'pending'`,
    ).map((row) => row.key);

  // Ada asks Ben for a task, and Ben's run on it is live.
  function benOnTask() {
    const ada = requester("Ada");
    const ben = createBot("Ben");
    const task = delegate(ada, ben.id);
    return { ada, ben, task, runId: runOn(ben) };
  }

  function heldByWait() {
    const held = benOnTask();
    const idle = createBot("Cy");
    store.waits.createWait(
      {
        botId: held.ben.id,
        taskId: held.task.id,
        condition: { kind: "bot_idle", bot_id: idle.id },
        note: "Carry on",
        timeoutMinutes: 60,
        createdByRunId: held.runId,
      },
      10,
    );
    finish(held.runId);
    return held;
  }

  function heldByWakeup(fireAt = at(60_000)) {
    const held = benOnTask();
    const routine = store.scheduleWakeup(
      { botId: held.ben.id, name: "Wakeup", prompt: "Check", fireAt, createdByRunId: held.runId },
      10,
    );
    if ("refused" in routine) {
      throw new Error("refused");
    }
    finish(held.runId);
    return { ...held, routine, fireAt };
  }

  it("keeps a waiting task's bot busy until the wait fires, then resumes that task", () => {
    const { ada, ben, task } = heldByWait();
    expect(store.tasks.getTask(task.id)?.status).toBe("waiting");
    const queued = delegate(ada, ben.id);
    expect(queued.status).toBe("queued");

    createWaitEvaluator(store, noProbes, () => {}).tick(at(0));
    expect(store.tasks.getTask(task.id)?.status).toBe("open");
    expect(store.tasks.getTask(queued.id)?.status).toBe("queued");
    expect(notices(ben)).toHaveLength(1);
    expect(runTask(runOn(ben))).toBe(task.id);
  });

  it("resumes a timer-held task only after the bot's current run ends", () => {
    const { ben, task } = heldByWait();
    store.sendMessage({ id: crypto.randomUUID(), roomId: ben.roomId, body: "hey", attended: true });
    const evaluator = createWaitEvaluator(store, noProbes, () => {});

    evaluator.tick(at(0));
    expect(store.tasks.getTask(task.id)?.status).toBe("queued");
    const ownerRun = runOn(ben);
    expect(notices(ben)).toEqual([]);
    expect(runTask(ownerRun)).toBeNull();

    finish(ownerRun);
    expect(store.tasks.getTask(task.id)?.status).toBe("open");
    expect(notices(ben)).toHaveLength(1);
    expect(runTask(runOn(ben))).toBe(task.id);
  });

  it("releases a held task when its timer goes away", () => {
    const first = heldByWakeup();
    expect(store.tasks.getTask(first.task.id)?.status).toBe("waiting");
    store.deleteRoutine(first.routine.id);
    expect(store.tasks.getTask(first.task.id)?.status).toBe("cancelled");
    expect(pendingKeys(first.ada.bot)).toContain(`result:${first.task.id}`);

    const second = heldByWait();
    store.stopBot(second.ben.id);
    expect(store.tasks.getTask(second.task.id)?.status).toBe("cancelled");
    expect(pendingKeys(second.ada.bot)).toContain(`result:${second.task.id}`);
  });

  it("resumes a wakeup-held task when the wakeup starts on its own", () => {
    const { ben, task, fireAt } = heldByWakeup();
    store.fireDueRoutines(new Date(Date.parse(fireAt) + 1000).toISOString(), () => true);
    expect(store.tasks.getTask(task.id)?.status).toBe("open");
    expect(store.state().firings.at(-1)?.status).toBe("ran");
    expect(runTask(runOn(ben))).toBe(task.id);
  });

  it.each([
    ["ends as a card", 1000, () => {}, false],
    ["is missed", 2 * 24 * 3_600_000, () => {}, true],
    ["is skipped", 1000, (bot: Bot) => store.setBotPause(bot.id, "owner"), true],
  ] as const)(
    "releases a wakeup-held task whose firing %s",
    (_outcome, lateMs, before, runsItself) => {
      const { ada, ben, task, fireAt } = heldByWakeup();
      before(ben);
      store.fireDueRoutines(new Date(Date.parse(fireAt) + lateMs).toISOString(), () => runsItself);
      expect(store.tasks.getTask(task.id)?.status).toBe("cancelled");
      expect(pendingKeys(ada.bot)).toContain(`result:${task.id}`);
    },
  );
});
