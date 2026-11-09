import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { Bot, DisplayTicket, protocolVersion } from "@beebot/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

import { displayView } from "./boxHost.ts";
import { type BoxAttach, createFakeBoxRuntime } from "./boxRuntime.ts";
import { createBoxService } from "./boxSetup.ts";
import { createDisplayTickets } from "./display.ts";
import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";

const token = "t".repeat(43);
const appOrigin = "http://127.0.0.1:5833";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

it("a ticket opens once, for its own bot, until it expires", () => {
  let now = 1000;
  const tickets = createDisplayTickets(() => now, 30_000);
  const first = tickets.issue("bot-1", "view");
  expect(first.ticket.length).toBeGreaterThanOrEqual(43);
  expect(first.expiresAt).toBe(31_000);
  expect(tickets.consume(first.ticket)).toEqual({
    botId: "bot-1",
    mode: "view",
    expiresAt: 31_000,
  });
  expect(tickets.consume(first.ticket)).toBeUndefined();
  expect(tickets.consume(null)).toBeUndefined();
  expect(tickets.consume("guess")).toBeUndefined();
  const late = tickets.issue("bot-2", "view");
  now += 30_000;
  expect(tickets.consume(late.ticket)).toBeUndefined();
  expect(tickets.issue("bot-1", "view").ticket).not.toBe(first.ticket);
});

it("counts an open display view as use, and passes bytes both ways", async () => {
  const touched: string[] = [];
  const fromBox = new NodeStream.PassThrough();
  const toBox = new NodeStream.PassThrough();
  const runtime = {
    ...createFakeBoxRuntime(),
    display: async () => ({
      stream: NodeStream.Duplex.from({ readable: fromBox, writable: toBox }),
      exited: new Promise<null>(() => {}),
    }),
  };
  const { stream } = await displayView(runtime, "bot-1", (botId) => touched.push(botId));
  fromBox.write("RFB 003.008\n");
  const [chunk] = await once(stream, "data");
  expect(String(chunk)).toBe("RFB 003.008\n");
  stream.write("client");
  const [written] = await once(toBox, "data");
  expect(String(written)).toBe("client");
  expect(touched).toEqual(["bot-1", "bot-1", "bot-1"]);
  stream.destroy();
});

async function start(display?: () => Promise<BoxAttach>) {
  const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-display-"));
  const fromBox = new NodeStream.PassThrough();
  const toBox = new NodeStream.PassThrough();
  const box = NodeStream.Duplex.from({ readable: fromBox, writable: toBox });
  const boxes = createBoxService({
    machine: () => "beebot-dev",
    probe: async () => ({ found: true, running: true, boxdInstalled: true, imageBuilt: true }),
    buildImage: async () => {},
    startHost: async () => ({
      runtime: createFakeBoxRuntime(),
      prepare: async () => {},
      applyEgress: async () => {},
      sidecar: async () => Promise.reject(new Error("no sidecar")),
      display: display ?? (async () => ({ stream: box, exited: new Promise<null>(() => {}) })),
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
    allowedOrigins: [appOrigin],
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
  const base = `http://127.0.0.1:${server.port}`;
  const command = async (body: unknown) =>
    fetch(`${base}/commands?protocolVersion=${protocolVersion}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const bot = Bot.parse(
    await (await command({ type: "create-bot", name: "Ada", personality: "" })).json(),
  );
  const ticket = async () =>
    DisplayTicket.parse(
      await (await command({ type: "display-ticket", botId: bot.id, mode: "view" })).json(),
    ).ticket;
  const url = (query: Record<string, string>) =>
    `ws://127.0.0.1:${server.port}/display?${new URLSearchParams({
      protocolVersion: String(protocolVersion),
      ...query,
    })}`;
  return { store, bot, command, ticket, url, fromBox, toBox, box };
}

function upgradeStatus(url: string, origin = appOrigin) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
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

it("issues a ticket only for a box bot", async () => {
  const { store, bot, command } = await start();
  const ask = { type: "display-ticket", botId: bot.id, mode: "view" };
  expect((await command(ask)).status).toBe(409);
  expect((await command({ ...ask, botId: crypto.randomUUID() })).status).toBe(404);
  store.policy.setBotBoundary(bot.id, "box");
  expect((await command(ask)).status).toBe(200);
});

it("opens /display only with a fresh ticket, an allowed origin and the current protocol", async () => {
  const { store, bot, ticket, url } = await start();
  store.policy.setBotBoundary(bot.id, "box");
  expect(await upgradeStatus(url({}))).toBe(401);
  expect(await upgradeStatus(url({ token }))).toBe(401);
  expect(await upgradeStatus(url({ ticket: "guess" }))).toBe(401);
  expect(await upgradeStatus(url({ ticket: await ticket() }), "https://evil.example")).toBe(403);
  expect(
    await upgradeStatus(
      url({ ticket: await ticket(), protocolVersion: String(protocolVersion - 1) }),
    ),
  ).toBe(426);
  const used = await ticket();
  const socket = new WebSocket(url({ ticket: used }), { origin: appOrigin });
  await once(socket, "open");
  socket.terminate();
  expect(await upgradeStatus(url({ ticket: used }))).toBe(401);
});

it("relays binary RFB bytes both ways and closes with the box stream", async () => {
  const { store, bot, ticket, url, fromBox, toBox, box } = await start();
  store.policy.setBotBoundary(bot.id, "box");
  const socket = new WebSocket(url({ ticket: await ticket() }), { origin: appOrigin });
  await once(socket, "open");
  fromBox.write(Buffer.from([0x52, 0x46, 0x42, 0x00, 0xff]));
  const [data, isBinary] = await once(socket, "message");
  expect(isBinary).toBe(true);
  expect([...(data as Buffer)]).toEqual([0x52, 0x46, 0x42, 0x00, 0xff]);
  socket.send(Buffer.from([1, 2, 3]));
  const [written] = await once(toBox, "data");
  expect([...(written as Buffer)]).toEqual([1, 2, 3]);
  fromBox.end();
  const [code] = await once(socket, "close");
  expect(code).toBe(1000);
  await vi.waitFor(() => expect(box.destroyed).toBe(true));
});

it("closes with 4404 when the box has no display", async () => {
  const { store, bot, ticket, url } = await start(async () => {
    throw new Error("no display in this box");
  });
  store.policy.setBotBoundary(bot.id, "box");
  const socket = new WebSocket(url({ ticket: await ticket() }), { origin: appOrigin });
  const [code, reason] = await once(socket, "close");
  expect(code).toBe(4404);
  expect(String(reason)).toBe("display unavailable");
});
