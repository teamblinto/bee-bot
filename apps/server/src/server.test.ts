import * as NodeChildProcess from "node:child_process";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import {
  type ChatState,
  type EngineStatus,
  protocolVersion,
  ServerMessage,
} from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

import { writeMemoryFile } from "./memory.ts";
import { startServer } from "./server.ts";
import { migrations, openEventStore } from "./store.ts";

const token = "t".repeat(43);
const appOrigin = "http://127.0.0.1:5833";
const auth = { Authorization: `Bearer ${token}` };

const healthy: EngineStatus = {
  cliFound: true,
  versionOk: true,
  loggedIn: true,
  pauseReason: null,
  testedVersion: "2.1.318",
};

let dataDir: string;
let engineStatus: EngineStatus;
const probeEngine = async () => engineStatus;
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

async function start(port = 0) {
  const store = openEventStore(dataDir);
  const server = await startServer({
    port,
    token,
    dataDir,
    allowedOrigins: [appOrigin],
    store,
    probeEngine,
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
  return { store, stop, base: `http://127.0.0.1:${server.port}`, port: server.port };
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
    if (message.type === "pending-approvals") {
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
});

describe("engine status", () => {
  const engine = (base: string) => http(base, "/engine", { headers: auth });
  const paused: EngineStatus = {
    cliFound: true,
    versionOk: true,
    loggedIn: false,
    pauseReason: "auth_failed",
    testedVersion: "2.1.318",
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
    engineStatus = { ...healthy, email: "owner@example.com" } as EngineStatus;
    const response = await engine(base);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("owner@example.com");
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
    const seeded = openEventStore(dataDir);
    const { roomId } = seeded.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
    seeded.sendMessage({ id: "m", roomId, body: "hello", attended: false });
    seeded.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    db.exec(`DELETE FROM migrations WHERE name = 'run_timing';
      ALTER TABLE messages DROP COLUMN worked_ms;
      DELETE FROM migrations WHERE name = 'bot_memory';
      DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_delete;
      DROP TRIGGER messages_fts_update; DROP TABLE messages_fts; DROP TABLE memory_fts;
      DROP TABLE memory_items; ALTER TABLE scopes DROP COLUMN tainted;
      DELETE FROM migrations WHERE name = 'tools_and_approvals';
      DROP TABLE approvals; DROP TABLE bot_tool_grants; DROP TABLE settings;
      ALTER TABLE bots DROP COLUMN model; ALTER TABLE messages DROP COLUMN tools;
      ALTER TABLE audit_log DROP COLUMN tool;
      UPDATE events SET payload = json_remove(payload, '$.bot.model', '$.message.tools');`);
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
  const entry = NodePath.join(import.meta.dirname, "index.ts");

  const spawnServer = () => {
    const child = NodeChildProcess.spawn(process.execPath, [entry], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    cleanups.push(() => void child.kill());
    return child;
  };

  const freePort = async () => {
    const probe = NodeNet.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const { port } = probe.address() as NodeNet.AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    return port;
  };

  it("boots on plain Node from a stdin bootstrap and stops on stdin EOF", async () => {
    const port = await freePort();
    const child = spawnServer();
    const bootstrap = {
      port,
      token,
      dataDir,
      allowedOrigins: [],
      claudeCommand: ["beebot-no-such-cli"],
    };
    child.stdin.write(`${JSON.stringify(bootstrap)}\n`);

    const stderr: string[] = [];
    for await (const line of NodeReadline.createInterface({ input: child.stderr })) {
      stderr.push(line);
      if (line.includes("listening")) {
        break;
      }
    }
    expect(stderr.join("\n")).not.toContain(token);

    const response = await http(`http://127.0.0.1:${port}`, "/health", { headers: auth });
    expect(response.status).toBe(200);

    child.stdin.end();
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
  }, 20_000);

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

      const port = await freePort();
      const child = spawnServer();
      const bootstrap = {
        port,
        token,
        dataDir,
        allowedOrigins: [],
        claudeCommand: ["beebot-no-such-cli"],
      };
      child.stdin.write(`${JSON.stringify(bootstrap)}\n`);

      const stderr: string[] = [];
      for await (const line of NodeReadline.createInterface({ input: child.stderr })) {
        stderr.push(line);
        if (line.includes("listening")) {
          break;
        }
      }
      expect(stderr.join("\n")).toMatch(/could not clear runtime files: E[A-Z]+/);
      expect(stderr.join("\n")).not.toContain(dataDir);

      child.stdin.end();
      const [code] = await once(child, "exit");
      expect(code).toBe(0);
    },
    20_000,
  );

  it("pauses Claude bots at startup when the probe fails, with the reason", async () => {
    const seeded = openEventStore(dataDir);
    seeded.createBot({ name: "Ada", personality: "", engineAccountId: "claude" });
    seeded.close();

    const port = await freePort();
    const child = spawnServer();
    const bootstrap = {
      port,
      token,
      dataDir,
      allowedOrigins: [],
      claudeCommand: ["beebot-no-such-cli"],
    };
    child.stdin.write(`${JSON.stringify(bootstrap)}\n`);
    for await (const line of NodeReadline.createInterface({ input: child.stderr })) {
      if (line.includes("paused")) {
        break;
      }
    }
    await vi.waitFor(async () => {
      const response = await http(`http://127.0.0.1:${port}`, "/state", { headers: auth });
      const { state } = (await response.json()) as { state: ChatState };
      expect(state.bots[0]).toMatchObject({ status: "paused", pauseReason: "cli_missing" });
    });
    child.stdin.end();
    await once(child, "exit");
  }, 20_000);

  it("exits with a no-restart code on a bad bootstrap and keeps it out of stderr", async () => {
    const child = spawnServer();
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.write(`{"token":"${token}"\n`);
    const [code] = await once(child, "exit");
    expect(code).toBe(78);
    expect(stderr).not.toContain(token);
  }, 20_000);
});
