import * as NodeChildProcess from "node:child_process";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type Bot,
  type EngineStatus,
  noRestartExitCodes,
  protocolVersion,
} from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

import { daemonTestTimeoutMs, spawnBeebotd } from "./fixtures/beebotd.ts";
import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";

const token = "t".repeat(43);
const healthy: EngineStatus = {
  cliFound: true,
  version: "2.1.318",
  auth: "authenticated",
  email: null,
  pauseReason: null,
};

let dataDir: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-servermode-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  await vi.waitFor(() => NodeFS.rmSync(dataDir, { recursive: true, force: true }));
});

const publicOrigin = "https://bee.example.test";

async function start(
  options: {
    socketPath?: string;
    runTurn?: () => never;
    serverMode?: boolean;
    publicOrigin?: string;
  } = {},
) {
  const store = openEventStore(dataDir);
  const server = await startServer({
    port: 0,
    token,
    dataDir,
    allowedOrigins: [],
    store,
    probeEngine: async () => healthy,
    serverMode: true,
    hostDriver: async () => {
      throw new Error("server mode never drives the host");
    },
    ...options,
  });
  cleanups.push(async () => {
    await server.close();
    store.close();
  });
  return { server, store, base: `http://127.0.0.1:${server.port}` };
}

const command = (base: string, body: unknown) =>
  fetch(`${base}/commands?protocolVersion=${protocolVersion}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe("server mode", () => {
  it("makes every new bot a box bot and refuses a move to the host", async () => {
    const { base } = await start();
    const bot = (await (
      await command(base, { type: "create-bot", name: "Ada", personality: "" })
    ).json()) as Bot;
    expect(bot.boundary).toBe("box");

    const moved = await command(base, {
      type: "set-bot-boundary",
      botId: bot.id,
      boundary: "host",
    });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toEqual({ code: "host_boundary_unavailable" });
  });

  it("refuses host control even when a host driver is offered", async () => {
    const { base } = await start();
    const bot = (await (
      await command(base, { type: "create-bot", name: "Ada", personality: "" })
    ).json()) as Bot;
    const control = await command(base, {
      type: "set-bot-control",
      botId: bot.id,
      control: "host",
      hostConsent: true,
    });
    expect(await control.json()).toEqual({ code: "host_control_unavailable" });
    const frame = await command(base, { type: "host-frame" });
    expect(frame.status).toBe(409);
    const setup = await command(base, { type: "open-setup-terminal", step: "claude-install" });
    expect(setup.status).toBe(409);
  });

  it("never starts a bot left on the host, even with the owner watching", async () => {
    const runTurn = vi.fn(() => {
      throw new Error("a host bot ran");
    });
    const { server, store, base } = await start({ runTurn });
    const bot = store.createBot({ name: "Old", personality: "", engineAccountId: "claude" });
    expect(bot.boundary).toBe("host");
    const watcher = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws?protocolVersion=${protocolVersion}&token=${token}`,
    );
    cleanups.push(() => watcher.terminate());
    await once(watcher, "open");
    watcher.send(JSON.stringify({ type: "subscribe", afterSeq: 0 }));
    await command(base, {
      type: "send-message",
      messageId: crypto.randomUUID(),
      roomId: bot.roomId,
      body: "hi",
    });
    await vi.waitFor(() =>
      expect(store.state().runs[0]).toMatchObject({ status: "Refused", reason: "box_unavailable" }),
    );
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("keeps a bot's login pause when the engine is checked", async () => {
    const { store, base } = await start();
    const bot = store.createBot({ name: "Ada", personality: "", engineAccountId: "claude" });
    store.pauseReadyBots("claude", "auth_failed");
    const engine = await fetch(`${base}/engine?protocolVersion=${protocolVersion}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(engine.status).toBe(200);
    expect(store.state().bots.find((b) => b.id === bot.id)?.pauseReason).toBe("auth_failed");
  });

  it("answers usage without reading this host's Claude folder", async () => {
    const { base } = await start();
    const usage = await fetch(`${base}/usage?days=7&protocolVersion=${protocolVersion}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await usage.json()).toEqual({ status: "unavailable" });
  });
});

type Reached = { status: number; headers: NodeHttp.IncomingHttpHeaders };

function request(options: NodeHttp.RequestOptions, body?: string) {
  return new Promise<Reached>((resolve, reject) => {
    NodeHttp.request(options, (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, headers: response.headers });
    })
      .on("error", reject)
      .end(body);
  });
}

const socketRequest = async (socketPath: string, path: string) =>
  (await request({ socketPath, path: `${path}?protocolVersion=${protocolVersion}` })).status;

describe.each([false, true])("a box's relay with serverMode %s", (serverMode) => {
  it("reaches only the engine routes, never the owner's", async () => {
    const { server } = await start({ serverMode });
    const relayed = (method: string, path: string, body?: string) =>
      request(
        {
          createConnection: () => server.relay(),
          method,
          path: `${path}?protocolVersion=${protocolVersion}`,
          headers: { Authorization: `Bearer ${token}`, Connection: "close" },
        },
        body,
      );
    const create = JSON.stringify({ type: "create-bot", name: "Mallory", personality: "" });
    expect((await relayed("POST", "/commands", create)).status).toBe(404);
    expect((await relayed("GET", "/state")).status).toBe(404);
    // The owner's token is no run's, so even the engine route turns it away.
    expect((await relayed("POST", "/mcp", "{}")).status).toBe(401);
  });
});

// Node on Windows listens on named pipes, not socket files.
describe.skipIf(process.platform === "win32")("the server mode socket", () => {
  it("listens only on a 0660 socket that trusts its caller as the owner", async () => {
    const socketPath = NodePath.join(dataDir, "beebotd.sock");
    const { server } = await start({ socketPath });
    expect(NodeFS.statSync(socketPath).mode & 0o777).toBe(0o660);
    expect(server.port).toBe(0);
    expect(await socketRequest(socketPath, "/health")).toBe(200);
  });

  it("replaces a dead socket file but never a live one", async () => {
    const socketPath = NodePath.join(dataDir, "beebotd.sock");
    const crashed = NodeChildProcess.spawn(process.execPath, [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(socketPath)}, () => console.log("up"))`,
    ]);
    await once(crashed.stdout, "data");
    crashed.kill("SIGKILL");
    await once(crashed, "exit");
    expect(NodeFS.existsSync(socketPath)).toBe(true);

    await start({ socketPath });
    expect(await socketRequest(socketPath, "/health")).toBe(200);
    await expect(start({ socketPath })).rejects.toThrow(/in use/);
  });

  it("refuses a socket in a folder other users can enter", async () => {
    const folder = NodePath.join(dataDir, "open");
    NodeFS.mkdirSync(folder, { mode: 0o755 });
    NodeFS.chmodSync(folder, 0o755);
    await expect(start({ socketPath: NodePath.join(folder, "beebotd.sock") })).rejects.toThrow(
      /closed to others/,
    );
  });

  it("serves a browser only from the public origin", async () => {
    const socketPath = NodePath.join(dataDir, "beebotd.sock");
    await start({ socketPath, publicOrigin });
    const path = `/health?protocolVersion=${protocolVersion}`;
    const own = await request({ socketPath, path, headers: { Origin: publicOrigin } });
    expect(own.status).toBe(200);
    expect(own.headers["access-control-allow-origin"]).toBe(publicOrigin);
    const hostile = await request({ socketPath, path, headers: { Origin: "https://evil.test" } });
    expect(hostile.status).toBe(403);
    expect(hostile.headers["access-control-allow-origin"]).toBeUndefined();

    const upgrade = (origin: string) =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(
          `ws+unix://${socketPath}:/ws?protocolVersion=${protocolVersion}`,
          {
            origin,
          },
        );
        socket.once("open", () => {
          socket.terminate();
          resolve(101);
        });
        socket.once("unexpected-response", (_, response) => {
          socket.terminate();
          resolve(response.statusCode ?? 0);
        });
        socket.once("error", reject);
      });
    expect(await upgrade("https://evil.test")).toBe(403);
    expect(await upgrade(publicOrigin)).toBe(101);
  });
});

it(
  "fails closed in server mode without an exact public origin",
  async () => {
    const daemon = spawnBeebotd("", {
      env: {
        BEEBOT_SERVER_MODE: "1",
        BEEBOT_DATA_DIR: dataDir,
        BEEBOT_SOCKET: NodePath.join(dataDir, "beebotd.sock"),
        BEEBOT_PUBLIC_ORIGIN: "https://bee.example.test/",
      },
    });
    cleanups.push(daemon.kill);
    expect(await daemon.exited).toBe(noRestartExitCodes.invalidBootstrap);
    expect(daemon.output()).toContain("BEEBOT_PUBLIC_ORIGIN");
    expect(NodeFS.existsSync(NodePath.join(dataDir, "beebot.db"))).toBe(false);
  },
  daemonTestTimeoutMs,
);

it(
  "fails closed in server mode without a vault key",
  async () => {
    const daemon = spawnBeebotd("", {
      env: {
        BEEBOT_SERVER_MODE: "1",
        BEEBOT_DATA_DIR: dataDir,
        BEEBOT_SOCKET: NodePath.join(dataDir, "beebotd.sock"),
        BEEBOT_PUBLIC_ORIGIN: "https://bee.example.test",
        CREDENTIALS_DIRECTORY: dataDir,
      },
    });
    cleanups.push(daemon.kill);
    expect(await daemon.exited).toBe(noRestartExitCodes.invalidBootstrap);
    const line = JSON.parse(daemon.output().trim().split("\n").at(-1) ?? "");
    expect(line).toMatchObject({ level: "error", msg: expect.stringContaining("vault-key") });
    expect(NodeFS.existsSync(NodePath.join(dataDir, "beebot.db"))).toBe(false);
  },
  daemonTestTimeoutMs,
);
