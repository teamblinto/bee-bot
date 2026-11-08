import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Bot, RunStatus } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createApprovals } from "./approvals.ts";
import { callBotTool } from "./botTools.ts";
import type { RunTurn, TurnOutcome } from "./engine.ts";
import { createOutboxWorker, type Deliver } from "./outbox.ts";
import { continueWindowMs, recoveryVerdict } from "./recovery.ts";
import { type EventStore, openEventStore } from "./store.ts";
import { createSupervisor } from "./supervisor.ts";
import { type AwakeClock, createAwakeClock, createWatchdog } from "./watchdog.ts";

let dataDir: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-recovery-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

const reply: TurnOutcome = { kind: "completed", text: "done" };

function scriptedEngine() {
  const turns: Array<{
    prompt: string;
    resume: boolean;
    deliver: () => void;
    tool: (id: string) => void;
    toolEnd: (id: string) => void;
    finish: (outcome: TurnOutcome) => void;
  }> = [];
  const runTurn: RunTurn = ({ prompt, resume, signal, onDelivered, onToolStart, onToolEnd }) =>
    new Promise((resolve) => {
      turns.push({
        prompt,
        resume,
        deliver: onDelivered,
        tool: (id) => onToolStart({ id, name: "Bash", detail: null }),
        toolEnd: (id) => onToolEnd(id, false),
        finish: resolve,
      });
      signal.addEventListener("abort", () => resolve({ kind: "failed" }));
    });
  return { turns, runTurn };
}

// One "process": a store and the supervisor over it. `kill` leaves Running runs as a crash would.
function boot(
  runTurn: RunTurn,
  options: { turnTimeoutMs?: number; silenceMs?: number; clock?: AwakeClock } = {},
) {
  const store = openEventStore(dataDir);
  const approvals = createApprovals({ store, dataDir, onChange: () => {} });
  const supervisor = createSupervisor({
    store,
    runTurn,
    approvals,
    permissionsUrl: () => "http://127.0.0.1:9/mcp",
    onDelta: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onThinking: () => {},
    ...options,
  });
  let open = true;
  const kill = async () => {
    if (open) {
      open = false;
      approvals.close();
      await supervisor.close();
      store.close();
    }
  };
  cleanups.push(kill);
  const send = (bot: Bot, body: string) => {
    store.sendMessage({ id: NodeCrypto.randomUUID(), roomId: bot.roomId, body, attended: true });
    supervisor.pump();
  };
  return { store, supervisor, kill, send };
}

const createBot = (store: EventStore, name = "Ada", engineAccountId = "claude") =>
  store.createBot({ name, personality: "", engineAccountId });
const latestRun = (store: EventStore, bot: Bot) =>
  store.state().runs.find((run) => run.botId === bot.id);

async function expectStatus(store: EventStore, bot: Bot, status: RunStatus) {
  await vi.waitFor(() => expect(latestRun(store, bot)?.status).toBe(status), { timeout: 3000 });
}

async function expectTurns(engine: ReturnType<typeof scriptedEngine>, count: number) {
  await vi.waitFor(() => expect(engine.turns).toHaveLength(count), { timeout: 3000 });
}

const ticks = (count: number) => new Promise((resolve) => setTimeout(resolve, count * 1000 + 100));

describe("recovery policy", () => {
  const now = "2026-11-08T12:00:00.000Z";
  const ago = (ms: number) => new Date(Date.parse(now) - ms).toISOString();

  it("holds a run with an effect that may or may not have happened", () => {
    expect(recoveryVerdict({ unsettledEffects: 1, continuedAt: [], now })).toBe("hold");
  });

  it("continues at most 3 times in 5 minutes", () => {
    const two = [ago(1000), ago(2000)];
    expect(recoveryVerdict({ unsettledEffects: 0, continuedAt: two, now })).toBe("continue");
    const three = [...two, ago(3000)];
    expect(recoveryVerdict({ unsettledEffects: 0, continuedAt: three, now })).toBe("hold");
    const stale = [...two, ago(continueWindowMs + 1)];
    expect(recoveryVerdict({ unsettledEffects: 0, continuedAt: stale, now })).toBe("continue");
  });
});

describe("awake time", () => {
  it("leaves out a signalled sleep once, even when the gap check sees it too", () => {
    let wall = 0;
    const clock = createAwakeClock(() => wall);
    wall = 1000;
    clock.suspend();
    wall += 3_600_000;
    clock.observe();
    clock.resume();
    wall += 500;
    expect(clock.awakeNow()).toBe(1500);
  });

  it("leaves out a sleep nobody signalled, by the gap between observations", () => {
    let wall = 0;
    const clock = createAwakeClock(() => wall);
    wall = 1000;
    clock.observe();
    wall += 3_600_000;
    expect(clock.awakeNow()).toBe(1000);
  });

  it("never calls a tool in flight stalled, only silence", () => {
    let wall = 0;
    const clock = createAwakeClock(() => wall);
    const watchdog = createWatchdog(clock, 10_000);
    watchdog.toolStart("t1");
    for (let at = 1000; at <= 60_000; at += 1000) {
      wall = at;
      expect(watchdog.stalled()).toBe(false);
    }
    watchdog.toolEnd("t1");
    wall += 9000;
    expect(watchdog.stalled()).toBe(false);
    wall += 1000;
    expect(watchdog.stalled()).toBe(true);
  });
});

describe("outbox", () => {
  it("delivers a row once, and retries a failure with backoff until it gives up", async () => {
    const store = openEventStore(dataDir);
    cleanups.push(() => store.close());
    const bot = createBot(store);
    store.sendMessage({ id: "m", roomId: bot.roomId, body: "x", attended: true });
    const [wake] = store.dueWakes(new Date().toISOString());
    store.queueRun(wake!);
    const runId = latestRun(store, bot)?.id ?? "";
    store.effects.enqueueOutbox({ runId, kind: "ok", payload: {}, idempotencyKey: "a" });
    store.effects.enqueueOutbox({ runId, kind: "ok", payload: {}, idempotencyKey: "a" });
    store.effects.enqueueOutbox({ runId, kind: "bad", payload: {}, idempotencyKey: "b" });
    store.effects.enqueueOutbox({ runId, kind: "unknown", payload: {}, idempotencyKey: "c" });
    const delivered: string[] = [];
    const worker = createOutboxWorker(
      store.effects,
      new Map<string, Deliver>([
        ["ok", async ({ idempotencyKey }) => void delivered.push(idempotencyKey)],
        ["bad", () => Promise.reject(new Error("down"))],
      ]),
      (attempts) => (attempts < 2 ? 0 : null),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    worker.drain();
    worker.drain();
    await worker.idle();
    worker.drain();
    await worker.idle();
    worker.drain();
    await worker.idle();
    expect(delivered).toEqual(["a"]);
    const due = store.effects.duePendingOutbox(new Date(Date.now() + 60_000).toISOString());
    expect(due.map(({ idempotencyKey, attempts }) => ({ idempotencyKey, attempts }))).toEqual([
      { idempotencyKey: "c", attempts: 0 },
    ]);
  });
});

describe("a crash", () => {
  it("leaves a run killed mid-tool Interrupted, and the effect is never repeated", async () => {
    const before = scriptedEngine();
    const first = boot(before.runTurn);
    const bot = createBot(first.store);
    first.send(bot, "deploy");
    await expectTurns(before, 1);
    before.turns[0]?.deliver();
    before.turns[0]?.tool("t1");
    await first.kill();

    const after = scriptedEngine();
    const { store } = boot(after.runTurn);
    expect(latestRun(store, bot)).toMatchObject({
      status: "Interrupted",
      reason: "server_restarted",
    });
    const id = latestRun(store, bot)?.id ?? "";
    expect(store.effects.unsettledEffects(id)).toEqual([]);
    await ticks(1);
    expect(after.turns).toEqual([]);
  });

  it("records each tool as intended when it starts and settles it when it ends", async () => {
    const engine = scriptedEngine();
    const { store, send } = boot(engine.runTurn);
    const bot = createBot(store);
    send(bot, "hi");
    await expectTurns(engine, 1);
    const id = latestRun(store, bot)?.id ?? "";
    engine.turns[0]?.tool("t1");
    expect(store.effects.unsettledEffects(id)).toHaveLength(1);
    engine.turns[0]?.toolEnd("t1");
    expect(store.effects.unsettledEffects(id)).toEqual([]);
  });

  it("continues a turn cut off with no tool in flight, but only 3 times in 5 minutes", async () => {
    let engine = scriptedEngine();
    let process = boot(engine.runTurn);
    const bot = createBot(process.store);
    process.send(bot, "hello");
    for (let restart = 0; restart < 3; restart += 1) {
      await expectTurns(engine, 1);
      await process.kill();
      engine = scriptedEngine();
      process = boot(engine.runTurn);
      process.supervisor.pump();
    }
    await expectTurns(engine, 1);
    expect(engine.turns[0]?.prompt).toBe("hello");
    await process.kill();

    engine = scriptedEngine();
    const { store } = boot(engine.runTurn);
    await ticks(1);
    expect(engine.turns).toEqual([]);
    expect(latestRun(store, bot)?.status).toBe("Interrupted");
  });
});

describe("sleep and wake", () => {
  it("runs the turn once and spends none of its deadline asleep", async () => {
    let offset = 0;
    const engine = scriptedEngine();
    const { store, supervisor, send } = boot(engine.runTurn, {
      turnTimeoutMs: 2000,
      clock: createAwakeClock(() => Date.now() + offset),
    });
    const bot = createBot(store);
    send(bot, "hello");
    await expectTurns(engine, 1);

    supervisor.suspend();
    offset += 10 * 60_000;
    await ticks(2);
    supervisor.resume();
    expect(latestRun(store, bot)?.status).toBe("Running");

    offset += 60 * 60_000;
    await ticks(1);
    expect(latestRun(store, bot)?.status).toBe("Running");
    expect(engine.turns).toHaveLength(1);

    engine.turns[0]?.finish(reply);
    await expectStatus(store, bot, "Completed");
    supervisor.pump();
    expect(engine.turns).toHaveLength(1);
    expect(store.state().runs).toHaveLength(1);
  });

  it("spends none of a turn's deadline in a sleep nobody signalled", async () => {
    let offset = 0;
    const engine = scriptedEngine();
    const { store, send } = boot(engine.runTurn, {
      turnTimeoutMs: 2000,
      clock: createAwakeClock(() => Date.now() + offset),
    });
    const bot = createBot(store);
    send(bot, "hello");
    await expectTurns(engine, 1);

    offset += 60 * 60_000;
    await ticks(1);
    expect(latestRun(store, bot)?.status).toBe("Running");
    await expectStatus(store, bot, "Failed");
    expect(latestRun(store, bot)?.reason).toBe("timeout");
  });

  it("stops a silent turn with no tool in flight", async () => {
    const engine = scriptedEngine();
    const { store, send } = boot(engine.runTurn, { silenceMs: 500 });
    const bot = createBot(store);
    send(bot, "hello");
    await expectTurns(engine, 1);
    await expectStatus(store, bot, "Failed");
    expect(latestRun(store, bot)?.reason).toBe("timeout");
  });
});

describe("waiting states", () => {
  it("parks on a usage limit, frees the bot, and resumes the same run after the reset", async () => {
    const engine = scriptedEngine();
    const { store, send } = boot(engine.runTurn);
    const bot = createBot(store);
    send(bot, "hello");
    await expectTurns(engine, 1);
    const id = latestRun(store, bot)?.id;
    engine.turns[0]?.finish({ kind: "limited", retryAfterMs: 1000 });
    await expectStatus(store, bot, "WaitingQuota");
    expect(store.state().accounts.find((a) => a.id === "claude")?.blockedUntil).not.toBeNull();

    await expectTurns(engine, 2);
    expect(latestRun(store, bot)).toMatchObject({ id, status: "Running" });
    expect(engine.turns[1]?.prompt).toBe("hello");
    engine.turns[1]?.finish(reply);
    await expectStatus(store, bot, "Completed");
    expect(store.state().runs).toHaveLength(1);
  });

  it("parks for the owner's answer, releases the gate, and continues the same run", async () => {
    const engine = scriptedEngine();
    const { store, supervisor, send } = boot(engine.runTurn);
    const [ada, ben] = [createBot(store, "Ada"), createBot(store, "Ben")];
    send(ada, "ship it");
    await expectTurns(engine, 1);
    const id = latestRun(store, ada)?.id ?? "";
    engine.turns[0]?.deliver();
    expect(supervisor.parkWaitingUser(id)).toBe(true);
    engine.turns[0]?.finish(reply);
    await expectStatus(store, ada, "WaitingUser");
    expect(store.state().messages.at(-1)).toMatchObject({ author: "bot", body: "done" });

    send(ben, "same account");
    await expectTurns(engine, 2);
    engine.turns[1]?.finish(reply);
    await expectStatus(store, ben, "Completed");

    expect(supervisor.resumeFromUser(id, "main")).toBe("resumed");
    expect(supervisor.resumeFromUser(id, "main")).toBe("not_waiting");
    await expectTurns(engine, 3);
    expect(engine.turns[2]).toMatchObject({ prompt: "main", resume: true });
    expect(latestRun(store, ada)).toMatchObject({ id, status: "Running" });
    engine.turns[2]?.finish(reply);
    await expectStatus(store, ada, "Completed");
  });
  it("routes the owner's answer in a group room back to the bot that asked", async () => {
    const engine = scriptedEngine();
    const { store, supervisor } = boot(engine.runTurn);
    const [ada, ben] = [createBot(store, "Ada"), createBot(store, "Ben")];
    const room = store.rooms.createGroupRoom({ name: "Team", memberIds: [ada.id, ben.id] });
    if (!room) {
      throw new Error("no room");
    }
    const asked = { id: NodeCrypto.randomUUID(), roomId: room.id, attended: true };
    expect(store.sendMessage({ ...asked, body: "@ada ship it" })).toBe("sent");
    supervisor.pump();
    await expectTurns(engine, 1);
    const id = latestRun(store, ada)?.id ?? "";
    engine.turns[0]?.deliver();
    expect(supervisor.parkWaitingUser(id)).toBe(true);
    engine.turns[0]?.finish({ kind: "completed", text: "Which branch?" });
    await expectStatus(store, ada, "WaitingUser");

    expect(supervisor.resumeFromUser(id, "main")).toBe("resumed");
    await expectTurns(engine, 2);
    expect(engine.turns[1]).toMatchObject({ resume: true });
    expect(engine.turns[1]?.prompt).toContain("Owner: main");
    expect(latestRun(store, ada)).toMatchObject({ id, status: "Running" });
    expect(store.state().runs.filter(({ botId }) => botId === ben.id)).toEqual([]);
  });

  it("parks a run that calls ask_user until the owner replies, then continues it once", async () => {
    const engine = scriptedEngine();
    const { store, supervisor, send } = boot(engine.runTurn);
    const ada = createBot(store);
    send(ada, "ship it");
    await expectTurns(engine, 1);
    const run = { id: latestRun(store, ada)?.id ?? "", botId: ada.id };
    engine.turns[0]?.deliver();
    const asked = callBotTool(store, run, "ask_user", { question: "Which branch?" }, ({ runId }) =>
      supervisor.parkWaitingUser(runId),
    );
    expect(JSON.parse(asked)).toMatchObject({ status: "waiting" });
    engine.turns[0]?.finish(reply);
    await expectStatus(store, ada, "WaitingUser");
    expect(store.state().messages.filter((m) => m.body === "Which branch?")).toHaveLength(1);

    send(ada, "main");
    await expectTurns(engine, 2);
    expect(engine.turns[1]).toMatchObject({ prompt: "main", resume: true });
    engine.turns[1]?.finish(reply);
    await expectStatus(store, ada, "Completed");
    await ticks(1);
    expect(engine.turns).toHaveLength(2);
    expect(store.state().runs).toHaveLength(1);
  });
});

describe("stop-all", () => {
  it("cancels running, waiting and queued runs, pending wakes and open tasks", async () => {
    const engine = scriptedEngine();
    const { store, supervisor, send } = boot(engine.runTurn);
    const asker = createBot(store, "Asker");
    const limited = createBot(store, "Limited");
    const waiting = createBot(store, "Waiting");
    const running = createBot(store, "Running", "codex");

    send(asker, "question");
    await expectTurns(engine, 1);
    const askerRun = latestRun(store, asker)?.id ?? "";
    supervisor.parkWaitingUser(askerRun);
    engine.turns[0]?.finish(reply);
    await expectStatus(store, asker, "WaitingUser");

    send(limited, "limit me");
    await expectTurns(engine, 2);
    engine.turns[1]?.finish({ kind: "limited", retryAfterMs: 60_000 });
    await expectStatus(store, limited, "WaitingQuota");
    send(waiting, "deferred by the limit");
    send(running, "busy");
    await expectStatus(store, running, "Running");

    const task = store.tasks.createTask(
      {
        kind: "delegate",
        chainId: "chain",
        hop: 1,
        depth: 1,
        parentRunId: askerRun,
        requesterBotId: asker.id,
        ownerBotId: running.id,
        roomId: asker.roomId,
        goal: "help",
        deliveryKey: "k",
        attended: true,
      },
      3,
    );
    expect("refused" in task).toBe(false);

    supervisor.stopAll();
    await expectStatus(store, running, "Cancelled");
    expect(latestRun(store, asker)?.status).toBe("Cancelled");
    expect(latestRun(store, limited)?.status).toBe("Cancelled");
    expect(latestRun(store, waiting)).toBeUndefined();
    expect(store.state().tasks).toEqual([]);
    expect(store.dueWakes(new Date(Date.now() + 120_000).toISOString())).toEqual([]);
  });
});
