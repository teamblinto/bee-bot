import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Bot, RunStatus } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { monthStart } from "./admission.ts";
import { createApprovals } from "./approvals.ts";
import { toolRules } from "./broker.ts";
import { BoxLimitReached } from "./boxRuntime.ts";
import { callBotTool } from "./botTools.ts";
import type { RunTurn, TurnOutcome } from "./engine.ts";
import { meetingToolNames } from "./meetingTools.ts";
import { createOutboxWorker, type Deliver } from "./outbox.ts";
import { continueWindowMs, outwardTool, recoveryVerdict } from "./recovery.ts";
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
    botId: string;
    prompt: string;
    resume: boolean;
    deliver: () => void;
    tool: (id: string, name?: string) => void;
    toolEnd: (id: string) => void;
    finish: (outcome: TurnOutcome) => void;
  }> = [];
  const runTurn: RunTurn = ({
    prompt,
    resume,
    launch,
    signal,
    onDelivered,
    onToolStart,
    onToolEnd,
  }) =>
    new Promise((resolve) => {
      turns.push({
        botId: launch.botId,
        prompt,
        resume,
        deliver: onDelivered,
        tool: (id, name = "Bash") => onToolStart({ id, name, detail: null }),
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
  options: {
    turnTimeoutMs?: number;
    silenceMs?: number;
    clock?: AwakeClock;
    prepareBox?: (botId: string) => Promise<void>;
    monthlyBudgetUsd?: number;
  } = {},
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

  const facts = {
    unsettledEffects: 0,
    outwardDone: false,
    activeChildTasks: 0,
    taskHeld: false,
    recoveredBefore: false,
    continuedAt: [],
    now,
  };

  it("waits on children, then fails an outward or twice-cut turn, then holds, then continues", () => {
    const all = { ...facts, unsettledEffects: 1, outwardDone: true, recoveredBefore: true };
    expect(recoveryVerdict({ ...all, activeChildTasks: 1 })).toBe("wait");
    expect(recoveryVerdict({ ...all, taskHeld: true })).toBe("wait");
    expect(recoveryVerdict(all)).toBe("fail");
    expect(recoveryVerdict({ ...all, outwardDone: false })).toBe("fail");
    expect(recoveryVerdict({ ...facts, unsettledEffects: 1 })).toBe("hold");
    expect(recoveryVerdict(facts)).toBe("continue");
  });

  it("continues at most 3 times in 5 minutes", () => {
    const two = [ago(1000), ago(2000)];
    expect(recoveryVerdict({ ...facts, continuedAt: two })).toBe("continue");
    const three = [...two, ago(3000)];
    expect(recoveryVerdict({ ...facts, continuedAt: three })).toBe("hold");
    const stale = [...two, ago(continueWindowMs + 1)];
    expect(recoveryVerdict({ ...facts, continuedAt: stale })).toBe("continue");
  });

  it("counts every Bee Bot tool as unrepeatable unless it is safe to repeat", () => {
    const repeatable = new Set([
      "task_status",
      "read_bot_activity",
      "memory_search",
      "memory_get",
      "browser_snapshot",
      "computer_screenshot",
      "computer_windows",
      "computer_look",
      "computer_desktop",
      "request_takeover",
      "share_file",
    ]);
    for (const name of Object.keys(toolRules)) {
      const tool = `mcp__bee__${name}`;
      expect(outwardTool(tool), tool).toBe(!repeatable.has(name));
    }
    for (const tool of [
      "mcp__bee__memory_propose",
      "mcp__bee__memory_forget",
      "mcp__bee__ask_user",
      "mcp__bee__notify",
      "mcp__bee__nope",
      "mcp__connectors__github_create_issue",
    ]) {
      expect(outwardTool(tool), tool).toBe(true);
    }
    for (const name of meetingToolNames) {
      expect(outwardTool(`mcp__bee__${name}`), name).toBe(true);
    }
    for (const tool of ["Bash", "Write", "Patch"]) {
      expect(outwardTool(tool), tool).toBe(false);
    }
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

  // Boss hands Ada a task, so Ada's turn, the second one, works on it.
  async function handedTask(
    process: ReturnType<typeof boot>,
    engine: ReturnType<typeof scriptedEngine>,
  ) {
    const { store } = process;
    const [boss, ada, ben] = ["Boss", "Ada", "Ben"].map((name) => createBot(store, name, "fake"));
    if (!boss || !ada || !ben) {
      throw new Error("no team");
    }
    store.rooms.createGroupRoom({ name: "Team", memberIds: [boss.id, ada.id, ben.id] });
    process.send(boss, "go");
    await expectTurns(engine, 1);
    const bossRun = { id: latestRun(store, boss)?.id ?? "", botId: boss.id };
    callBotTool(store, bossRun, "delegate", { to: "Ada", goal: "Plan it" });
    engine.turns[0]?.finish(reply);
    await expectTurns(engine, 2);
    const task = store.state().tasks.find((t) => t.ownerBotId === ada.id);
    if (!task) {
      throw new Error("no task");
    }
    return { ada, ben, task, adaRun: { id: latestRun(store, ada)?.id ?? "", botId: ada.id } };
  }

  it("waits on a run that already delegated, and never re-runs it", async () => {
    const before = scriptedEngine();
    const first = boot(before.runTurn);
    const { ada, ben, task, adaRun } = await handedTask(first, before);
    callBotTool(first.store, adaRun, "delegate", { to: "Ben", goal: "Help Ada" });
    await first.kill();

    const after = scriptedEngine();
    const { store } = boot(after.runTurn);
    expect(store.state().runs.find(({ id }) => id === adaRun.id)?.status).toBe("Interrupted");
    expect(store.tasks.getTask(task.id)?.status).toBe("waiting");
    expect(store.recentRecoveries(ada.id, 1)).toEqual([]);
    await expectTurns(after, 1);
    expect(after.turns[0]?.botId).toBe(ben.id);
    await ticks(1);
    expect(after.turns).toHaveLength(1);
  });

  it.each([true, false])(
    "fails and reports a run that already sent a message outward (confirmed: %s)",
    async (confirmed) => {
      const before = scriptedEngine();
      const first = boot(before.runTurn);
      const { ada, task } = await handedTask(first, before);
      before.turns[1]?.tool("t1", "mcp__bee__send_message");
      if (confirmed) {
        before.turns[1]?.toolEnd("t1");
      }
      await first.kill();

      const after = scriptedEngine();
      const { store } = boot(after.runTurn);
      expect(store.tasks.getTask(task.id)?.status).toBe("failed");
      expect(store.state().messages.at(-1)).toMatchObject({
        botId: ada.id,
        body: "The server restarted after this turn had already done something that can't safely be repeated, so it wasn't run again. Check what it did, then send a message to carry on.",
      });
      await ticks(1);
      expect(after.turns.filter(({ botId }) => botId === ada.id)).toEqual([]);
    },
  );

  it.each([
    "mcp__bee__schedule_wakeup",
    "mcp__bee__wait_until",
    "mcp__bee__create_routine",
    "mcp__bee__handoff",
    "mcp__bee__follow_up",
    "mcp__bee__notify",
    "mcp__bee__report_progress",
  ])("fails and reports a run that already called %s", async (tool) => {
    const before = scriptedEngine();
    const first = boot(before.runTurn);
    const { ada, task } = await handedTask(first, before);
    before.turns[1]?.tool("t1", tool);
    before.turns[1]?.toolEnd("t1");
    await first.kill();

    const after = scriptedEngine();
    const { store, supervisor } = boot(after.runTurn);
    expect(store.tasks.getTask(task.id)?.status).toBe("failed");
    expect(store.state().messages.at(-1)).toMatchObject({
      botId: ada.id,
      body: "The server restarted after this turn had already done something that can't safely be repeated, so it wasn't run again. Check what it did, then send a message to carry on.",
    });
    supervisor.pump();
    await ticks(1);
    expect(after.turns.filter(({ botId }) => botId === ada.id)).toEqual([]);
  });

  it("leaves a task its wait holds waiting, and never re-runs the turn", async () => {
    const before = scriptedEngine();
    const first = boot(before.runTurn);
    const { ada, ben, task, adaRun } = await handedTask(first, before);
    before.turns[1]?.tool("t1", "mcp__bee__wait_until");
    callBotTool(first.store, adaRun, "wait_until", {
      condition: { kind: "bot_idle", bot_id: ben.id },
      note: "Wait for Ben",
      timeout_minutes: 5,
    });
    before.turns[1]?.toolEnd("t1");
    await first.kill();

    const after = scriptedEngine();
    const { store, supervisor } = boot(after.runTurn);
    expect(store.tasks.getTask(task.id)?.status).toBe("waiting");
    supervisor.pump();
    await ticks(1);
    expect(after.turns.filter(({ botId }) => botId === ada.id)).toEqual([]);
  });

  it("re-runs a turn that only read", async () => {
    const before = scriptedEngine();
    const first = boot(before.runTurn);
    const { ada } = await handedTask(first, before);
    before.turns[1]?.tool("t1", "mcp__bee__task_status");
    before.turns[1]?.toolEnd("t1");
    await first.kill();

    const after = scriptedEngine();
    const { supervisor } = boot(after.runTurn);
    supervisor.pump();
    await expectTurns(after, 1);
    expect(after.turns[0]?.botId).toBe(ada.id);
  });

  it("fails and reports a run whose delegations already finished, and never delegates again", async () => {
    const before = scriptedEngine();
    const first = boot(before.runTurn);
    const { ada, task, adaRun } = await handedTask(first, before);
    const delegated = callBotTool(first.store, adaRun, "delegate", { to: "Ben", goal: "Help" });
    const { task_id } = JSON.parse(delegated) as { task_id: string };
    first.store.tasks.finishTask(task_id, "done");
    await first.kill();

    const after = scriptedEngine();
    const { store, supervisor } = boot(after.runTurn);
    expect(store.tasks.getTask(task.id)?.status).toBe("failed");
    expect(store.state().messages.at(-1)).toMatchObject({
      botId: ada.id,
      body: "The server restarted after this turn had already done something that can't safely be repeated, so it wasn't run again. Check what it did, then send a message to carry on.",
    });
    supervisor.pump();
    await ticks(1);
    expect(after.turns.filter(({ botId }) => botId === ada.id)).toEqual([]);
  });

  it("re-runs a cut-off turn once, then fails it", async () => {
    let engine = scriptedEngine();
    let process = boot(engine.runTurn);
    const bot = createBot(process.store);
    process.send(bot, "hello");
    await expectTurns(engine, 1);
    await process.kill();

    engine = scriptedEngine();
    process = boot(engine.runTurn);
    process.supervisor.pump();
    await expectTurns(engine, 1);
    expect(engine.turns[0]?.prompt).toBe("hello");
    await process.kill();

    engine = scriptedEngine();
    const { store } = boot(engine.runTurn);
    await ticks(1);
    expect(engine.turns).toEqual([]);
    expect(latestRun(store, bot)?.status).toBe("Interrupted");
    expect(store.state().messages.at(-1)).toMatchObject({
      botId: bot.id,
      body: "This turn was cut off twice, so Bee Bot stopped retrying it. Send a message to carry on.",
    });
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
  it("cancels running, waiting and queued runs, pending wakes and open tasks across rooms", async () => {
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
    const queued = createBot(store, "Queued", "codex");
    const room = store.rooms.createGroupRoom({ name: "Team", memberIds: [running.id, queued.id] });
    if (!room) {
      throw new Error("no room");
    }
    const inRoom = { id: NodeCrypto.randomUUID(), roomId: room.id, attended: true };
    expect(store.sendMessage({ ...inRoom, body: "@running busy" })).toBe("sent");
    supervisor.pump();
    await expectStatus(store, running, "Running");
    send(queued, "behind the gate");
    await expectStatus(store, queued, "Queued");

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
    const turns = engine.turns.length;

    supervisor.stopAll();
    await expectStatus(store, running, "Cancelled");
    expect(latestRun(store, asker)?.status).toBe("Cancelled");
    expect(latestRun(store, limited)?.status).toBe("Cancelled");
    expect(latestRun(store, queued)?.status).toBe("Cancelled");
    expect(latestRun(store, waiting)).toBeUndefined();
    expect(store.state().tasks).toEqual([]);
    expect(store.dueWakes(new Date(Date.now() + 120_000).toISOString())).toEqual([]);
    await ticks(1);
    expect(engine.turns).toHaveLength(turns);
  });

  it("cancels a task waiting on an answer, so it can't be answered after", async () => {
    const engine = scriptedEngine();
    const { store, supervisor, send } = boot(engine.runTurn);
    const asker = createBot(store, "Asker");
    const helper = createBot(store, "Helper");
    send(asker, "go");
    await expectTurns(engine, 1);
    const task = store.tasks.createTask(
      {
        kind: "delegate",
        chainId: "chain",
        hop: 1,
        depth: 1,
        parentRunId: latestRun(store, asker)?.id ?? "",
        requesterBotId: asker.id,
        ownerBotId: helper.id,
        roomId: asker.roomId,
        goal: "help",
        deliveryKey: "k",
        attended: true,
      },
      3,
    );
    if ("refused" in task) {
      throw new Error("refused");
    }
    const follow = (botId: string, kind: "ask" | "answer") =>
      store.tasks.followUp({ taskId: task.id, botId, kind, message: "?", attended: true });
    expect(follow(helper.id, "ask")).toMatchObject({ status: "needs_input" });

    supervisor.stopAll();
    expect(store.tasks.getTask(task.id)?.status).toBe("cancelled");
    expect(follow(asker.id, "answer")).toEqual({ refused: "wrong_state" });
  });

  it("opens no blocked task when everything stops", async () => {
    const engine = scriptedEngine();
    const { store, supervisor, send } = boot(engine.runTurn);
    const asker = createBot(store, "Asker");
    const helper = createBot(store, "Helper");
    const third = createBot(store, "Third");
    send(asker, "go");
    await expectTurns(engine, 1);
    const delegate = (ownerBotId: string, deliveryKey: string, blockedBy: string[] = []) => {
      const task = store.tasks.createTask(
        {
          kind: "delegate",
          chainId: "chain",
          hop: 1,
          depth: 1,
          parentRunId: latestRun(store, asker)?.id ?? "",
          requesterBotId: asker.id,
          ownerBotId,
          roomId: asker.roomId,
          goal: "help",
          deliveryKey,
          attended: true,
          blockedBy,
        },
        3,
      );
      if ("refused" in task) {
        throw new Error("refused");
      }
      return task;
    };
    const t1 = delegate(helper.id, "k1");
    const t2 = delegate(third.id, "k2", [t1.id]);

    supervisor.stopAll();
    expect(store.tasks.getTask(t2.id)?.status).toBe("cancelled");
    expect(store.state().messages.filter((m) => m.roomId === third.roomId)).toEqual([]);
    expect(store.dueWakes(new Date(Date.now() + 120_000).toISOString())).toEqual([]);
  });
});

describe("spend caps", () => {
  it("pauses a bot with reason budget when a turn takes it past its daily token cap", async () => {
    const engine = scriptedEngine();
    const hungry: RunTurn = (turn) => {
      turn.onTokens?.(5000);
      return engine.runTurn(turn);
    };
    const { store, send } = boot(hungry);
    const bot = createBot(store);
    store.setSpendCaps(bot.id, { dailyTokenCap: 4000, dailyUsdCap: null });
    send(bot, "hello");
    await expectTurns(engine, 1);
    expect(store.getBot(bot.id)?.status).toBe("ready");
    engine.turns[0]?.finish(reply);
    await expectStatus(store, bot, "Completed");
    expect(store.getBot(bot.id)).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(store.spentToday(bot.id, new Date().toISOString())).toEqual({ usd: 0, tokens: 5000 });

    send(bot, "again");
    await vi.waitFor(() => expect(latestRun(store, bot)).toMatchObject({ reason: "bot_paused" }));
    expect(engine.turns).toHaveLength(1);
  });

  it("keeps a bot over its cap from running once an engine pause or the owner's clears", async () => {
    const engine = scriptedEngine();
    const hungry: RunTurn = (turn) => {
      turn.onTokens?.(5000);
      return engine.runTurn(turn);
    };
    const { store, send } = boot(hungry);
    const bot = createBot(store);
    store.setSpendCaps(bot.id, { dailyTokenCap: 4000, dailyUsdCap: null });
    send(bot, "hello");
    await expectTurns(engine, 1);
    engine.turns[0]?.finish({ kind: "auth_failed" });
    await expectStatus(store, bot, "Failed");
    expect(store.getBot(bot.id)?.pauseReason).toBe("auth_failed");

    store.setBotPause(bot.id, null);
    expect(store.getBot(bot.id)).toMatchObject({ status: "paused", pauseReason: "budget" });
    store.setBotPause(bot.id, "owner");
    store.setBotPause(bot.id, null);
    expect(store.getBot(bot.id)).toMatchObject({ status: "paused", pauseReason: "budget" });
  });

  it("admits no wake for a ready bot that is over its cap", async () => {
    const engine = scriptedEngine();
    const { store, send } = boot(engine.runTurn);
    const bot = createBot(store);
    send(bot, "hello");
    await expectTurns(engine, 1);
    store.recordTokens(latestRun(store, bot)!.id, 5000);
    engine.turns[0]?.finish(reply);
    await expectStatus(store, bot, "Completed");
    store.setSpendCaps(bot.id, { dailyTokenCap: 4000, dailyUsdCap: null });
    expect(store.getBot(bot.id)?.status).toBe("ready");

    send(bot, "again");
    await vi.waitFor(() => expect(latestRun(store, bot)).toMatchObject({ reason: "bot_paused" }));
    expect(store.getBot(bot.id)).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(engine.turns).toHaveLength(1);
  });

  it("refuses a queued run whose bot went over its cap before it started", () => {
    const engine = scriptedEngine();
    const { store, supervisor } = boot(engine.runTurn);
    const bot = createBot(store);
    store.sendMessage({
      id: NodeCrypto.randomUUID(),
      roomId: bot.roomId,
      body: "hi",
      attended: true,
    });
    const [wake] = store.dueWakes(new Date().toISOString());
    store.queueRun(wake!);
    store.recordTokens(latestRun(store, bot)!.id, 5000);
    store.setSpendCaps(bot.id, { dailyTokenCap: 4000, dailyUsdCap: null });

    supervisor.pump();
    expect(latestRun(store, bot)).toMatchObject({ status: "Refused", reason: "bot_paused" });
    expect(store.getBot(bot.id)?.pauseReason).toBe("budget");
    expect(engine.turns).toHaveLength(0);
  });

  it("drops spend older than a day out of the window, and the budget pause with it", () => {
    const { store } = boot(scriptedEngine().runTurn);
    const bot = createBot(store);
    store.sendMessage({
      id: NodeCrypto.randomUUID(),
      roomId: bot.roomId,
      body: "hi",
      attended: true,
    });
    const [wake] = store.dueWakes(new Date().toISOString());
    store.queueRun(wake!);
    store.recordTokens(latestRun(store, bot)!.id, 5000);
    store.setSpendCaps(bot.id, { dailyTokenCap: 4000, dailyUsdCap: null });
    const now = Date.now();
    const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

    expect(store.enforceSpendCaps(bot.id, at(23))?.pauseReason).toBe("budget");
    expect(store.spentToday(bot.id, at(25))).toEqual({ usd: 0, tokens: 0 });
    expect(store.enforceSpendCaps(bot.id, at(25))).toMatchObject({
      status: "ready",
      pauseReason: null,
    });
  });
});

describe("server mode limits", () => {
  it("lets a running turn finish over budget, then refuses the next API-key run", async () => {
    const engine = scriptedEngine();
    const costly: RunTurn = (turn) => {
      turn.onCost?.(1.5);
      return engine.runTurn(turn);
    };
    const { store, send } = boot(costly, { monthlyBudgetUsd: 1 });
    store.setAccountLane("claude", "api_key");
    const bot = createBot(store);
    send(bot, "hello");
    await expectTurns(engine, 1);
    expect(store.spentSince(monthStart(new Date().toISOString()))).toBe(1.5);
    engine.turns[0]?.finish(reply);
    await expectStatus(store, bot, "Completed");

    send(bot, "again");
    await vi.waitFor(() => expect(latestRun(store, bot)).toMatchObject({ reason: "budget" }));
    expect(engine.turns).toHaveLength(1);
  });

  it("counts only this month's spend, and never against a subscription run", async () => {
    const engine = scriptedEngine();
    const { store, send } = boot(engine.runTurn, { monthlyBudgetUsd: 1 });
    store.recordSpend("run-old", 5);
    const next = new Date();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    expect(store.spentSince(monthStart(next.toISOString()))).toBe(0);

    const bot = createBot(store);
    send(bot, "hello");
    await expectTurns(engine, 1);
  });

  it("fails a turn that finds every box slot taken, without starting the engine", async () => {
    const engine = scriptedEngine();
    const { store, send } = boot(engine.runTurn, {
      prepareBox: async () => {
        throw new BoxLimitReached("3 of 3 boxes are running");
      },
    });
    const bot = createBot(store);
    send(bot, "hello");
    await vi.waitFor(() =>
      expect(latestRun(store, bot)).toMatchObject({ status: "Failed", reason: "box_limit" }),
    );
    expect(engine.turns).toHaveLength(0);
  });
});
