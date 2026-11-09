import { once } from "node:events";
import type { AddressInfo } from "node:net";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { Bot, DisplayTicket, HandoffServerMessage, protocolVersion } from "@beebot/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { WebSocket, WebSocketServer } from "ws";

import { displayView } from "./boxHost.ts";
import { createFakeBoxRuntime } from "./boxRuntime.ts";
import { type BoxHost, createBoxService } from "./boxSetup.ts";
import { createFakeBrowserRuntime } from "./browserRuntime.ts";
import { createDisplayTickets, serveDisplay } from "./display.ts";
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

async function start(
  display?: BoxHost["display"],
  control: BoxHost["control"] = async () => Promise.reject(new Error("no display")),
) {
  const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-display-"));
  const fromBox = new NodeStream.PassThrough();
  const toBox = new NodeStream.PassThrough();
  const box = NodeStream.Duplex.from({ readable: fromBox, writable: toBox });
  const boxes = createBoxService({
    machine: () => "beebot-dev",
    probe: async () => ({ found: true, running: true, boxdInstalled: true, imageBuilt: true }),
    initMachine: async () => {},
    startMachine: async () => {},
    stopMachine: async () => {},
    buildImage: async () => {},
    setUpBefore: () => true,
    markSetUp: () => {},
    startHost: async () => ({
      runtime: createFakeBoxRuntime(),
      prepare: async () => {},
      applyEgress: async () => {},
      sidecar: async () => Promise.reject(new Error("no sidecar")),
      display: display ?? (async () => ({ stream: box, exited: new Promise<null>(() => {}) })),
      control,
      stderr: () => "",
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
    browserRuntime: createFakeBrowserRuntime().runtime,
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
  const handoffUrl = `ws://127.0.0.1:${server.port}/browser?${new URLSearchParams({
    protocolVersion: String(protocolVersion),
    token,
    botId: bot.id,
  })}`;
  return { store, bot, command, ticket, url, handoffUrl, fromBox, toBox, box };
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

it("issues a ticket only for a bot whose control mode is its own computer", async () => {
  const { store, bot, command } = await start();
  const ask = { type: "display-ticket", botId: bot.id, mode: "view" };
  const refusal = await command(ask);
  expect(refusal.status).toBe(409);
  expect(await refusal.json()).toEqual({ code: "no_display" });
  expect((await command({ ...ask, botId: crypto.randomUUID() })).status).toBe(404);
  for (const control of ["browser", "host", "none"] as const) {
    store.policy.setBotControl(bot.id, control);
    expect((await command(ask)).status, control).toBe(409);
  }
  store.policy.setBotControl(bot.id, "computer");
  expect((await command(ask)).status).toBe(200);
});

it("opens /display only with a fresh ticket, an allowed origin and the current protocol", async () => {
  const { store, bot, ticket, url } = await start();
  store.policy.setBotControl(bot.id, "computer");
  expect(await upgradeStatus(url({}))).toBe(401);
  expect(await upgradeStatus(url({ token }))).toBe(401);
  expect(await upgradeStatus(url({ ticket: "guess" }))).toBe(401);
  // A refused origin doesn't spend the ticket.
  const used = await ticket();
  expect(await upgradeStatus(url({ ticket: used }), "https://evil.example")).toBe(403);
  expect(
    await upgradeStatus(
      url({ ticket: await ticket(), protocolVersion: String(protocolVersion - 1) }),
    ),
  ).toBe(426);
  const socket = new WebSocket(url({ ticket: used }), { origin: appOrigin });
  await once(socket, "open");
  socket.terminate();
  expect(await upgradeStatus(url({ ticket: used }))).toBe(401);
});

it("relays binary RFB bytes both ways and closes with the box stream", async () => {
  const { store, bot, ticket, url, fromBox, toBox, box } = await start();
  store.policy.setBotControl(bot.id, "computer");
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
  store.policy.setBotControl(bot.id, "computer");
  const socket = new WebSocket(url({ ticket: await ticket() }), { origin: appOrigin });
  const [code, reason] = await once(socket, "close");
  expect(code).toBe(4404);
  expect(String(reason)).toBe("display unavailable");
});

const never = new Promise<null>(() => {});
const idle = () =>
  NodeStream.Duplex.from({
    readable: new NodeStream.PassThrough(),
    writable: new NodeStream.PassThrough(),
  });

it("stops reading the viewer while the box is slow to take its bytes", async () => {
  const sockets = new WebSocketServer({ port: 0 });
  cleanups.push(() => new Promise<void>((resolve) => sockets.close(() => resolve())));
  const pending: Array<() => void> = [];
  const box = new NodeStream.Duplex({
    highWaterMark: 1,
    read() {},
    write(_chunk, _encoding, callback) {
      pending.push(callback);
    },
  });
  const served = new Promise<WebSocket>((resolve) =>
    sockets.on("connection", (client) => {
      void serveDisplay(client, async () => ({ stream: box, exited: never }));
      resolve(client);
    }),
  );
  const viewer = new WebSocket(`ws://127.0.0.1:${(sockets.address() as AddressInfo).port}`);
  cleanups.push(() => viewer.terminate());
  const client = await served;
  await once(viewer, "open");
  viewer.send(Buffer.from([1, 2, 3]));
  await vi.waitFor(() => expect(client.isPaused).toBe(true));
  for (const done of pending.splice(0)) {
    done();
  }
  await vi.waitFor(() => expect(client.isPaused).toBe(false));
});

async function takeControl(handoffUrl: string) {
  const handoff = new WebSocket(handoffUrl, { origin: appOrigin });
  const leases: HandoffServerMessage[] = [];
  handoff.on("message", (data) =>
    leases.push(HandoffServerMessage.parse(JSON.parse(String(data)))),
  );
  await once(handoff, "open");
  handoff.send(JSON.stringify({ type: "take" }));
  const held = await vi.waitFor(() => {
    const lease = leases.findLast(({ type }) => type === "lease");
    expect(lease).toMatchObject({ mine: true });
    return lease?.type === "lease" ? lease.leaseId : null;
  });
  return { handoff, leaseId: held ?? "" };
}

it("issues control only for the held lease, and ends the input server and its viewer with it", async () => {
  const servers: { leaseId: string; stream: NodeStream.Duplex }[] = [];
  const opened: Array<string | undefined> = [];
  const { store, bot, command, url, handoffUrl } = await start(
    async (_botId, lease) => {
      opened.push(lease);
      return { stream: idle(), exited: never };
    },
    async (_botId, leaseId) => {
      const stream = idle();
      servers.push({ leaseId, stream });
      return { stream, exited: never };
    },
  );
  store.policy.setBotControl(bot.id, "computer");
  const ask = (leaseId?: string) =>
    command({ type: "display-ticket", botId: bot.id, mode: "control", leaseId });
  expect((await ask()).status).toBe(403);
  expect((await ask(crypto.randomUUID())).status).toBe(403);
  expect(servers).toEqual([]);

  const { handoff, leaseId } = await takeControl(handoffUrl);
  expect(servers.map((server) => server.leaseId)).toEqual([leaseId]);
  expect((await ask(crypto.randomUUID())).status).toBe(403);
  const issued = await ask(leaseId);
  expect(issued.status).toBe(200);
  const viewer = new WebSocket(url({ ticket: DisplayTicket.parse(await issued.json()).ticket }), {
    origin: appOrigin,
  });
  await once(viewer, "open");
  await vi.waitFor(() => expect(opened).toEqual([leaseId]));

  const closed = once(viewer, "close");
  handoff.send(JSON.stringify({ type: "give" }));
  expect((await closed)[0]).toBe(4409);
  await vi.waitFor(() => expect(servers[0]?.stream.destroyed).toBe(true));
  expect((await ask(leaseId)).status).toBe(403);
  handoff.terminate();
});

it("stops the input server when the holder's socket goes", async () => {
  const servers: NodeStream.Duplex[] = [];
  const { store, bot, handoffUrl } = await start(undefined, async () => {
    const stream = idle();
    servers.push(stream);
    return { stream, exited: never };
  });
  store.policy.setBotControl(bot.id, "computer");
  const { handoff } = await takeControl(handoffUrl);
  expect(servers).toHaveLength(1);
  handoff.close();
  await vi.waitFor(() => expect(servers[0]?.destroyed).toBe(true));
});
