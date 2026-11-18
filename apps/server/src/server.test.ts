import * as NodeChildProcess from "node:child_process";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  Bot,
  type ChatState,
  type EngineLane,
  type EngineStatus,
  type PauseReason,
  maxAvatarSeed,
  protocolVersion,
  ServerInfo,
  ServerMessage,
} from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

import serverPackage from "../package.json" with { type: "json" };
import type { RunTurn, TurnOutcome } from "./engine.ts";
import { daemonTestTimeoutMs, spawnBeebotd } from "./fixtures/beebotd.ts";
import { writeMemoryFile } from "./memory.ts";
import { startServer } from "./server.ts";
import { migrate, migrations, openEventStore, seedFromId } from "./store.ts";
import type { Summarize } from "./summary.ts";
import { apiKeyName } from "./vault.ts";

const token = "t".repeat(43);
const appOrigin = "http://127.0.0.1:5833";
const auth = { Authorization: `Bearer ${token}` };

const healthy: EngineStatus = {
  cliFound: true,
  version: "2.1.318",
  auth: "authenticated" as const,
  email: null,
  pauseReason: null,
};

let dataDir: string;
let engineStatus: EngineStatus;
const probedLanes: EngineLane[] = [];
const probeEngine = async (lane: EngineLane) => {
  probedLanes.push(lane);
  return engineStatus;
};
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-server-"));
  engineStatus = healthy;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

const migrationIndex = (name: string) =>
  migrations.findIndex((migration) => migration.name === name);

// A database as the version before `name` left it.
async function seedBefore(name: string, sql: string) {
  const { DatabaseSync } = await import("node:sqlite");
  NodeFS.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
  migrate(db, migrationIndex(name));
  db.exec(sql);
  return db;
}

const oldBot = (id: string) => `INSERT INTO bots (id, name, personality, status, created_at)
    VALUES ('${id}', 'Ada', '', 'ready', 'then');
  INSERT INTO rooms (id, default_bot_id, created_at) VALUES ('room-${id}', '${id}', 'then');
  INSERT INTO scopes (id, room_id, bot_id) VALUES ('scope-${id}', 'room-${id}', '${id}');`;

async function start(port = 0, heartbeatMs?: number, summarize?: Summarize) {
  const store = openEventStore(dataDir);
  const server = await startServer({
    port,
    token,
    dataDir,
    allowedOrigins: [appOrigin],
    store,
    probeEngine,
    heartbeatMs,
    summarize,
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
  return {
    store,
    stop,
    base: `http://127.0.0.1:${server.port}`,
    port: server.port,
    power: server.power,
  };
}

const http = (base: string, path: string, init?: RequestInit) =>
  fetch(`${base}${path}?protocolVersion=${protocolVersion}`, init);

const command = (base: string, body: unknown, headers: Record<string, string> = auth) =>
  http(base, "/commands", { method: "POST", headers, body: JSON.stringify(body) });

const createBot = (base: string) =>
  command(base, { type: "create-bot", name: "Ada", personality: "" });

function wsUrl(port: number, query: Record<string, string> = {}) {
  const params = new URLSearchParams({
    protocolVersion: String(protocolVersion),
    token,
    ...query,
  });
  return `ws://127.0.0.1:${port}/ws?${params}`;
}

function upgradeStatus(url: string, origin?: string) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, origin ? { origin } : {});
    socket.on("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.on("open", () => {
      socket.terminate();
      reject(new Error("upgrade was accepted"));
    });
    socket.on("error", () => {});
  });
}

async function subscribe(port: number, afterSeq: number) {
  const socket = new WebSocket(wsUrl(port));
  cleanups.push(() => socket.terminate());
  const messages: ServerMessage[] = [];
  const waiters: Array<(message: ServerMessage) => void> = [];
  socket.on("message", (data) => {
    const message = ServerMessage.parse(JSON.parse(data.toString()));
    if (["pending-approvals", "model-catalog", "host-control"].includes(message.type)) {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      messages.push(message);
    }
  });
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "subscribe", afterSeq }));
  const next = () =>
    new Promise<ServerMessage>((resolve) => {
      const queued = messages.shift();
      if (queued) {
        resolve(queued);
      } else {
        waiters.push(resolve);
      }
    });
  return { socket, next };
}

describe("access", () => {
  it("refuses HTTP without the token or from a foreign Origin", async () => {
    const { base } = await start();
    expect((await http(base, "/health")).status).toBe(401);
    expect((await http(base, "/health", { headers: { Authorization: "Bearer no" } })).status).toBe(
      401,
    );
    const foreign = await http(base, "/health", {
      headers: { ...auth, Origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.has("access-control-allow-origin")).toBe(false);
    expect((await http(base, "/health", { headers: auth })).status).toBe(200);
    expect((await http(base, "/health", { headers: { ...auth, Origin: appOrigin } })).status).toBe(
      200,
    );
  });

  it("does not let a refused command write an event", async () => {
    const { base, store } = await start();
    const body = { type: "create-bot", name: "Ada", personality: "" };
    expect((await command(base, body, {})).status).toBe(401);
    const foreign = { ...auth, Origin: "https://evil.example" };
    expect((await command(base, body, foreign)).status).toBe(403);
    expect(store.eventsAfter(0)).toEqual([]);
  });

  it("refuses preflights from a foreign Origin", async () => {
    const { base } = await start();
    const preflight = (origin: string) =>
      http(base, "/commands", { method: "OPTIONS", headers: { Origin: origin } });
    expect((await preflight("https://evil.example")).status).toBe(403);
    const allowed = await preflight(appOrigin);
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(allowed.headers.get("access-control-allow-headers")).toContain("Content-Type");
  });

  it("refuses /state without the token", async () => {
    const { base } = await start();
    expect((await http(base, "/state")).status).toBe(401);
    expect((await http(base, "/state", { headers: auth })).status).toBe(200);
  });

  it("answers 400 to a body the contract refuses, or one that is too large", async () => {
    const { base, store } = await start();
    const send = (body: string) => http(base, "/commands", { method: "POST", headers: auth, body });
    expect((await send("not json")).status).toBe(400);
    expect((await send(JSON.stringify({ type: "create-bot", name: " " }))).status).toBe(400);
    expect((await send(JSON.stringify({ type: "nope" }))).status).toBe(400);
    const huge = { type: "create-bot", name: "Ada", personality: "x".repeat(300_000) };
    expect((await send(JSON.stringify(huge))).status).toBe(400);
    expect(store.eventsAfter(0)).toEqual([]);
  });

  it("refuses WebSocket upgrades without the token or from a foreign Origin", async () => {
    const { port } = await start();
    expect(await upgradeStatus(wsUrl(port, { token: "" }))).toBe(401);
    expect(await upgradeStatus(wsUrl(port), "https://evil.example")).toBe(403);
  });

  it("refuses a wrong protocol version with 426 and a notice", async () => {
    const { base, port } = await start();
    const response = await fetch(`${base}/health?protocolVersion=0`, { headers: auth });
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({
      code: "protocol_mismatch",
      serverProtocolVersion: protocolVersion,
    });
    expect(await upgradeStatus(wsUrl(port, { protocolVersion: "0" }))).toBe(426);
  });

  it("refuses a client from before memory", async () => {
    const { base, port } = await start();
    const response = await fetch(`${base}/state?protocolVersion=4`, { headers: auth });
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ code: "protocol_mismatch" });
    expect(await upgradeStatus(wsUrl(port, { protocolVersion: "4" }))).toBe(426);
  });
});

describe("event stream", () => {
  it("replays missed events on reconnect, then continues live without duplicates", async () => {
    const { base, port } = await start();
    await createBot(base);

    const first = await subscribe(port, 0);
    expect(await first.next()).toMatchObject({ type: "snapshot", seq: 1 });
    await createBot(base);
    expect(await first.next()).toMatchObject({ type: "event", event: { seq: 2 } });
    first.socket.terminate();

    await createBot(base);
    await createBot(base);

    const second = await subscribe(port, 2);
    const replay = await second.next();
    expect(replay).toMatchObject({ type: "replay" });
    expect(replay.type === "replay" && replay.events.map((event) => event.seq)).toEqual([3, 4]);
    await createBot(base);
    expect(await second.next()).toMatchObject({ type: "event", event: { seq: 5 } });
  });

  it("carries memory in both the snapshot and the replay", async () => {
    const { base, port, store } = await start();
    const { id: botId } = (await (await createBot(base)).json()) as { id: string };
    const seq = store.bounds().latest;
    const add = { type: "add-memory", botId, text: "likes tea", memoryType: "user" };
    await command(base, add);

    const fresh = await subscribe(port, 0);
    expect(await fresh.next()).toMatchObject({
      type: "snapshot",
      state: { memories: [{ text: "likes tea", status: "active", source: "user" }] },
    });

    const resumed = await subscribe(port, seq);
    expect(await resumed.next()).toMatchObject({
      type: "replay",
      events: [{ type: "memory.changed", memory: { text: "likes tea" } }],
    });
  });

  it("gives a client from before this boot a snapshot, and later cursors a replay", async () => {
    const before = await start();
    const { id: botId } = (await (await createBot(before.base)).json()) as { id: string };
    const cursor = before.store.bounds().latest;
    await before.stop();
    writeMemoryFile(dataDir, {
      id: "00000000-0000-4000-8000-000000000002",
      botId,
      type: "user",
      source: "user",
      sourceRef: "owner",
      status: "active",
      created: "2026-11-06T10:15:00.000Z",
      supersededBy: null,
      text: "healed at boot",
      scope: "bot",
    });

    const { base, port, store } = await start();
    expect(store.bounds().latest).toBe(cursor);
    const stale = await subscribe(port, cursor);
    expect(await stale.next()).toMatchObject({
      type: "snapshot",
      state: { memories: [{ text: "healed at boot" }] },
    });

    await createBot(base);
    await createBot(base);
    const live = await subscribe(port, cursor + 1);
    expect(await live.next()).toMatchObject({ type: "replay", events: [{ seq: cursor + 2 }] });
  });

  it("falls back to a snapshot when the cursor was pruned", async () => {
    const { base, port, store } = await start();
    for (let index = 0; index < 5; index += 1) {
      await createBot(base);
    }
    store.prune(2);

    const pruned = await subscribe(port, 1);
    const snapshot = await pruned.next();
    expect(snapshot).toMatchObject({ type: "snapshot", seq: 5 });
    expect(snapshot.type === "snapshot" && snapshot.state.bots).toHaveLength(5);

    const atEdge = await subscribe(port, 3);
    expect(await atEdge.next()).toMatchObject({ type: "replay" });
  });

  it("falls back to a snapshot when the cursor is ahead of the server", async () => {
    const { port } = await start();
    const client = await subscribe(port, 9);
    expect(await client.next()).toMatchObject({ type: "snapshot", seq: 0, state: { bots: [] } });
  });

  it("closes a socket that sends a malformed message", async () => {
    const { port } = await start();
    const socket = new WebSocket(wsUrl(port));
    await once(socket, "open");
    socket.send("not json");
    const [code] = await once(socket, "close");
    expect(code).toBe(1008);
  });

  it("drops a socket that stops answering pings, and keeps one that answers", async () => {
    const { port } = await start(0, 40);
    const silent = new WebSocket(wsUrl(port), { autoPong: false });
    const answering = new WebSocket(wsUrl(port));
    cleanups.push(() => answering.terminate());
    await Promise.all([once(silent, "open"), once(answering, "open")]);
    const [code] = await once(silent, "close");
    expect(code).toBe(1006);
    expect(answering.readyState).toBe(WebSocket.OPEN);
  });

  it("spends none of a socket's pong deadline asleep", async () => {
    const { port, power } = await start(0, 40);
    power("suspend");
    const silent = new WebSocket(wsUrl(port), { autoPong: false });
    cleanups.push(() => silent.terminate());
    await once(silent, "open");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(silent.readyState).toBe(WebSocket.OPEN);

    power("resume");
    const [code] = await once(silent, "close");
    expect(code).toBe(1006);
  });
});

describe("a reload mid-turn", () => {
  it("gets the turn so far, and nothing once the run has ended", async () => {
    let finish = (_outcome: TurnOutcome) => {};
    const runTurn: RunTurn = ({ onThinking, onToolStart, onToolEnd, onDelta }) => {
      onThinking({ active: true, text: "Looking" });
      onThinking({ active: false, text: " first." });
      onToolStart({ id: "a", name: "Read", detail: "src/index.ts" });
      onToolEnd("a", true);
      onToolStart({ id: "b", name: "Bash", detail: "pnpm test" });
      onDelta("Half ");
      onDelta("way");
      return new Promise((resolve) => (finish = resolve));
    };
    const store = openEventStore(dataDir);
    const server = await startServer({
      port: 0,
      token,
      dataDir,
      allowedOrigins: [appOrigin],
      store,
      probeEngine,
      runTurn,
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
    });
    const base = `http://127.0.0.1:${server.port}`;
    const bot = (await (await createBot(base)).json()) as Bot;
    // An attended turn needs someone watching.
    await subscribe(server.port, 0);
    await command(base, {
      type: "send-message",
      messageId: crypto.randomUUID(),
      roomId: bot.roomId,
      body: "hi",
    });
    const status = () => store.state().runs[0]?.status;
    await vi.waitFor(() => expect(status()).toBe("Running"));
    // Deltas are batched for a moment before they count as sent.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const reloaded = await subscribe(server.port, 0);
    expect(await reloaded.next()).toMatchObject({ type: "snapshot" });
    const live = [await reloaded.next(), await reloaded.next(), await reloaded.next()];
    const runId = (live[0] as { runId: string }).runId;
    expect([...live, await reloaded.next(), await reloaded.next()]).toEqual([
      { type: "thinking", runId, active: false, text: "Looking first." },
      { type: "tool-start", runId, toolId: "a", name: "Read", detail: "src/index.ts" },
      { type: "tool-end", runId, toolId: "a", failed: true },
      { type: "tool-start", runId, toolId: "b", name: "Bash", detail: "pnpm test" },
      { type: "delta", runId, text: "Half way" },
    ]);

    finish({ kind: "completed", text: "Half way" });
    await vi.waitFor(() => expect(status()).toBe("Completed"));
    const after = await subscribe(server.port, 0);
    expect(await after.next()).toMatchObject({ type: "snapshot" });
    await createBot(base);
    expect(await after.next()).toMatchObject({ type: "event" });
  });
});

describe("server info", () => {
  it("answers without the token or a protocol version, and keeps its ID across restarts", async () => {
    const first = await start();
    const response = await fetch(`${first.base}/.well-known/bee-bot`, {
      headers: { Origin: appOrigin },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin);
    const info = ServerInfo.parse(await response.json());
    expect(info).toEqual({
      environmentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      version: serverPackage.version,
      protocolVersion,
      capabilities: [],
    });
    await first.stop();

    const second = await start();
    const again = await fetch(`${second.base}/.well-known/bee-bot`);
    expect(ServerInfo.parse(await again.json()).environmentId).toBe(info.environmentId);
  });

  it("refuses a foreign Origin", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/.well-known/bee-bot`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });
});

describe("engine status", () => {
  const engine = (base: string) => http(base, "/engine", { headers: auth });
  const paused: EngineStatus = {
    cliFound: true,
    version: "2.1.318",
    auth: "unauthenticated",
    email: null,
    pauseReason: "auth_failed",
  };

  it("sits behind the owner token and the Origin check", async () => {
    const { base } = await start();
    expect((await http(base, "/engine")).status).toBe(401);
    const foreign = { ...auth, Origin: "https://evil.example" };
    expect((await http(base, "/engine", { headers: foreign })).status).toBe(403);
  });

  it("answers the sanitized status from a fresh probe", async () => {
    const { base } = await start();
    expect(await (await engine(base)).json()).toEqual(healthy);
    engineStatus = paused;
    expect(await (await engine(base)).json()).toEqual(paused);
  });

  it("refuses to pass on anything beyond the contract", async () => {
    const { base } = await start();
    engineStatus = { ...healthy, orgName: "Owner Org" } as EngineStatus;
    const response = await engine(base);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("Owner Org");
  });

  it("pauses ready Claude bots, clears engine pauses, and leaves the owner's alone", async () => {
    const { base, store } = await start();
    const ada = store.createBot({ name: "Ada", personality: "", engineAccountId: "claude" });
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "claude" });
    const fake = store.createBot({ name: "Fay", personality: "", engineAccountId: "fake" });
    store.setBotPause(ben.id, "owner");
    const reasons = () => store.state().bots.map(({ pauseReason }) => pauseReason);

    engineStatus = paused;
    await engine(base);
    expect(reasons()).toEqual(["auth_failed", "owner", null]);

    engineStatus = healthy;
    await engine(base);
    expect(reasons()).toEqual([null, "owner", null]);
    expect(store.state().bots.map(({ id }) => id)).toEqual([ada.id, ben.id, fake.id]);
  });

  it("changes an account's lane and lifts only its credential pauses", async () => {
    const { base, store } = await start();
    const pausedFor = (name: string, reason: PauseReason) => {
      const bot = store.createBot({ name, personality: "", engineAccountId: "claude" });
      store.setBotPause(bot.id, reason);
      return bot;
    };
    const ada = pausedFor("Ada", "credential_source");
    pausedFor("Ben", "auth_failed");
    pausedFor("Cy", "owner");
    pausedFor("Dee", "cli_version");
    pausedFor("Eve", "cli_missing");
    const reasons = () => store.state().bots.map(({ pauseReason }) => pauseReason);
    const setLane = (lane: EngineLane) =>
      command(base, { type: "set-account-lane", engineAccountId: "claude", lane });
    const lane = () => store.state().accounts.find(({ id }) => id === "claude")?.lane;
    expect(lane()).toBe("subscription");

    const before = store.bounds().latest;
    expect((await setLane("api_key")).status).toBe(200);
    expect(lane()).toBe("api_key");
    expect(store.getBot(ada.id)?.pauseReason).toBeNull();
    expect(reasons()).toEqual([null, null, "owner", "cli_version", "cli_missing"]);
    expect(store.eventsAfter(before).map(({ type }) => type)).toEqual([
      "account.changed",
      "bot.changed",
      "bot.changed",
    ]);

    const unchanged = store.bounds().latest;
    await setLane("api_key");
    expect(store.eventsAfter(unchanged)).toEqual([]);
    await engine(base);
    expect(probedLanes.at(-1)).toBe("api_key");
  });
});

describe("the notice", () => {
  it("stores the first acknowledgement only, with one event", async () => {
    const { base, store } = await start();
    expect(store.state().noticeAcknowledgedAt).toBeNull();
    await command(base, { type: "acknowledge-notice" });
    const first = store.state().noticeAcknowledgedAt;
    expect(first).not.toBeNull();
    await command(base, { type: "acknowledge-notice" });
    expect(store.state().noticeAcknowledgedAt).toBe(first);
    expect(store.eventsAfter(0).map(({ type }) => type)).toEqual(["notice.acknowledged"]);
  });
});

describe("a boxed bot's egress and lane", () => {
  it("validates, stores and audits the owner's hosts", async () => {
    const { base, store } = await start();
    const bot = Bot.parse(await (await createBot(base)).json());
    expect(bot).toMatchObject({ egressAnySite: true, egressHosts: [], access: "full" });
    const set = (hosts: string[]) =>
      command(base, { type: "set-bot-egress-hosts", botId: bot.id, anySite: false, hosts });
    for (const bad of ["*.com", "10.0.0.1", "https://pypi.org", "printer.local"]) {
      expect((await set(["pypi.org", bad])).status).toBe(400);
    }
    const saved = Bot.parse(await (await set(["PyPI.org.", "files.pythonhosted.org"])).json());
    expect(saved.egressAnySite).toBe(false);
    expect(saved.egressHosts).toEqual(["files.pythonhosted.org", "pypi.org"]);
    expect(store.egress.egressInput(bot.id)).toMatchObject({
      anySite: false,
      hosts: saved.egressHosts,
    });
    expect(Bot.parse(await (await set([])).json()).egressHosts).toEqual([]);
    expect(
      store.policy.auditPage({ unattended: false, limit: 10 }).entries.map((entry) => entry.status),
    ).toEqual(["egress_set", "egress_set"]);
  });

  it("opens every existing bot to any site with Full Access, keeping its list", async () => {
    const id = "6f1c2a4e-0000-4000-8000-000000000002";
    (
      await seedBefore(
        "open_defaults",
        `${oldBot(id)}
        UPDATE bots SET access = 'auto-edits', boundary = 'box';
        INSERT INTO bot_egress_hosts (bot_id, host, created_at) VALUES ('${id}', 'pypi.org', 'then');`,
      )
    ).close();
    const { store } = await start();
    expect(store.state().bots[0]).toMatchObject({
      access: "full",
      egressAnySite: true,
      egressHosts: ["pypi.org"],
    });
  });

  it("opts into the subscription only after the notice, and keeps the API key otherwise", async () => {
    const { base, store } = await start();
    const bot = Bot.parse(await (await createBot(base)).json());
    store.vaultStore.write(apiKeyName(bot.engineAccountId), Buffer.from("sealed"));
    expect(bot.unattendedLane).toBe("api_key");
    const choose = (lane: string) =>
      command(base, { type: "set-bot-unattended-lane", botId: bot.id, lane });
    expect((await choose("subscription")).status).toBe(409);
    expect(store.boxLane(bot.id)).toBe("api_key");
    await command(base, { type: "acknowledge-automated-access" });
    expect(store.boxLane(bot.id)).toBe("api_key");
    const chosen = Bot.parse(await (await choose("subscription")).json());
    expect(chosen.unattendedLane).toBe("subscription");
    expect(store.boxLane(bot.id)).toBe("subscription");
    const entry = store.policy.auditPage({ unattended: false, limit: 1 }).entries[0];
    expect(entry).toMatchObject({ status: "unattended_lane_set", initiator: "human" });
  });
});

describe("memory commands", () => {
  const uuid = "00000000-0000-4000-8000-000000000001";

  it("add, correct and forget, and answer not_found for what isn't there", async () => {
    const { base, store } = await start();
    const { id: botId } = (await (await createBot(base)).json()) as { id: string };
    const add = { type: "add-memory", botId, text: "  likes tea  ", memoryType: "user" };
    const first = (await (await command(base, add)).json()) as { id: string; text: string };
    expect(first.text).toBe("likes tea");

    const correct = { ...add, text: "likes coffee", supersedes: first.id };
    const second = (await (await command(base, correct)).json()) as { id: string };
    expect(store.state().memories.map(({ text }) => text)).toEqual(["likes coffee"]);

    const repeat = await command(base, correct);
    expect(repeat.status).toBe(404);
    expect(await repeat.json()).toEqual({ code: "not_found" });
    expect((await command(base, { ...add, botId: uuid })).status).toBe(404);

    const forget = { type: "forget-memory", memoryId: second.id };
    expect((await command(base, forget)).status).toBe(200);
    expect(store.state().memories).toEqual([]);
    expect((await command(base, forget)).status).toBe(404);
    const decide = { type: "decide-memory", memoryId: second.id, decision: "approve" };
    expect((await command(base, decide)).status).toBe(404);
  });

  it("refuse text past the limit", async () => {
    const { base } = await start();
    const { id: botId } = (await (await createBot(base)).json()) as { id: string };
    const add = { type: "add-memory", botId, text: "x".repeat(2001), memoryType: "user" };
    expect((await command(base, add)).status).toBe(400);
  });
});

describe("bot models", () => {
  it("defaults to sonnet, and an edit without a model keeps the bot's own", async () => {
    const { base, store } = await start();
    await createBot(base);
    await command(base, { type: "create-bot", name: "Ben", personality: "", model: "opus" });
    expect(store.state().bots.map(({ model }) => model)).toEqual(["sonnet", "opus"]);

    const ben = store.state().bots[1];
    const edit = { type: "update-bot", botId: ben?.id, name: "Ben", personality: "" };
    await command(base, edit);
    expect(store.state().bots[1]?.model).toBe("opus");
    await command(base, { ...edit, model: "haiku" });
    expect(store.state().bots[1]?.model).toBe("haiku");
  });
});

describe("bot engine settings", () => {
  async function bot(base: string, fields = {}) {
    const response = await command(base, {
      type: "create-bot",
      name: "Ada",
      personality: "",
      ...fields,
    });
    return ((await response.json()) as Bot).id;
  }
  const code = async (response: Response) => ((await response.json()) as { code: string }).code;

  it("gives a new bot the defaults, and updates one field at a time", async () => {
    const { base, store } = await start();
    const botId = await bot(base);
    expect(store.state().bots[0]).toMatchObject({
      model: "sonnet",
      effort: null,
      mode: "build",
      access: "full",
    });
    await command(base, { type: "set-bot-engine", botId, effort: "high" });
    await command(base, { type: "set-bot-engine", botId, mode: "plan" });
    await command(base, { type: "set-bot-engine", botId, access: "auto-edits" });
    expect(store.state().bots[0]).toMatchObject({
      model: "sonnet",
      effort: "high",
      mode: "plan",
      access: "auto-edits",
    });
    await command(base, { type: "set-bot-engine", botId, effort: null });
    expect(store.state().bots[0]?.effort).toBeNull();
  });

  it("refuses an unknown model, an unsupported effort and a provider change", async () => {
    const { base, store } = await start();
    const unknown = await command(base, {
      type: "create-bot",
      name: "Ada",
      personality: "",
      model: "gpt-9",
    });
    expect(unknown.status).toBe(400);
    expect(await code(unknown)).toBe("unknown_model");

    const botId = await bot(base);
    const refused = async (change: object, status: number, expected: string) => {
      const response = await command(base, { type: "set-bot-engine", botId, ...change });
      expect(response.status).toBe(status);
      expect(await code(response)).toBe(expected);
    };
    await refused({ model: "gpt-9" }, 400, "unknown_model");
    await refused({ model: "gpt-9", effort: "low" }, 400, "unknown_model");
    await refused({ effort: "turbo" }, 400, "bad_request");
    await refused({ engineAccountId: "fake" }, 409, "provider_locked");
    const edit = { type: "update-bot", botId, name: "Ada", personality: "" };
    expect(await code(await command(base, { ...edit, model: "gpt-9" }))).toBe("unknown_model");
    const moved = await command(base, { ...edit, engineAccountId: "fake" });
    expect(moved.status).toBe(409);
    expect(store.state().bots[0]?.model).toBe("sonnet");
  });

  it("serves the CLI's list once a probe finds it, and refuses by that list", async () => {
    const store = openEventStore(dataDir);
    const server = await startServer({
      port: 0,
      token,
      dataDir,
      allowedOrigins: [appOrigin],
      store,
      probeEngine,
      probeUsage: async (onModels) => {
        onModels([
          { id: "sonnet", label: "Sonnet 5.5", efforts: ["low"] },
          { id: "opus", label: "Opus 5.5", efforts: [] },
        ]);
        return { windows: [], unavailable: null };
      },
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
    });
    const base = `http://127.0.0.1:${server.port}`;
    const client = await subscribe(server.port, 0);
    await client.next();
    const botId = await bot(base);
    await command(base, { type: "set-bot-engine", botId, effort: "low" });
    server.refreshLimits();
    await vi.waitFor(async () => {
      const unsupported = await command(base, { type: "set-bot-engine", botId, effort: "max" });
      expect(await code(unsupported)).toBe("unsupported_effort");
    });
    const gone = await command(base, { type: "set-bot-engine", botId, model: "fable" });
    expect(await code(gone)).toBe("unknown_model");
    // Opus has no levels here, so the bot's level can't follow it there.
    await command(base, { type: "set-bot-engine", botId, model: "opus" });
    expect(store.state().bots[0]).toMatchObject({ model: "opus", effort: null });
  });

  it("keeps a saved model that left the catalog, and lets the bot still be edited", async () => {
    const { base, store } = await start();
    const botId = await bot(base);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    db.prepare("UPDATE bots SET model = 'claude-old' WHERE id = ?").run(botId);
    db.close();

    const edit = { type: "update-bot", botId, name: "Eve", personality: "", model: "claude-old" };
    expect((await command(base, edit)).status).toBe(200);
    expect(store.state().bots[0]).toMatchObject({ name: "Eve", model: "claude-old" });
    await command(base, { type: "set-bot-engine", botId, mode: "plan" });
    expect(store.state().bots[0]).toMatchObject({ model: "claude-old", mode: "plan" });
  });
});

describe("bot avatars", () => {
  it("picks a seed at creation, and keeps it when an edit doesn't send one", async () => {
    const { base, store } = await start();
    await createBot(base);
    await createBot(base);
    const [first, second] = store.state().bots;
    expect(first?.avatarSeed).not.toBe(second?.avatarSeed);

    const edit = { type: "update-bot", botId: first?.id, name: "Ada", personality: "" };
    await command(base, edit);
    expect(store.state().bots[0]?.avatarSeed).toBe(first?.avatarSeed);
    await command(base, { ...edit, avatarSeed: 42 });
    expect(store.state().bots[0]?.avatarSeed).toBe(42);
  });

  it("keeps the face the form previewed when creating", async () => {
    const { base, store } = await start();
    await command(base, { type: "create-bot", name: "Ada", personality: "", avatarSeed: 9 });
    expect(store.state().bots[0]?.avatarSeed).toBe(9);
  });

  it.each([-1, 1.5, 2 ** 32, "7"])("refuses the seed %j", async (avatarSeed) => {
    const { base, store } = await start();
    await createBot(base);
    const botId = store.state().bots[0]?.id;
    const edit = { type: "update-bot", botId, name: "Ada", personality: "", avatarSeed };
    expect((await command(base, edit)).status).toBe(400);
    expect(store.state().bots[0]?.avatarSeed).not.toBe(avatarSeed);
  });

  it("gives an existing bot a fixed seed from its ID", async () => {
    const id = "6f1c2a4e-0000-4000-8000-000000000001";
    (await seedBefore("bot_avatars", oldBot(id))).close();

    const second = await start();
    expect(second.store.state().bots[0]?.avatarSeed).toBe(seedFromId(id));
    await second.stop();
    const third = await start();
    expect(third.store.state().bots[0]?.avatarSeed).toBe(seedFromId(id));
    expect(seedFromId(id)).toBeGreaterThanOrEqual(0);
    expect(seedFromId(id)).toBeLessThanOrEqual(maxAvatarSeed);
  });
});

describe("storage failure", () => {
  it("answers 500 and keeps serving when a write fails", async () => {
    const store = openEventStore(dataDir);
    const server = await startServer({
      port: 0,
      token,
      dataDir,
      allowedOrigins: [],
      probeEngine,
      store: {
        ...store,
        createBot: () => {
          throw new Error("disk full");
        },
      },
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
    });
    const base = `http://127.0.0.1:${server.port}`;
    expect((await createBot(base)).status).toBe(500);
    expect((await http(base, "/health", { headers: auth })).status).toBe(200);
  });
});

describe("restart", () => {
  it("puts every account on the subscription lane, its stored events too", async () => {
    const db = await seedBefore(
      "account_lane",
      `INSERT INTO events (type, payload, created_at) VALUES ('account.changed',
        '{"type":"account.changed","account":{"id":"claude","label":"Claude","blockedUntil":null}}',
        'then');`,
    );
    // Stop before coordination, which clears every stored event.
    migrate(db, migrationIndex("coordination"));
    const { payload } = db.prepare("SELECT payload FROM events").get() as { payload: string };
    db.close();
    expect(JSON.parse(payload)).toMatchObject({ account: { id: "claude", lane: "subscription" } });

    const { store } = await start();
    expect(store.state().accounts.map(({ lane }) => lane)).toEqual([
      "subscription",
      "subscription",
      "subscription",
    ]);
  });

  it("clears events from before the event contract changed", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    NodeFS.mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    db.exec(`CREATE TABLE migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO migrations VALUES (1, 'create_events', 'then');
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO events (type, created_at) VALUES ('diagnostic', 'then');`);
    db.close();

    const { store, base } = await start();
    expect(store.eventsAfter(0)).toEqual([]);
    await createBot(base);
    expect(store.eventsAfter(0).map((event) => event.seq)).toEqual([2]);
  });

  it("reads rows from before bots had models and messages had tools", async () => {
    const db = await seedBefore(
      "tools_and_approvals",
      `${oldBot("ada")}
      INSERT INTO messages (id, room_id, author, body, event_seq, created_at)
        VALUES ('m', 'room-ada', 'human', 'hello', 2, 'then');
      INSERT INTO events (type, payload, created_at) VALUES ('bot.changed', '{}', 'then'),
        ('message.created', '{}', 'then');`,
    );
    db.close();

    const { store, port } = await start();
    expect(store.state().bots[0]?.model).toBe("sonnet");
    expect(store.state().messages[0]?.tools).toEqual([]);
    expect(store.eventsAfter(0).every(({ seq }) => seq > 2)).toBe(true);
    const client = await subscribe(port, 1);
    expect(await client.next()).toMatchObject({ type: "snapshot", state: { bots: [{}] } });
  });

  it("migrates a v4 database and backfills its messages without losing any", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"), {
      enableForeignKeyConstraints: false,
    });
    db.exec(`CREATE TABLE migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    const v4 = migrations.slice(
      0,
      migrations.findIndex(({ name }) => name === "bot_memory"),
    );
    expect(v4).toHaveLength(5);
    v4.forEach(({ name, sql }, index) => {
      db.exec(sql);
      db.prepare("INSERT INTO migrations VALUES (?, ?, 'then')").run(index + 1, name);
    });
    const bodies = ["the walrus sings", "a second line about the walrus", "unrelated"];
    db.exec(`INSERT INTO bots (id, name, personality, status, created_at)
        VALUES ('old', 'Ada', '', 'ready', 'then'), ('new', 'Ben', '', 'ready', 'then');
      INSERT INTO rooms VALUES ('room-old', 'old', 'then'), ('room-new', 'new', 'then');
      INSERT INTO scopes (id, room_id, bot_id, session_id, session_started)
        VALUES ('s-old', 'room-old', 'old', 'session', 1), ('s-new', 'room-new', 'new', NULL, 0);`);
    bodies.forEach((body, index) => {
      db.prepare(
        `INSERT INTO messages (id, room_id, author, body, event_seq, created_at, tools)
         VALUES (?, 'room-old', 'human', ?, ?, '2026-01-02T03:04:05.000Z', '["Read"]')`,
      ).run(`m${index}`, body, index + 1);
    });
    const message = {
      id: "m0",
      roomId: "room-old",
      author: "human",
      body: bodies[0],
      tools: ["Read"],
      createdAt: "2026-01-02T03:04:05.000Z",
    };
    db.prepare(
      "INSERT INTO events (type, payload, created_at) VALUES ('message.created', ?, 'then')",
    ).run(JSON.stringify({ type: "message.created", message }));
    db.close();

    const { store } = await start();

    const { messages, bots, memories } = store.state();
    expect(messages.map(({ body }) => body)).toEqual(bodies);
    expect(messages.every(({ tools }) => tools[0] === "Read")).toBe(true);
    expect(bots.map(({ id }) => id)).toEqual(["old", "new"]);
    expect(memories).toEqual([]);
    // Old events lack `workedMs`, so run_timing clears them and clients take a snapshot.
    expect(store.eventsAfter(0)).toEqual([]);
    expect(messages.every(({ workedMs }) => workedMs === null)).toBe(true);
    expect(store.searchMemory("old", "walrus")).toEqual([
      "[room | owner | 2026-01-02] the walrus sings",
      "[room | owner | 2026-01-02] a second line about the walrus",
    ]);
    expect(store.searchMemory("new", "walrus")).toEqual([]);

    store.sendMessage({ id: "m9", roomId: "room-old", body: "a fresh penguin", attended: false });
    expect(store.searchMemory("old", "penguin")).toHaveLength(1);

    const check = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    const tainted = check.prepare("SELECT id, tainted FROM scopes ORDER BY id").all();
    // Throws if the index disagrees with the messages table.
    check.exec("INSERT INTO messages_fts (messages_fts, rank) VALUES ('integrity-check', 1)");
    check.close();
    expect(tainted.map((row) => ({ ...row }))).toEqual([
      { id: "s-new", tainted: 0 },
      { id: "s-old", tainted: 1 },
    ]);
  });

  it("keeps events and does not reapply migrations", async () => {
    const before = await start();
    await createBot(before.base);
    await before.stop();

    const after = await start();
    expect(after.store.eventsAfter(0).map((event) => event.seq)).toEqual([1]);
    await createBot(after.base);
    expect(after.store.eventsAfter(0).map((event) => event.seq)).toEqual([1, 2]);
  });

  it("refuses a database migrated by a different version", async () => {
    const { stop } = await start();
    await stop();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    db.exec("UPDATE migrations SET name = 'from_the_future'");
    db.close();
    expect(() => openEventStore(dataDir)).toThrow(/unknown to this version/);
  });
});

describe("headless process", () => {
  const start = (bootstrap: object = {}) => {
    const daemon = spawnBeebotd({
      port: 0,
      token,
      dataDir,
      allowedOrigins: [],
      claudeCommand: ["beebot-no-such-cli"],
      ...bootstrap,
    });
    cleanups.push(daemon.kill);
    return daemon;
  };

  it(
    "boots on plain Node from a stdin bootstrap and stops on stdin EOF",
    async () => {
      const { child, listening, exited, output } = start();
      const port = await listening;
      expect(output()).not.toContain(token);

      const response = await http(`http://127.0.0.1:${port}`, "/health", { headers: auth });
      expect(response.status).toBe(200);

      child.stdin.end();
      expect(await exited).toBe(0);
    },
    daemonTestTimeoutMs,
  );

  it.runIf(process.platform === "win32")(
    "boots past a runtime directory it can't wipe, logging only the error code",
    async () => {
      const runtime = NodePath.join(dataDir, "runtime");
      NodeFS.mkdirSync(runtime);
      // Windows refuses to remove a directory that is another process's working directory.
      const holder = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          cwd: runtime,
          stdio: "ignore",
        },
      );
      cleanups.push(async () => {
        holder.kill();
        await once(holder, "exit");
      });
      await once(holder, "spawn");

      const { child, listening, exited, output } = start();
      await listening;
      expect(output()).toMatch(/could not clear runtime files: E[A-Z]+/);
      expect(output()).not.toContain(dataDir);

      child.stdin.end();
      expect(await exited).toBe(0);
    },
    daemonTestTimeoutMs,
  );

  it(
    "pauses Claude bots at startup when the probe fails, with the reason",
    async () => {
      const seeded = openEventStore(dataDir);
      seeded.createBot({ name: "Ada", personality: "", engineAccountId: "claude" });
      seeded.close();

      const { child, listening, exited } = start();
      const port = await listening;
      await vi.waitFor(
        async () => {
          const response = await http(`http://127.0.0.1:${port}`, "/state", { headers: auth });
          const { state } = (await response.json()) as { state: ChatState };
          expect(state.bots[0]).toMatchObject({ status: "paused", pauseReason: "cli_missing" });
        },
        { timeout: daemonTestTimeoutMs },
      );
      child.stdin.end();
      await exited;
    },
    daemonTestTimeoutMs,
  );

  it(
    "exits with a no-restart code on a bad bootstrap and keeps it out of stderr",
    async () => {
      const { exited, output } = spawnBeebotd(`{"token":"${token}"`);
      expect(await exited).toBe(78);
      expect(output()).not.toContain(token);
    },
    daemonTestTimeoutMs,
  );
});

describe("the Codex account", () => {
  const codexStatus = (pauseReason: EngineStatus["pauseReason"]): EngineStatus => ({
    ...healthy,
    auth: pauseReason === null ? "authenticated" : "unauthenticated",
    pauseReason,
  });

  async function boot(probeCodex: () => Promise<EngineStatus>, runTurn?: RunTurn) {
    const store = openEventStore(dataDir);
    const server = await startServer({
      port: 0,
      token,
      dataDir,
      allowedOrigins: [appOrigin],
      store,
      probeEngine,
      probeCodex,
      ...(runTurn && { runTurn }),
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
    });
    return { server, store, base: `http://127.0.0.1:${server.port}` };
  }

  const createCodexBot = async (base: string, name: string) =>
    (await command(base, {
      type: "create-bot",
      name,
      personality: "",
      engineAccountId: "codex",
      model: "gpt-5.6-luna",
    }).then((response) => response.json())) as Bot;

  it("probes only once a Codex bot exists", async () => {
    const probe = vi.fn(async () => codexStatus(null));
    const { server, base } = await boot(probe);
    await server.checkCodex();
    expect(probe).not.toHaveBeenCalled();
    await createCodexBot(base, "Ada");
    await server.checkCodex();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("pauses only Codex bots and clears them when the login is back", async () => {
    let status = codexStatus("auth_failed");
    const { server, store, base } = await boot(async () => status);
    const codex = await createCodexBot(base, "Ada");
    await command(base, { type: "create-bot", name: "Ben", personality: "" });
    await server.checkCodex();
    const reasons = () => store.state().bots.map(({ pauseReason }) => pauseReason);
    expect(store.getBot(codex.id)?.pauseReason).toBe("auth_failed");
    expect(reasons()).toContain(null);
    status = codexStatus(null);
    await server.checkCodex();
    expect(store.getBot(codex.id)?.pauseReason).toBeNull();
  });

  it("makes a second Codex bot wait, and holds the probe while a turn runs", async () => {
    const running: Array<(outcome: TurnOutcome) => void> = [];
    const runTurn: RunTurn = () => new Promise((resolve) => running.push(resolve));
    const probe = vi.fn(async () => codexStatus(null));
    const { server, store, base } = await boot(probe, runTurn);
    const ada = await createCodexBot(base, "Ada");
    const ben = await createCodexBot(base, "Ben");
    await subscribe(server.port, 0);
    await vi.waitFor(async () => {
      const pending = await command(base, {
        type: "send-message",
        messageId: crypto.randomUUID(),
        roomId: ada.roomId,
        body: "hi",
      });
      expect(pending.status).toBe(200);
      expect(running).toHaveLength(1);
    });
    for (const bot of [ben]) {
      await command(base, {
        type: "send-message",
        messageId: crypto.randomUUID(),
        roomId: bot.roomId,
        body: "hi",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(running).toHaveLength(1);
    await server.checkCodex();
    expect(probe).not.toHaveBeenCalled();
    running[0]?.({ kind: "completed", text: "done" });
    await vi.waitFor(() => expect(running).toHaveLength(2));
    running[1]?.({ kind: "completed", text: "done" });
    await vi.waitFor(() => expect(store.accountRunning("codex")).toBe(false));
  });
});

describe("project folders", () => {
  let project: string;

  const makeFolder = () => {
    const path = NodeFS.realpathSync.native(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-project-")),
    );
    cleanups.push(() => NodeFS.rmSync(path, { recursive: true, force: true }));
    return path;
  };

  beforeEach(() => {
    project = makeFolder();
  });

  const update = (base: string, botId: string, fields: Record<string, unknown>) =>
    command(base, { type: "update-bot", botId, name: "Ada", personality: "", ...fields });

  async function withBot() {
    const server = await start();
    const { id } = (await (await createBot(server.base)).json()) as Bot;
    return { ...server, id };
  }

  it("stores the real path on create, and none when none was given", async () => {
    const { base, store } = await start();
    const link = NodePath.join(makeFolder(), "shortcut");
    NodeFS.symlinkSync(project, link, "junction");
    const created = { type: "create-bot", name: "Ada", personality: "", projectPath: link };
    expect(await (await command(base, created)).json()).toMatchObject({ projectPath: project });
    expect(await (await createBot(base)).json()).toMatchObject({ projectPath: null });
    expect(store.state().bots.map(({ projectPath }) => projectPath)).toEqual([project, null]);
  });

  it("refuses a bad folder with its own code, on create and on update", async () => {
    const { base, store, id } = await withBot();
    const cases = [
      ["relative/path", "folder_not_absolute"],
      [NodePath.join(project, "gone"), "folder_not_found"],
      [NodeOS.homedir(), "folder_home"],
      [dataDir, "folder_bee_data"],
    ];
    for (const [projectPath, code] of cases) {
      const created = { type: "create-bot", name: "Ben", personality: "", projectPath };
      const refused = await command(base, created);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ code });
      const updated = await update(base, id, { projectPath });
      expect(updated.status).toBe(400);
      expect(await updated.json()).toEqual({ code });
    }
    expect(store.state().bots).toHaveLength(1);
    expect(store.getBot(id)?.projectPath).toBeNull();
  });

  it("keeps the folder when the field is missing, and clears it on null", async () => {
    const { base, store, id } = await withBot();
    await update(base, id, { projectPath: project });
    await update(base, id, { name: "Ada Two" });
    expect(store.getBot(id)).toMatchObject({ name: "Ada Two", projectPath: project });
    await update(base, id, { projectPath: null });
    expect(store.getBot(id)?.projectPath).toBeNull();
  });

  it("changing it clears grants and resets access in one event", async () => {
    const { base, store, id } = await withBot();
    store.grantTool(id, "Read");
    store.setBotEngine(id, { model: "sonnet", effort: null, mode: "build", access: "full" });
    const seq = store.bounds().latest;

    await update(base, id, { projectPath: project });

    expect(store.getBot(id)).toMatchObject({ access: "supervised", projectPath: project });
    expect(store.toolGranted(id, "Read")).toBe(false);
    expect(store.eventsAfter(seq)).toMatchObject([
      { type: "bot.changed", bot: { access: "supervised", projectPath: project } },
    ]);
  });

  it("re-saving the same folder resets nothing, however it is spelled", async () => {
    const { base, store, id } = await withBot();
    await update(base, id, { projectPath: project });
    store.grantTool(id, "Read");
    store.setBotEngine(id, { model: "sonnet", effort: null, mode: "build", access: "auto-edits" });

    await update(base, id, { projectPath: project });
    await update(base, id, { projectPath: `${project}${NodePath.sep}` });

    expect(store.getBot(id)).toMatchObject({ access: "auto-edits", projectPath: project });
    expect(store.toolGranted(id, "Read")).toBe(true);
  });

  it("a saved folder that has gone doesn't stop the owner editing the bot", async () => {
    const { base, store, id } = await withBot();
    await update(base, id, { projectPath: project });
    NodeFS.rmSync(project, { recursive: true });
    const response = await update(base, id, { name: "Renamed", projectPath: project });
    expect(response.status).toBe(200);
    expect(store.getBot(id)).toMatchObject({ name: "Renamed", projectPath: project });
  });

  it("a bot with no folder keeps its access and grants through an edit", async () => {
    const { base, store, id } = await withBot();
    store.grantTool(id, "Read");
    store.setBotEngine(id, { model: "sonnet", effort: null, mode: "build", access: "full" });
    await update(base, id, { name: "Renamed" });
    await update(base, id, { name: "Renamed", projectPath: null });
    expect(store.getBot(id)).toMatchObject({ access: "full", projectPath: null });
    expect(store.toolGranted(id, "Read")).toBe(true);
  });

  it("migrates a bot from before folders, with no folder and no old events", async () => {
    const id = "6f1c2a4e-0000-4000-8000-000000000002";
    const db = await seedBefore(
      "bot_project_path",
      `${oldBot(id)}
      INSERT INTO events (type, payload, created_at) VALUES ('bot.changed', '{}', 'then');`,
    );
    db.close();

    const { store, port } = await start();
    expect(store.state().bots[0]).toMatchObject({ id, projectPath: null });
    expect(store.eventsAfter(0)).toEqual([]);
    const client = await subscribe(port, 1);
    expect(await client.next()).toMatchObject({
      type: "snapshot",
      state: { bots: [{ projectPath: null }] },
    });
  });
});

describe("personality summary", () => {
  const personality =
    "You are a patient math tutor. Explain every step. Never give answers outright.";

  async function created(base: string, fields: Record<string, unknown> = {}) {
    const response = await command(base, {
      type: "create-bot",
      name: "Ada",
      personality,
      ...fields,
    });
    return (await response.json()) as Bot;
  }

  it("writes it after creation and keeps the personality as written", async () => {
    const summarize = vi.fn<Summarize>(async () => "A patient math tutor who explains each step.");
    const { base, store } = await start(0, undefined, summarize);
    const bot = await created(base);
    expect(bot.summary).toBeNull();
    await vi.waitFor(() =>
      expect(store.getBot(bot.id)?.summary).toBe("A patient math tutor who explains each step."),
    );
    expect(store.getBot(bot.id)?.personality).toBe(personality);
    expect(summarize).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Ada", personality }),
      expect.anything(),
    );
  });

  it("falls back to the personality's opening when no model can write one", async () => {
    const { base, store } = await start(0, undefined, async () => {
      throw new Error("no CLI");
    });
    const bot = await created(base);
    await vi.waitFor(() =>
      expect(store.getBot(bot.id)?.summary).toBe("You are a patient math tutor."),
    );
  });

  it("asks nothing for an empty personality", async () => {
    const summarize = vi.fn<Summarize>(async () => "unused");
    const { base, store } = await start(0, undefined, summarize);
    const empty = await created(base, { personality: "" });
    // Summaries are written in order, so once this one is in, the empty bot's turn has passed.
    const next = await created(base);
    await vi.waitFor(() => expect(store.getBot(next.id)?.summary).toBe("unused"));
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(store.getBot(empty.id)?.summary).toBeNull();
  });

  it("is rewritten only when the personality changes", async () => {
    const summarize = vi.fn<Summarize>(async ({ personality: text }) => `About: ${text}`);
    const { base, store } = await start(0, undefined, summarize);
    const bot = await created(base);
    await vi.waitFor(() => expect(store.getBot(bot.id)?.summary).toBe(`About: ${personality}`));
    const edit = (fields: Record<string, unknown>) =>
      command(base, { type: "update-bot", botId: bot.id, name: "Ada", personality, ...fields });

    await edit({ name: "Ada Two" });
    expect(store.getBot(bot.id)?.summary).toBe(`About: ${personality}`);
    await edit({ personality: "You are a terse code reviewer." });
    await vi.waitFor(() =>
      expect(store.getBot(bot.id)?.summary).toBe("About: You are a terse code reviewer."),
    );
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it("drops one written for a personality the owner has since changed", async () => {
    const pending = Promise.withResolvers<string>();
    const summarize = vi
      .fn<Summarize>()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementation(async () => "A terse code reviewer.");
    const { base, store } = await start(0, undefined, summarize);
    const bot = await created(base);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledTimes(1));
    await command(base, {
      type: "update-bot",
      botId: bot.id,
      name: "Ada",
      personality: "You are a terse code reviewer.",
    });
    pending.resolve("A patient math tutor.");
    await vi.waitFor(() => expect(store.getBot(bot.id)?.summary).toBe("A terse code reviewer."));
  });

  it("is written at boot for a bot that has none", async () => {
    const store = openEventStore(dataDir);
    const bot = store.createBot({ name: "Ada", personality, engineAccountId: "claude" });
    store.close();
    const { store: reopened } = await start(0, undefined, async () => "A patient math tutor.");
    await vi.waitFor(() => expect(reopened.getBot(bot.id)?.summary).toBe("A patient math tutor."));
  });
});
