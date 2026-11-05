import * as NodeChildProcess from "node:child_process";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { protocolVersion, ServerMessage } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";

import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";

const token = "t".repeat(43);
const appOrigin = "http://127.0.0.1:5833";
const auth = { Authorization: `Bearer ${token}` };

let dataDir: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-server-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

async function start(port = 0) {
  const store = openEventStore(dataDir);
  const server = await startServer({ port, token, allowedOrigins: [appOrigin], store });
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

describe("storage failure", () => {
  it("answers 500 and keeps serving when a write fails", async () => {
    const store = openEventStore(dataDir);
    const server = await startServer({
      port: 0,
      token,
      allowedOrigins: [],
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
    child.stdin.write(`${JSON.stringify({ port, token, dataDir, allowedOrigins: [] })}\n`);

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
