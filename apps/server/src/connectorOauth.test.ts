import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Connector, protocolVersion } from "@beebot/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";
import { z } from "zod";

import { createConnectorHub } from "./connectorHub.ts";
import { createConnectorOauth } from "./connectorOauth.ts";
import { guardedFetch, oauthName } from "./connectors.ts";
import { connectorsUrl, type BotLaunch, type RunTurn } from "./engine.ts";
import { startServer } from "./server.ts";
import { type EventStore, openEventStore } from "./store.ts";
import { openVault } from "./vaultStore.ts";

const ownerToken = "t".repeat(43);
let dataDir: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-oauth-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

async function readForm(request: NodeHttp.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

const json = (response: NodeHttp.ServerResponse, status: number, body: unknown) =>
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

// An MCP server and its authorization server on one loopback port: RFC 9728 and 8414 metadata,
// registration, PKCE, rotating refresh tokens and revocation, all by the book and all recorded.
async function fakeApp({ dcr = true } = {}) {
  const seen = {
    registrations: [] as Array<Record<string, unknown>>,
    authorizations: [] as URLSearchParams[],
    tokenRequests: [] as URLSearchParams[],
    revoked: [] as string[],
    mcpTokens: [] as string[],
    calls: [] as string[],
  };
  const config = { expiresIn: 3600, down: false };
  const codes = new Map<string, { challenge: string; resource: string | null }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  let issued = 0;
  const issue = () => {
    issued += 1;
    access.add(`at-${issued}-secret`);
    refresh.add(`rt-${issued}-secret`);
    return {
      access_token: `at-${issued}-secret`,
      refresh_token: `rt-${issued}-secret`,
      token_type: "Bearer",
      expires_in: config.expiresIn,
    };
  };
  const server = NodeHttp.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    if (config.down) {
      response.writeHead(503).end();
      return;
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    } else if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(response, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(dcr && { registration_endpoint: `${base}/register` }),
        revocation_endpoint: `${base}/revoke`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    } else if (url.pathname === "/register") {
      const body = JSON.parse(await readForm(request)) as Record<string, unknown>;
      seen.registrations.push(body);
      json(response, 201, { ...body, client_id: `client-${seen.registrations.length}` });
    } else if (url.pathname === "/authorize") {
      seen.authorizations.push(url.searchParams);
      const code = randomBytes(8).toString("hex");
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        resource: url.searchParams.get("resource"),
      });
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { Location: back.href }).end();
    } else if (url.pathname === "/token") {
      const form = new URLSearchParams(await readForm(request));
      seen.tokenRequests.push(form);
      if (form.get("grant_type") === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!code || code.challenge !== challenge) {
          json(response, 400, { error: "invalid_grant" });
          return;
        }
        json(response, 200, issue());
      } else if (refresh.delete(form.get("refresh_token") ?? "")) {
        json(response, 200, issue());
      } else {
        json(response, 400, { error: "invalid_grant" });
      }
    } else if (url.pathname === "/revoke") {
      const token = new URLSearchParams(await readForm(request)).get("token") ?? "";
      seen.revoked.push(token);
      access.delete(token);
      refresh.delete(token);
      response.writeHead(200).end();
    } else if (url.pathname === "/mcp") {
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      seen.mcpTokens.push(token);
      if (!access.has(token)) {
        response
          .writeHead(401, {
            "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
        return;
      }
      const mcp = new McpServer({ name: "fake", version: "1" });
      for (const name of ["search", "create"]) {
        mcp.registerTool(
          name,
          { description: `Does ${name}.`, inputSchema: { q: z.string().optional() } },
          async () => {
            seen.calls.push(name);
            return { content: [{ type: "text", text: `${name} ok` }] };
          },
        );
      }
      const transport = new StreamableHTTPServerTransport({});
      response.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    return closed;
  });
  const revokeAll = () => {
    access.clear();
    refresh.clear();
  };
  return { base, url: `${base}/mcp`, seen, config, revokeAll };
}

async function rpc(url: string, token: string, method: string, params: object) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const body = text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? "null");
  return JSON.parse(body).result;
}

type Bot = { listed: string[]; call: (name: string) => Promise<string>; launch: BotLaunch };
type Turn = (bot: Bot) => Promise<void>;

const vaultKey = randomBytes(32).toString("base64");

// beebotd with a fake engine that does whatever the next queued turn says, and a watching owner.
async function startBeebotd() {
  const store: EventStore = openEventStore(dataDir);
  const turns: Turn[] = [];
  const results: string[] = [];
  const launches: BotLaunch[] = [];
  const runTurn: RunTurn = async ({ launch, permissions, onDelivered }) => {
    onDelivered();
    launches.push(launch);
    const work = turns.shift();
    if (work) {
      const url = connectorsUrl(permissions.url);
      const list = await rpc(url, permissions.token, "tools/list", {});
      const call = async (name: string) => {
        const result = await rpc(url, permissions.token, "tools/call", { name, arguments: {} });
        const text = result.content[0]?.text ?? "";
        results.push(text);
        return text;
      };
      const listed = list.tools.map(({ name }: { name: string }) => name).sort();
      await work({ listed, call, launch });
    }
    return { kind: "completed", text: "done" };
  };
  const vault = openVault(store.vaultStore, { status: "ready", key: vaultKey });
  const server = await startServer({
    port: 0,
    token: ownerToken,
    dataDir,
    allowedOrigins: [],
    store,
    vault,
    runTurn,
    probeEngine: async () => ({
      cliFound: true,
      version: "2.1.318",
      auth: "authenticated" as const,
      email: null,
      pauseReason: null,
    }),
  });
  const base = `http://127.0.0.1:${server.port}`;
  const params = new URLSearchParams({
    protocolVersion: String(protocolVersion),
    token: ownerToken,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?${params}`);
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "subscribe", afterSeq: 0 }));
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    socket.terminate();
    await server.close();
    store.close();
  };
  cleanups.push(stop);
  const command = async (body: object) => {
    const response = await fetch(`${base}/commands?protocolVersion=${protocolVersion}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  // A message from the owner, with what the bot does on that turn.
  const turn = async (botId: string, work: Turn) => {
    let done = false;
    turns.push(async (bot) => {
      await work(bot);
      done = true;
    });
    const roomId = store.getBot(botId)?.roomId ?? "";
    const sent = await command({
      type: "send-message",
      messageId: crypto.randomUUID(),
      roomId,
      body: "go",
    });
    expect(sent.status).toBe(200);
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 10_000 });
  };
  return { store, vault, base, command, turn, results, launches, stop };
}

type Beebotd = Awaited<ReturnType<typeof startBeebotd>>;

// What the owner's browser does: follow the sign-in page back to beebotd's callback.
async function browse(authorizationUrl: string) {
  const login = await fetch(authorizationUrl, { redirect: "manual" });
  const callback = login.headers.get("location") ?? "";
  const page = await fetch(callback);
  return { callback, status: page.status, text: await page.text() };
}

async function addAndSignIn({ command, store }: Beebotd, url: string) {
  const added = await command({ type: "add-connector", name: "App", url });
  const { id } = Connector.parse(added.body);
  await vi.waitFor(() => expect(store.connectors.getConnector(id)?.status).toBe("needs_sign_in"));
  const started = await command({ type: "start-connector-oauth", connectorId: id });
  const authorizationUrl = z.object({ authorizationUrl: z.string() }).parse(started.body);
  const page = await browse(authorizationUrl.authorizationUrl);
  await vi.waitFor(() => expect(store.connectors.getConnector(id)?.status).toBe("ok"));
  return { id, page, ...authorizationUrl };
}

async function grantTo(beebotd: Beebotd, id: string) {
  const bot = beebotd.store.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
  const connector = beebotd.store.connectors.getConnector(id);
  await beebotd.command({
    type: "review-connector",
    connectorId: id,
    toolsHash: connector?.toolsHash,
    readOnly: ["search"],
  });
  await beebotd.command({
    type: "set-bot-connector",
    botId: bot.id,
    connectorId: id,
    on: true,
    tools: "*",
    allowWrites: [],
  });
  return bot;
}

const tokenPattern = /(?:at|rt)-\d+-secret/;

async function expectNoTokens(beebotd: Beebotd, errors: { mock: { calls: unknown[] } }) {
  const state = await fetch(`${beebotd.base}/state?protocolVersion=${protocolVersion}`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  }).then((response) => response.text());
  expect(state).not.toMatch(tokenPattern);
  expect(JSON.stringify(beebotd.store.eventsAfter(0))).not.toMatch(tokenPattern);
  expect(JSON.stringify(beebotd.launches)).not.toMatch(tokenPattern);
  expect(JSON.stringify(beebotd.results)).not.toMatch(tokenPattern);
  expect(JSON.stringify(errors.mock.calls)).not.toMatch(tokenPattern);
}

describe("signing in", () => {
  it("registers, sends PKCE S256 and the resource, and takes a state once and never late", async () => {
    const errors = vi.spyOn(console, "error");
    const app = await fakeApp();
    const beebotd = await startBeebotd();
    const { id, page, authorizationUrl } = await addAndSignIn(beebotd, app.url);

    const callback = `${beebotd.base}/connectors/oauth/callback`;
    expect(app.seen.registrations).toEqual([
      expect.objectContaining({ redirect_uris: [callback], token_endpoint_auth_method: "none" }),
    ]);
    const asked = app.seen.authorizations[0];
    expect(asked?.get("code_challenge_method")).toBe("S256");
    expect(asked?.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(asked?.get("resource")).toBe(app.url);
    expect(asked?.get("redirect_uri")).toBe(callback);
    const exchange = app.seen.tokenRequests[0];
    expect(exchange?.get("code_verifier")).toBeTruthy();
    expect(exchange?.get("resource")).toBe(app.url);
    expect(page).toMatchObject({ status: 200, text: expect.stringContaining("close this tab") });
    expect(beebotd.store.connectors.getConnector(id)).toMatchObject({
      auth: "oauth",
      authStatus: "signed_in",
    });
    expect(app.seen.mcpTokens.at(-1)).toBe("at-1-secret");

    // The same state again is refused, and a state past its ten minutes too.
    expect((await fetch(page.callback)).status).toBe(400);
    const again = await beebotd.command({ type: "start-connector-oauth", connectorId: id });
    const login = await fetch(String(again.body.authorizationUrl), { redirect: "manual" });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    expect((await fetch(login.headers.get("location") ?? "")).status).toBe(400);
    vi.mocked(Date.now).mockRestore();
    expect(app.seen.tokenRequests).toHaveLength(1);
    expect(authorizationUrl).not.toMatch(tokenPattern);
    await expectNoTokens(beebotd, errors);
  });

  it("asks the owner for a client ID when the server can't register one", async () => {
    const app = await fakeApp({ dcr: false });
    const beebotd = await startBeebotd();
    const added = await beebotd.command({ type: "add-connector", name: "App", url: app.url });
    const { id } = Connector.parse(added.body);
    const started = await beebotd.command({ type: "start-connector-oauth", connectorId: id });
    expect(started.body).toEqual({ needsClient: true });
    expect(beebotd.store.connectors.getConnector(id)?.status).toBe("needs_client");

    await beebotd.command({ type: "set-connector-secret", connectorId: id, clientId: "pasted" });
    const retried = await beebotd.command({ type: "start-connector-oauth", connectorId: id });
    const url = new URL(String(retried.body.authorizationUrl));
    expect(url.searchParams.get("client_id")).toBe("pasted");
    await browse(url.href);
    await vi.waitFor(() => expect(beebotd.store.connectors.getConnector(id)?.status).toBe("ok"));
  });
});

describe("tokens", () => {
  it("refreshes a minute early, once at a time, saves the rotated token, and survives a restart", async () => {
    const app = await fakeApp();
    app.config.expiresIn = 30;
    const first = await startBeebotd();
    const { id } = await addAndSignIn(first, app.url);
    // at-1 ran out within the minute, so the first request already went with a refreshed token.
    expect(app.seen.mcpTokens).not.toContain("at-1-secret");
    expect(app.seen.tokenRequests[1]?.get("refresh_token")).toBe("rt-1-secret");

    const connector = first.store.connectors.getConnector(id);
    const oauth = createConnectorOauth({
      connectors: first.store.connectors,
      vault: first.vault,
      fetchFn: guardedFetch(),
    });
    const refreshes = app.seen.tokenRequests.length;
    const [one, two] = await Promise.all([
      oauth.accessToken(connector as Connector),
      oauth.accessToken(connector as Connector),
    ]);
    expect(one).toBe(two);
    expect(app.seen.tokenRequests).toHaveLength(refreshes + 1);
    const saved = await first.vault.get(oauthName(id));
    const rotated = JSON.parse(saved ?? "{}").tokens.refresh_token;
    expect(rotated).not.toBe("rt-1-secret");

    app.config.expiresIn = 3600;
    await first.stop();
    const second = await startBeebotd();
    expect(await second.command({ type: "refresh-connector", connectorId: id })).toMatchObject({
      status: 200,
      body: { status: "ok" },
    });
    // The refresh token saved before the restart was the one used after it.
    expect(app.seen.tokenRequests.at(-1)?.get("refresh_token")).toBe(rotated);
    expect(app.seen.authorizations).toHaveLength(1);
  });

  it("drops a revoked sign-in to needs_sign_in and a stand-in tool, tells the room once, and never retries", async () => {
    const errors = vi.spyOn(console, "error");
    const app = await fakeApp();
    const beebotd = await startBeebotd();
    const { id } = await addAndSignIn(beebotd, app.url);
    const bot = await grantTo(beebotd, id);

    app.revokeAll();
    let first: string[] = [];
    await beebotd.turn(bot.id, async ({ listed, call }) => {
      first = [listed.join(","), await call("app_search"), await call("app_search")];
    });
    expect(first[0]).toBe("app_create,app_search");
    expect(beebotd.store.connectors.getConnector(id)?.status).toBe("needs_sign_in");
    const requests = app.seen.mcpTokens.length;

    let second: string[] = [];
    await beebotd.turn(bot.id, async ({ listed, call }) => {
      second = [listed.join(","), await call("app_unavailable"), await call("app_search")];
    });
    expect(second[0]).toBe("app_unavailable");
    expect(second[1]).toContain("ask them to fix it");
    expect(second[2]).toContain("connector_unavailable");
    expect(app.seen.mcpTokens).toHaveLength(requests);
    expect(JSON.stringify([first, second])).not.toContain("authorize");

    const notices = beebotd.store
      .recentMessages(bot.roomId, 50)
      .filter(({ body }) => body.startsWith("Reconnect App"));
    expect(notices).toHaveLength(2);
    await expectNoTokens(beebotd, errors);
  });

  it("revokes on disconnect, and a new URL needs a new sign-in", async () => {
    const app = await fakeApp();
    const beebotd = await startBeebotd();
    const { id } = await addAndSignIn(beebotd, app.url);
    await beebotd.command({ type: "disconnect-connector", connectorId: id });
    expect(app.seen.revoked).toEqual(["rt-1-secret", "at-1-secret"]);
    expect(await beebotd.vault.get(oauthName(id))).toBeUndefined();

    const other = await fakeApp();
    await addAndSignIn(beebotd, app.url).then(({ id: again }) =>
      beebotd.command({ type: "update-connector", connectorId: again, url: other.url }),
    );
    await vi.waitFor(() =>
      expect(
        beebotd.store.connectors.listConnectors().find(({ url }) => url === other.url)?.status,
      ).toBe("needs_sign_in"),
    );
    expect(other.seen.mcpTokens.every((token) => token === "")).toBe(true);
  });
});

// A hub against a server that answers every request with `answer`, and how many it got.
async function hubAgainst(answer: (response: NodeHttp.ServerResponse, body: string) => void) {
  const server = NodeHttp.createServer(async (request, response) => {
    server.emit("counted");
    answer(response, await readForm(request));
  });
  let requests = 0;
  server.on("counted", () => {
    requests += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  const store = openEventStore(dataDir);
  cleanups.push(() => store.close());
  const clock = { now: 1_000_000 };
  const hub = createConnectorHub({
    connectors: store.connectors,
    policy: store.policy,
    vault: openVault(store.vaultStore, { status: "ready", key: vaultKey }),
    now: () => clock.now,
  });
  cleanups.push(() => hub.close());
  const added = store.connectors.addConnector({
    name: "Remote",
    transport: "http",
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    command: null,
    args: [],
    auth: "none",
    ownerBotId: null,
    headerKeys: [],
    envKeys: [],
    status: "unreachable",
    lastError: null,
  });
  const { id } = Connector.parse(added);
  return { store, hub, clock, id, requests: () => requests };
}

describe("failures", () => {
  it("waits 30 s after a failure, doubling to 5 min, and fails fast meanwhile", async () => {
    const { store, hub, clock, id, requests } = await hubAgainst((response) =>
      response.writeHead(503).end(),
    );
    await hub.refresh(id);
    expect(store.connectors.getConnector(id)?.status).toBe("unreachable");
    for (const seconds of [30, 60, 120, 240, 300, 300]) {
      const before = requests();
      clock.now += seconds * 1000 - 1;
      await hub.refresh(id);
      expect(requests()).toBe(before);
      clock.now += 1;
      await hub.refresh(id);
      expect(requests()).toBeGreaterThan(before);
    }
  });

  it("takes a JSON-RPC -32302 sent with HTTP 200 as a sign-in, and doesn't retry it", async () => {
    const { store, hub, clock, id, requests } = await hubAgainst((response, body) => {
      const { id: rpcId } = JSON.parse(body || "{}") as { id?: number };
      const error = { code: -32302, message: "Sign in first." };
      json(response, 200, { jsonrpc: "2.0", id: rpcId ?? null, error });
    });
    await hub.refresh(id);
    expect(store.connectors.getConnector(id)?.status).toBe("needs_sign_in");
    const bot = store.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
    store.connectors.setBotConnector(bot.id, id, true, "*", []);
    const before = requests();
    clock.now += 60 * 60_000;
    expect(await hub.toolsFor(bot.id)).toEqual([
      expect.objectContaining({ name: "remote_unavailable" }),
    ]);
    expect(requests()).toBe(before);
  });
});

describe("approvals", () => {
  it("waits on a write, runs it once on approval, and stops asking after Always allow", async () => {
    const app = await fakeApp();
    const beebotd = await startBeebotd();
    const { id } = await addAndSignIn(beebotd, app.url);
    const bot = await grantTo(beebotd, id);
    const { continuations } = beebotd.store;

    let asked = "";
    await beebotd.turn(bot.id, async ({ call }) => {
      asked = await call("app_create");
    });
    expect(asked).toMatch(/^waiting: /);
    const [card] = continuations.waitingContinuations();
    expect(card).toMatchObject({ tool: "mcp__connectors__app_create", shown: "App: create\n{}" });
    const decide = (decision: string) =>
      beebotd.command({
        type: "decide-continuation",
        continuationId: card?.id,
        digest: card?.digest,
        decision,
      });
    expect(await decide("approve")).toMatchObject({ status: 200 });
    await vi.waitFor(() => expect(app.seen.calls).toEqual(["create"]));
    expect(await decide("approve")).toMatchObject({ status: 409 });
    expect(app.seen.calls).toEqual(["create"]);

    await beebotd.turn(bot.id, async ({ call }) => {
      asked = await call("app_create");
    });
    const [next] = continuations.waitingContinuations();
    expect(
      await beebotd.command({
        type: "decide-continuation",
        continuationId: next?.id,
        digest: next?.digest,
        decision: "always",
      }),
    ).toMatchObject({ status: 200 });
    await vi.waitFor(() => expect(app.seen.calls).toEqual(["create", "create"]));
    expect(beebotd.store.connectors.getConnector(id)?.grants[0]?.allowWrites).toEqual(["create"]);

    await beebotd.turn(bot.id, async ({ call }) => {
      asked = await call("app_create");
    });
    expect(asked).toContain("create ok");
    expect(app.seen.calls).toEqual(["create", "create", "create"]);
    expect(continuations.waitingContinuations()).toEqual([]);
  });
});
