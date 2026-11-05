import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { DatabaseSync } from "node:sqlite";

import {
  type Bot,
  type Command,
  protocolVersion,
  type RunStatus,
  ServerMessage,
} from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

import { fakeRunTurn, type RunTurn, type TurnOutcome } from "./engine.ts";
import { startServer } from "./server.ts";
import { buildDigest, type EventStore, openEventStore } from "./store.ts";

const token = "t".repeat(43);
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

let dataDir: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-supervisor-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

// Each turn waits until the test finishes it. An aborted turn settles with `onAbort`.
function scriptedEngine(onAbort: TurnOutcome = { kind: "failed" }) {
  const turns: Array<{
    prompt: string;
    sessionId: string;
    resume: boolean;
    deliver: () => void;
    finish: (o: TurnOutcome) => void;
  }> = [];
  const runTurn: RunTurn = ({ prompt, sessionId, resume, signal, onDelivered }) =>
    new Promise((resolve) => {
      turns.push({ prompt, sessionId, resume, deliver: onDelivered, finish: resolve });
      signal.addEventListener("abort", () => resolve(onAbort));
    });
  return { turns, runTurn };
}

const reply: TurnOutcome = { kind: "completed", text: "done" };

function connect(port: number, afterSeq = 0) {
  const params = new URLSearchParams({ protocolVersion: String(protocolVersion), token });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${params}`);
  cleanups.push(() => socket.terminate());
  const messages: ServerMessage[] = [];
  socket.on("message", (data) => messages.push(ServerMessage.parse(JSON.parse(data.toString()))));
  const ready = once(socket, "open").then(async () => {
    socket.send(JSON.stringify({ type: "subscribe", afterSeq }));
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
  });
  return { socket, messages, ready };
}

function postCommand(port: number, command: Command) {
  return fetch(`http://127.0.0.1:${port}/commands?protocolVersion=${protocolVersion}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(command),
  });
}

async function boot(
  runTurn: RunTurn = scriptedEngine().runTurn,
  options: { attended?: boolean; turnTimeoutMs?: number } = {},
) {
  const store = openEventStore(dataDir);
  const server = await startServer({
    port: 0,
    token,
    allowedOrigins: [],
    store,
    runTurn,
    turnTimeoutMs: options.turnTimeoutMs,
  });
  let open = true;
  const stop = async () => {
    if (open) {
      open = false;
      await server.close();
      store.close();
    }
  };
  cleanups.push(stop);
  if (options.attended !== false) {
    await connect(server.port).ready;
  }
  const command = (body: Command) => postCommand(server.port, body);
  const createBot = async (name = "Ada"): Promise<Bot> =>
    (await command({ type: "create-bot", name, personality: "" })).json() as Promise<Bot>;
  const send = (bot: Bot, body: string, messageId: string = NodeCrypto.randomUUID()) =>
    command({ type: "send-message", messageId, roomId: bot.roomId, body });
  return { store, port: server.port, stop, command, createBot, send };
}

const run = (store: EventStore, bot: Bot) => store.state().runs.find((r) => r.botId === bot.id);

async function expectStatus(store: EventStore, bot: Bot, status: RunStatus) {
  await vi.waitFor(() => expect(run(store, bot)?.status).toBe(status), { timeout: 3000 });
}

async function expectTurns(engine: ReturnType<typeof scriptedEngine>, count: number) {
  await vi.waitFor(() => expect(engine.turns).toHaveLength(count), { timeout: 5000 });
}

function query(sql: string) {
  const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

const count = (table: string) => Number(query(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n);
const ackedSeq = () => Number(query("SELECT acked_event_seq AS seq FROM scopes")[0]?.seq);
const pendingWakes = () =>
  Number(query("SELECT COUNT(*) AS n FROM wakes WHERE status = 'pending'")[0]?.n);

describe("sending", () => {
  it("does not duplicate the message or the wake when a send is retried", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    const id = NodeCrypto.randomUUID();
    expect((await send(bot, "hello", id)).status).toBe(200);
    expect((await send(bot, "hello", id)).status).toBe(200);
    await expectTurns(engine, 1);
    expect(store.state().messages).toHaveLength(1);
    expect(count("wakes")).toBe(1);
    expect(count("runs")).toBe(1);
  });

  it("refuses a message ID reused for different content", async () => {
    const { createBot, send } = await boot();
    const bot = await createBot();
    const id = NodeCrypto.randomUUID();
    await send(bot, "hello", id);
    expect((await send(bot, "something else", id)).status).toBe(409);
  });

  it("streams deltas without persisting them and stores the final reply", async () => {
    const store = openEventStore(dataDir);
    const server = await startServer({ port: 0, token, allowedOrigins: [], store });
    cleanups.push(async () => {
      await server.close();
      store.close();
    });
    const client = connect(server.port);
    await client.ready;
    const created = await postCommand(server.port, {
      type: "create-bot",
      name: "Ada",
      personality: "",
    });
    const { roomId } = (await created.json()) as Bot;
    await postCommand(server.port, {
      type: "send-message",
      messageId: NodeCrypto.randomUUID(),
      roomId,
      body: "hello there",
    });
    await vi.waitFor(() => expect(store.state().messages).toHaveLength(2), { timeout: 3000 });

    const streamed = () => client.messages.flatMap((m) => (m.type === "delta" ? [m.text] : []));
    await vi.waitFor(() => expect(streamed().join("")).toBe(store.state().messages[1]?.body));
    expect(streamed().length).toBeGreaterThan(1);
    expect(query("SELECT type FROM events").map(({ type }) => type)).not.toContain("delta");
  });

  it("refuses an unattended wake and keeps the message", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn, { attended: false });
    const bot = await createBot();
    await send(bot, "hello");
    await expectStatus(store, bot, "Refused");
    expect(run(store, bot)?.reason).toBe("unattended");
    expect(engine.turns).toEqual([]);
    expect(store.state().messages).toHaveLength(1);
  });
});

describe("claiming", () => {
  function queueOne(store: EventStore) {
    const bot = store.createBot({ name: "Ada", personality: "", engineAccountId: "claude" });
    store.sendMessage({
      id: NodeCrypto.randomUUID(),
      roomId: bot.roomId,
      body: "hi",
      attended: true,
    });
    const [wake] = store.dueWakes(new Date().toISOString());
    if (wake) {
      store.queueRun(wake);
    }
    return { bot, runId: store.queuedRuns()[0]?.id ?? "" };
  }

  it("lets only one of two claims on the same run win", () => {
    const first = openEventStore(dataDir);
    const second = openEventStore(dataDir);
    cleanups.push(
      () => first.close(),
      () => second.close(),
    );
    const { runId } = queueOne(first);
    const now = new Date().toISOString();
    const claims = [first.claimRun(runId, "boot-a", now), second.claimRun(runId, "boot-b", now)];
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("cannot claim a run that is no longer Queued", () => {
    const store = openEventStore(dataDir);
    cleanups.push(() => store.close());
    const { bot, runId } = queueOne(store);
    store.stopBot(bot.id);
    expect(store.claimRun(runId, "boot-a", new Date().toISOString())).toBeUndefined();
  });

  it("never gives a bot two active runs, and an Interrupted run does not block it", () => {
    const store = openEventStore(dataDir);
    cleanups.push(() => store.close());
    const { bot, runId } = queueOne(store);
    const send = (attended: boolean) =>
      store.sendMessage({ id: NodeCrypto.randomUUID(), roomId: bot.roomId, body: "x", attended });

    send(true);
    const [second] = store.dueWakes(new Date().toISOString());
    expect(second).toBeDefined();
    store.queueRun(second!);
    expect(count("runs")).toBe(1);
    expect(pendingWakes()).toBe(1);

    expect(store.claimRun(runId, "boot-a", new Date().toISOString())).toBeDefined();
    store.queueRun(second!);
    expect(count("runs")).toBe(1);

    store.recover("boot-b");
    expect(run(store, bot)?.status).toBe("Interrupted");
    store.queueRun(second!);
    expect(run(store, bot)?.status).toBe("Queued");
  });

  it("runs one turn at a time per account", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const [ada, ben] = [await createBot("Ada"), await createBot("Ben")];
    await send(ada, "one");
    await send(ben, "two");
    await expectStatus(store, ben, "Queued");
    expect(engine.turns).toHaveLength(1);

    engine.turns[0]?.finish(reply);
    await expectStatus(store, ben, "Running");
    expect(engine.turns[1]?.prompt).toBe("two");
  });

  it("saves the session ID on the scope before the turn starts and reuses it", async () => {
    const engine = scriptedEngine();
    let savedAtStart: unknown;
    const { createBot, send } = await boot((turn) => {
      savedAtStart = query("SELECT session_id AS id FROM scopes")[0]?.id;
      return engine.runTurn(turn);
    });
    const bot = await createBot();
    await send(bot, "one");
    await expectTurns(engine, 1);
    expect(savedAtStart).toBe(engine.turns[0]?.sessionId);

    engine.turns[0]?.finish(reply);
    await vi.waitFor(() => expect(ackedSeq()).toBeGreaterThan(0));
    await send(bot, "two");
    await expectTurns(engine, 2);
    expect(engine.turns[1]?.sessionId).toBe(engine.turns[0]?.sessionId);
  });
});

describe("input", () => {
  it("turns messages sent during a run into exactly one follow-up", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "first");
    await expectTurns(engine, 1);
    await send(bot, "second");
    await send(bot, "third");
    expect(pendingWakes()).toBe(1);

    engine.turns[0]?.finish(reply);
    await expectTurns(engine, 2);
    expect(engine.turns[1]?.prompt).toBe("second\n\nthird");
    engine.turns[1]?.finish(reply);
    await vi.waitFor(() => expect(store.state().messages).toHaveLength(5));
    await expectStatus(store, bot, "Completed");

    // The bot's own replies must not count as new input.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(engine.turns).toHaveLength(2);
    expect(count("runs")).toBe(2);
    expect(pendingWakes()).toBe(0);
  });

  it("leaves input unacked after a failed turn, and a later success acks it", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "first");
    await expectTurns(engine, 1);
    engine.turns[0]?.finish({ kind: "failed" });
    await expectStatus(store, bot, "Failed");
    expect(run(store, bot)?.reason).toBe("engine_failed");
    expect(ackedSeq()).toBe(0);
    expect(engine.turns).toHaveLength(1);

    await send(bot, "second");
    await expectTurns(engine, 2);
    expect(engine.turns[1]?.prompt).toBe("first\n\nsecond");
    engine.turns[1]?.finish(reply);
    await expectStatus(store, bot, "Completed");
    expect(ackedSeq()).toBeGreaterThan(0);
  });
});

describe("outcomes", () => {
  it("blocks the account on a limit and defers the wake without a run row", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const [ada, ben] = [await createBot("Ada"), await createBot("Ben")];
    await send(ada, "hello");
    await expectTurns(engine, 1);
    engine.turns[0]?.finish({ kind: "limited", retryAfterMs: 1500 });
    await expectStatus(store, ada, "Failed");
    expect(run(store, ada)?.reason).toBe("limited");
    expect(store.state().accounts[0]?.blockedUntil).not.toBeNull();

    await send(ben, "blocked too");
    expect(run(store, ben)).toBeUndefined();
    expect(count("runs")).toBe(1);
    expect(pendingWakes()).toBe(2);

    await expectTurns(engine, 2);
    expect(engine.turns[1]?.prompt).toBe("hello");
    await vi.waitFor(() => expect(store.state().accounts[0]?.blockedUntil).toBeNull());
  });

  it("pauses the bot on an auth failure and never retries", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "hello");
    await expectTurns(engine, 1);
    engine.turns[0]?.finish({ kind: "auth_failed" });
    await expectStatus(store, bot, "Failed");
    expect(run(store, bot)?.reason).toBe("auth_failed");
    expect(store.state().bots[0]).toMatchObject({ status: "paused", pauseReason: "auth_failed" });

    await send(bot, "again");
    await expectStatus(store, bot, "Refused");
    expect(run(store, bot)?.reason).toBe("bot_paused");
    expect(engine.turns).toHaveLength(1);
  });

  it("keeps a limit or auth failure that comes back from a stopped turn", async () => {
    const engine = scriptedEngine({ kind: "auth_failed" });
    const { store, command, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "hello");
    await expectTurns(engine, 1);
    await command({ type: "stop-bot", botId: bot.id });
    await expectStatus(store, bot, "Failed");
    expect(store.state().bots[0]?.status).toBe("paused");
  });

  it("clamps a wild retry time and never strands a run on a bad one", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "hello");
    await expectTurns(engine, 1);
    engine.turns[0]?.finish({ kind: "limited", retryAfterMs: Number.NaN });
    await expectStatus(store, bot, "Failed");
    expect(run(store, bot)?.reason).toBe("engine_failed");
    expect(store.state().accounts[0]?.blockedUntil).toBeNull();

    await send(bot, "again");
    await expectTurns(engine, 2);
    engine.turns[1]?.finish({ kind: "limited", retryAfterMs: Number.MAX_VALUE });
    await vi.waitFor(() => expect(store.state().accounts[0]?.blockedUntil).not.toBeNull());
    const blockedFor = Date.parse(store.state().accounts[0]?.blockedUntil ?? "") - Date.now();
    expect(blockedFor).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it("fails a turn that outlives its timeout", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn, { turnTimeoutMs: 20 });
    const bot = await createBot();
    await send(bot, "hello");
    await expectStatus(store, bot, "Failed");
    expect(run(store, bot)?.reason).toBe("timeout");
    expect(ackedSeq()).toBe(0);
  });

  it("cancels on stop, ignoring a late result, and drops the pending follow-up", async () => {
    const engine = scriptedEngine({ kind: "completed", text: "too late" });
    const { store, command, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "hello");
    await expectTurns(engine, 1);
    await send(bot, "more");
    await command({ type: "stop-bot", botId: bot.id });
    await expectStatus(store, bot, "Cancelled");
    expect(store.state().messages.map(({ body }) => body)).toEqual(["hello", "more"]);
    expect(ackedSeq()).toBe(0);
    expect(pendingWakes()).toBe(0);
    expect(engine.turns).toHaveLength(1);
    expect(query("SELECT status FROM audit_log").at(-1)).toEqual({ status: "Cancelled" });
  });

  it("stops every running and queued run on stop-all", async () => {
    const engine = scriptedEngine();
    const { store, command, createBot, send } = await boot(engine.runTurn);
    const [ada, ben] = [await createBot("Ada"), await createBot("Ben")];
    await send(ada, "one");
    await send(ben, "two");
    await expectStatus(store, ben, "Queued");
    await command({ type: "stop-all" });
    await expectStatus(store, ada, "Cancelled");
    await expectStatus(store, ben, "Cancelled");
    expect(engine.turns).toHaveLength(1);
  });

  it("refuses a Queued run whose bot was paused before it started", async () => {
    const engine = scriptedEngine();
    const { store, command, createBot, send } = await boot(engine.runTurn);
    const [ada, ben] = [await createBot("Ada"), await createBot("Ben")];
    await send(ada, "one");
    await send(ben, "two");
    await expectStatus(store, ben, "Queued");
    await command({ type: "set-bot-paused", botId: ben.id, paused: true });
    await expectStatus(store, ben, "Refused");
    expect(run(store, ben)?.reason).toBe("bot_paused");
  });

  it("writes run lifecycle changes to the audit log without message content", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "secret words");
    await expectTurns(engine, 1);
    engine.turns[0]?.finish(reply);
    await expectStatus(store, bot, "Completed");
    const rows = query("SELECT * FROM audit_log ORDER BY id");
    expect(rows.map(({ status }) => status)).toEqual(["Queued", "Running", "Completed"]);
    expect(JSON.stringify(rows)).not.toContain("secret words");
  });
});

describe("restart", () => {
  it("interrupts Running, proceeds with Queued, and repeats nothing", async () => {
    const before = scriptedEngine();
    const first = await boot(before.runTurn);
    const [ada, ben] = [await first.createBot("Ada"), await first.createBot("Ben")];
    await first.send(ada, "running");
    await first.send(ben, "queued");
    await expectStatus(first.store, ben, "Queued");
    const wakes = count("wakes");
    await first.stop();

    const after = scriptedEngine();
    const { store } = await boot(after.runTurn);
    await expectTurns(after, 1);
    expect(after.turns[0]?.prompt).toBe("queued");
    expect(run(store, ada)).toMatchObject({ status: "Interrupted", reason: "server_restarted" });
    expect(run(store, ben)?.status).toBe("Running");
    expect(count("wakes")).toBe(wakes);
    expect(store.state().messages).toHaveLength(2);
    expect(query("SELECT status FROM audit_log").map(({ status }) => status)).toContain(
      "Interrupted",
    );

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(after.turns).toHaveLength(1);
  });

  it("waits for a human before answering input from around an interrupted run", async () => {
    const before = scriptedEngine();
    const first = await boot(before.runTurn);
    const bot = await first.createBot();
    await first.send(bot, "first");
    await expectTurns(before, 1);
    await first.send(bot, "second");
    const wakes = count("wakes");
    await first.stop();

    const after = scriptedEngine();
    const { store, command } = await boot(after.runTurn);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(after.turns).toEqual([]);
    expect(count("wakes")).toBe(wakes);
    expect(pendingWakes()).toBe(0);

    await command({ type: "continue-run", runId: run(store, bot)?.id ?? "" });
    await expectTurns(after, 1);
    expect(after.turns[0]?.prompt).toBe("first\n\nsecond");
  });

  it("can continue again after a continued wake was stopped", async () => {
    const before = scriptedEngine();
    const first = await boot(before.runTurn);
    const [ada, ben] = [await first.createBot("Ada"), await first.createBot("Ben")];
    await first.send(ada, "hello");
    await expectTurns(before, 1);
    await first.stop();

    const after = scriptedEngine();
    const { store, command, send } = await boot(after.runTurn);
    await send(ben, "limit me");
    await expectTurns(after, 1);
    after.turns[0]?.finish({ kind: "limited", retryAfterMs: 1000 });
    await vi.waitFor(() => expect(store.state().accounts[0]?.blockedUntil).not.toBeNull());

    const runId = run(store, ada)?.id ?? "";
    await command({ type: "continue-run", runId });
    expect(pendingWakes()).toBe(2);
    await command({ type: "continue-run", runId });
    expect(pendingWakes()).toBe(2);
    await command({ type: "stop-bot", botId: ada.id });
    expect(pendingWakes()).toBe(1);
    expect((await command({ type: "continue-run", runId })).status).toBe(200);
    expect(pendingWakes()).toBe(2);
  });

  it("creates a wake on Continue, once, and never on restart", async () => {
    const before = scriptedEngine();
    const first = await boot(before.runTurn);
    const bot = await first.createBot();
    await first.send(bot, "hello");
    await expectTurns(before, 1);
    await first.stop();

    const after = scriptedEngine();
    const { store, command } = await boot(after.runTurn);
    await expectStatus(store, bot, "Interrupted");
    expect(count("wakes")).toBe(1);
    expect(after.turns).toEqual([]);

    const interrupted = run(store, bot)?.id ?? "";
    await command({ type: "continue-run", runId: interrupted });
    await expectTurns(after, 1);
    expect(count("wakes")).toBe(2);
    expect(after.turns[0]?.prompt).toBe("hello");

    expect((await command({ type: "continue-run", runId: interrupted })).status).toBe(409);
    expect(count("wakes")).toBe(2);

    after.turns[0]?.finish(reply);
    await expectStatus(store, bot, "Completed");
    expect(ackedSeq()).toBeGreaterThan(0);
  });

  it("does not allow Continue on a run that was not interrupted", async () => {
    const engine = scriptedEngine();
    const { store, command, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "hello");
    await expectTurns(engine, 1);
    const response = await command({ type: "continue-run", runId: run(store, bot)?.id ?? "" });
    expect(response.status).toBe(409);
  });

  it("survives a hard kill mid-turn with history intact and no repeat", async () => {
    const probe = NodeNet.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const { port } = probe.address() as NodeNet.AddressInfo;
    await new Promise((resolve) => probe.close(resolve));

    const entry = NodePath.join(import.meta.dirname, "index.ts");
    const child = NodeChildProcess.spawn(process.execPath, [entry], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    cleanups.push(() => void child.kill());
    const bootstrap = {
      port,
      token,
      dataDir,
      allowedOrigins: [],
      fakeEngine: true,
      claudeCommand: ["beebot-no-such-cli"],
    };
    child.stdin.write(`${JSON.stringify(bootstrap)}\n`);
    for await (const line of NodeReadline.createInterface({ input: child.stderr })) {
      if (line.includes("listening")) {
        break;
      }
    }

    await connect(port).ready;
    const created = await postCommand(port, {
      type: "create-bot",
      name: "Ada",
      personality: "",
      engineAccountId: "fake",
    });
    const bot = (await created.json()) as Bot;
    await postCommand(port, {
      type: "send-message",
      messageId: NodeCrypto.randomUUID(),
      roomId: bot.roomId,
      body: "/hang",
    });
    await vi.waitFor(() =>
      expect(query("SELECT status FROM runs")).toEqual([{ status: "Running" }]),
    );
    child.kill("SIGKILL");
    await once(child, "exit");

    const after = scriptedEngine();
    const { store } = await boot(after.runTurn);
    expect(run(store, bot)?.status).toBe("Interrupted");
    expect(store.state().messages.map(({ body }) => body)).toEqual(["/hang"]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(after.turns).toEqual([]);
  }, 20_000);
});

describe("delivery", () => {
  const note = /cut off before it finished/;

  it("uses a session ID first and --resume once something was delivered", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "first");
    await expectTurns(engine, 1);
    expect(engine.turns[0]?.resume).toBe(false);
    engine.turns[0]?.finish(reply);
    await expectStatus(store, bot, "Completed");

    await send(bot, "second");
    await expectTurns(engine, 2);
    expect(engine.turns[1]).toMatchObject({
      prompt: "second",
      resume: true,
      sessionId: engine.turns[0]?.sessionId,
    });
  });

  it("never resends after a kill: Continue sends only the note", async () => {
    const before = scriptedEngine();
    const first = await boot(before.runTurn);
    const bot = await first.createBot();
    await first.send(bot, "hello");
    await expectTurns(before, 1);
    before.turns[0]?.deliver();
    await first.stop();

    const after = scriptedEngine();
    const { store, command } = await boot(after.runTurn);
    await expectStatus(store, bot, "Interrupted");
    await command({ type: "continue-run", runId: run(store, bot)?.id ?? "" });
    await expectTurns(after, 1);
    expect(after.turns[0]?.prompt).toMatch(note);
    expect(after.turns[0]?.prompt).not.toContain("hello");
    expect(after.turns[0]?.resume).toBe(true);
    after.turns[0]?.finish(reply);
    await expectStatus(store, bot, "Completed");
    expect(ackedSeq()).toBeGreaterThan(0);
  });

  it("sends only new input after a delivered turn failed", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "first");
    await expectTurns(engine, 1);
    engine.turns[0]?.deliver();
    engine.turns[0]?.finish({ kind: "failed" });
    await expectStatus(store, bot, "Failed");
    await send(bot, "second");
    await expectTurns(engine, 2);
    expect(engine.turns[1]?.prompt).toBe("second");
  });

  it("still sends input that never reached the engine after a kill", async () => {
    const before = scriptedEngine();
    const first = await boot(before.runTurn);
    const bot = await first.createBot();
    await first.send(bot, "hello");
    await expectTurns(before, 1);
    await first.stop();

    const after = scriptedEngine();
    const { store, command } = await boot(after.runTurn);
    await command({ type: "continue-run", runId: run(store, bot)?.id ?? "" });
    await expectTurns(after, 1);
    expect(after.turns[0]).toMatchObject({ prompt: "hello", resume: false });
  });

  it("keeps a message sent mid-turn for its own turn", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "first");
    await expectTurns(engine, 1);
    engine.turns[0]?.deliver();
    await send(bot, "second");
    engine.turns[0]?.finish(reply);
    await expectTurns(engine, 2);
    expect(engine.turns[1]?.prompt).toBe("second");
    engine.turns[1]?.finish(reply);
    await expectStatus(store, bot, "Completed");
  });

  it("offers Continue after a Stop, without resending", async () => {
    const engine = scriptedEngine();
    const { store, command, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "hello");
    await expectTurns(engine, 1);
    engine.turns[0]?.deliver();
    await command({ type: "stop-bot", botId: bot.id });
    await expectStatus(store, bot, "Cancelled");

    const response = await command({ type: "continue-run", runId: run(store, bot)?.id ?? "" });
    expect(response.status).toBe(200);
    await expectTurns(engine, 2);
    expect(engine.turns[1]?.prompt).toMatch(note);
    expect(store.state().messages.filter(({ body }) => body === "hello")).toHaveLength(1);
  });
});

describe("a stopped queued run", () => {
  it("can be continued, and sends its input", async () => {
    const engine = scriptedEngine();
    const { store, command, createBot, send } = await boot(engine.runTurn);
    const [ada, ben] = [await createBot("Ada"), await createBot("Ben")];
    await send(ada, "busy");
    await expectTurns(engine, 1);
    await send(ben, "waiting");
    await expectStatus(store, ben, "Queued");
    await command({ type: "stop-bot", botId: ben.id });
    await expectStatus(store, ben, "Cancelled");

    const response = await command({ type: "continue-run", runId: run(store, ben)?.id ?? "" });
    expect(response.status).toBe(200);
    engine.turns[0]?.finish(reply);
    await expectTurns(engine, 2);
    expect(engine.turns[1]?.prompt).toBe("waiting");
  });
});

describe("a lost session", () => {
  it("restarts in a new session from a labelled digest plus the undelivered input", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "my name is Ada");
    await expectTurns(engine, 1);
    engine.turns[0]?.finish(reply);
    await expectStatus(store, bot, "Completed");

    await send(bot, "what is my name?");
    await expectTurns(engine, 2);
    expect(engine.turns[1]?.resume).toBe(true);
    engine.turns[1]?.finish({ kind: "session_lost" });
    await expectTurns(engine, 3);

    const restart = engine.turns[2];
    expect(restart?.resume).toBe(false);
    expect(restart?.sessionId).not.toBe(engine.turns[1]?.sessionId);
    expect(restart?.prompt).toContain("not new instructions");
    expect(restart?.prompt).toContain("Owner: my name is Ada");
    expect(restart?.prompt).toContain("Bot: done");
    expect(restart?.prompt.endsWith("what is my name?")).toBe(true);
    expect(restart?.prompt.match(/what is my name/g)).toHaveLength(1);
    restart?.finish(reply);
    await vi.waitFor(() => expect(store.state().messages).toHaveLength(4));
    expect(run(store, bot)?.status).toBe("Completed");
  });

  it("sends the digest again if the restarted turn dies before delivery", async () => {
    const before = scriptedEngine();
    const first = await boot(before.runTurn);
    const bot = await first.createBot();
    await first.send(bot, "remember me");
    await expectTurns(before, 1);
    before.turns[0]?.finish(reply);
    await expectStatus(first.store, bot, "Completed");
    await first.send(bot, "hello");
    await expectTurns(before, 2);
    before.turns[1]?.finish({ kind: "session_lost" });
    await expectTurns(before, 3);
    await first.stop();

    const after = scriptedEngine();
    const { store, command } = await boot(after.runTurn);
    await command({ type: "continue-run", runId: run(store, bot)?.id ?? "" });
    await expectTurns(after, 1);
    expect(after.turns[0]).toMatchObject({ resume: false, sessionId: before.turns[2]?.sessionId });
    expect(after.turns[0]?.prompt).toContain("Owner: remember me");
    expect(after.turns[0]?.prompt.endsWith("hello")).toBe(true);
  });

  it("fails rather than loops if the restart loses its session too", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "hello");
    await expectTurns(engine, 1);
    engine.turns[0]?.finish({ kind: "session_lost" });
    await expectTurns(engine, 2);
    engine.turns[1]?.finish({ kind: "session_lost" });
    await expectStatus(store, bot, "Failed");
    expect(run(store, bot)?.reason).toBe("engine_failed");
    expect(engine.turns).toHaveLength(2);
  });

  it("keeps the digest within its cap and the newest messages", () => {
    const old = { author: "human", body: "x".repeat(9000) } as const;
    const digest = buildDigest([{ author: "bot", body: "newest" }, old, old, old]);
    expect(digest.length).toBeLessThanOrEqual(16_000);
    expect(digest).toContain("Bot: newest");
    expect(digest.match(/Owner: /g)).toHaveLength(1);

    const huge = buildDigest([{ author: "human", body: `${"x".repeat(40_000)}end` }]);
    expect(huge.length).toBeLessThanOrEqual(16_000);
    expect(huge).toContain("end\n");
    expect(buildDigest([])).toBe("");
  });
});

describe("engine accounts", () => {
  it("puts new bots on the claude account and refuses the fake one by default", async () => {
    const { command, createBot } = await boot();
    expect((await createBot()).engineAccountId).toBe("claude");
    const refused = await command({
      type: "create-bot",
      name: "Test",
      personality: "",
      engineAccountId: "fake",
    });
    expect(refused.status).toBe(403);
  });

  it("does not move a bot that is already on the fake account", () => {
    const store = openEventStore(dataDir);
    const bot = store.createBot({ name: "Old", personality: "", engineAccountId: "fake" });
    store.close();
    const reopened = openEventStore(dataDir);
    cleanups.push(() => reopened.close());
    expect(reopened.state().bots.find(({ id }) => id === bot.id)?.engineAccountId).toBe("fake");
  });

  it("pauses ready bots of one account and leaves an owner's pause alone", () => {
    const store = openEventStore(dataDir);
    cleanups.push(() => store.close());
    const fields = { personality: "", engineAccountId: "claude" };
    const ready = store.createBot({ name: "Ready", ...fields });
    const owned = store.createBot({ name: "Owned", ...fields });
    const fake = store.createBot({ name: "Fake", personality: "", engineAccountId: "fake" });
    store.setBotPause(owned.id, "owner");

    store.pauseReadyBots("claude", "cli_version");
    const reason = (id: string) => store.state().bots.find((b) => b.id === id)?.pauseReason;
    expect(reason(ready.id)).toBe("cli_version");
    expect(reason(owned.id)).toBe("owner");
    expect(reason(fake.id)).toBeNull();
  });

  it("carries a specific pause reason from a turn to the bot", async () => {
    const engine = scriptedEngine();
    const { store, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    await send(bot, "hello");
    await expectTurns(engine, 1);
    engine.turns[0]?.finish({ kind: "auth_failed", pauseReason: "cli_missing" });
    await expectStatus(store, bot, "Failed");
    expect(store.state().bots[0]?.pauseReason).toBe("cli_missing");
  });
});

describe("reconnecting", () => {
  it("catches a client up by replay, and a pruned client by snapshot", async () => {
    const engine = scriptedEngine();
    const { store, port, createBot, send } = await boot(engine.runTurn);
    const bot = await createBot();
    const cursor = store.bounds().latest;
    await send(bot, "hello");
    await expectTurns(engine, 1);
    engine.turns[0]?.finish(reply);
    await expectStatus(store, bot, "Completed");

    const replaying = connect(port, cursor);
    await replaying.ready;
    const [replay] = replaying.messages;
    if (replay?.type !== "replay") {
      throw new Error("expected a replay");
    }
    const types = replay.events.map(({ type }) => type);
    expect(types).toContain("message.created");
    expect(replay.events.at(-1)).toMatchObject({
      type: "run.changed",
      run: { status: "Completed" },
    });

    store.prune(1);
    const pruned = connect(port, cursor);
    await pruned.ready;
    expect(pruned.messages[0]).toEqual({
      type: "snapshot",
      seq: store.bounds().latest,
      state: store.state(),
    });
    expect(store.state().messages).toHaveLength(2);
  });
});

describe("fake engine", () => {
  const turn = (prompt: string, signal = new AbortController().signal) =>
    fakeRunTurn({
      prompt,
      sessionId: "s",
      resume: false,
      launch: { botId: "b", name: "Ada", personality: "", engineAccountId: "fake" },
      signal,
      onDelta: () => {},
      onDelivered: () => {},
    });

  it("is scripted by the last line of the prompt", async () => {
    expect(await turn("old\n\n/fail")).toEqual({ kind: "failed" });
    expect(await turn("/auth")).toEqual({ kind: "auth_failed" });
    expect(await turn("/limit 5")).toEqual({ kind: "limited", retryAfterMs: 5000 });
    expect(await turn("/fail\n\nhi")).toMatchObject({ kind: "completed" });
  });

  it("hangs until aborted", async () => {
    const controller = new AbortController();
    const hanging = turn("/hang", controller.signal);
    controller.abort();
    expect(await hanging).toEqual({ kind: "failed" });
  });
});
