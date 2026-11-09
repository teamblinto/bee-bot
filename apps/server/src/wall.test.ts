import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { Bot, protocolVersion, ServerMessage } from "@beebot/contracts";
import { afterEach, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";

import { createFakeBoxRuntime } from "./boxRuntime.ts";
import { createBoxService } from "./boxSetup.ts";
import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";

const token = "t".repeat(43);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function start() {
  const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-wall-"));
  const captured: string[] = [];
  const boxes = createBoxService({
    machine: () => "beebot-dev",
    probe: async () => ({ found: true, running: true, boxdInstalled: true, imageBuilt: true }),
    buildImage: async () => {},
    startHost: async () => ({
      runtime: {
        ...createFakeBoxRuntime(),
        capture: async (botId) => {
          captured.push(botId);
          return Buffer.from("jpeg");
        },
      },
      prepare: async () => {},
      applyEgress: async () => {},
      sidecar: async () => Promise.reject(new Error("no sidecar")),
      display: async () => Promise.reject(new Error("no display")),
      control: async () => Promise.reject(new Error("no display")),
      closed: new Promise(() => {}),
      close: async () => {},
    }),
  });
  await boxes.refresh();
  const store = openEventStore(dataDir);
  const server = await startServer({
    port: 0,
    token,
    dataDir,
    allowedOrigins: [],
    store,
    probeEngine: async () => ({
      cliFound: true,
      version: "2.1.318",
      auth: "authenticated",
      email: null,
      pauseReason: null,
    }),
    boxes,
  });
  cleanups.push(async () => {
    await server.close();
    store.close();
    NodeFS.rmSync(dataDir, { recursive: true, force: true });
  });
  const response = await fetch(
    `http://127.0.0.1:${server.port}/commands?protocolVersion=${protocolVersion}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: "create-bot", name: "Ada", personality: "" }),
    },
  );
  const bot = Bot.parse(await response.json());
  async function client() {
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws?${new URLSearchParams({
        protocolVersion: String(protocolVersion),
        token,
      })}`,
    );
    cleanups.push(() => socket.terminate());
    const received: ServerMessage[] = [];
    socket.on("message", (data) => received.push(ServerMessage.parse(JSON.parse(String(data)))));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "subscribe", afterSeq: 0 }));
    const wall = (watching: boolean) => socket.send(JSON.stringify({ type: "wall", watching }));
    const thumbnails = () => received.filter(({ type }) => type === "thumbnail");
    return { received, wall, thumbnails };
  }
  return { store, bot, client, captured };
}

it("sends thumbnails only to clients watching the wall, and captures only while one does", async () => {
  const { store, bot, client, captured } = await start();
  store.boxes.setBox(bot.id, "running");
  const watcher = await client();
  const other = await client();
  watcher.wall(true);
  await expectSoon(() => watcher.thumbnails().length > 0);
  expect(watcher.thumbnails()[0]).toMatchObject({
    type: "thumbnail",
    botId: bot.id,
    mime: "image/jpeg",
    data: Buffer.from("jpeg").toString("base64"),
  });
  expect(watcher.received).toContainEqual({ type: "wall", held: [] });
  expect(other.received.some(({ type }) => type === "thumbnail" || type === "wall")).toBe(false);

  // A late watcher gets the latest frame at once, without a new capture.
  const late = await client();
  const before = captured.length;
  late.wall(true);
  await expectSoon(() => late.thumbnails().length > 0);
  expect(captured.length).toBe(before);
  watcher.wall(false);
  late.wall(false);
});

async function expectSoon(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) {
    await sleep(20);
  }
  expect(check()).toBe(true);
}
