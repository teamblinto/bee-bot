import { randomBytes } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Connector, protocolVersion } from "@beebot/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  capMiddle,
  checkUrl,
  exposedName,
  guardedFetch,
  headersProblem,
  holdsSecret,
  parseMcpServers,
  prepareTools,
  redact,
  urlProblem,
} from "./connectors.ts";
import { connectorsUrl, type BotLaunch, type RunTurn } from "./engine.ts";
import { startServer } from "./server.ts";
import { type EventStore, openEventStore } from "./store.ts";
import { openVault } from "./vaultStore.ts";

const listed = (name: string, extra: object = {}) => ({
  name,
  inputSchema: { type: "object" },
  ...extra,
});

describe("tool names", () => {
  it("fits an engine's 64 characters and keeps long names apart", () => {
    expect(exposedName("notion", "search")).toBe("notion_search");
    expect(exposedName("gh", "repo.list/all")).toBe("gh_repo_list_all");
    const long = "a".repeat(80);
    const one = exposedName("linear", `${long}1`);
    const two = exposedName("linear", `${long}2`);
    expect(`mcp__connectors__${one}`).toHaveLength(64);
    expect(one).not.toBe(two);
    expect(one).toBe(exposedName("linear", `${long}1`));
  });

  it("keeps out a schema over 32 KB and both tools whose names collide", () => {
    const huge = { type: "object", description: "x".repeat(33 * 1024) };
    const tools = prepareTools("app", [
      listed("ok"),
      listed("big", { inputSchema: huge }),
      listed("a.b"),
      listed("a/b"),
    ]);
    expect(tools.map(({ name, excluded }) => [name, excluded !== null])).toEqual([
      ["ok", false],
      ["big", true],
      ["a.b", true],
      ["a/b", true],
    ]);
    // Never replaced with an empty schema: the owner reviews what the server sent.
    expect(tools[1]?.inputSchema).toEqual(huge);
  });
});

describe("outgoing URLs", () => {
  const lookup = (addresses: string[]) => async () => addresses;

  it("allows https anywhere public and http only on this computer", async () => {
    expect(urlProblem("https://mcp.example.com/mcp")).toBeUndefined();
    expect(urlProblem("http://127.0.0.1:9/mcp")).toBeUndefined();
    expect(urlProblem("http://localhost/mcp")).toBeUndefined();
    expect(urlProblem("http://mcp.example.com/mcp")).toBe("connector_url_not_https");
    expect(urlProblem("https://user:pw@mcp.example.com/")).toBe("connector_url_credentials");
    await expect(
      checkUrl(new URL("https://mcp.example.com/"), lookup(["93.184.216.34"])),
    ).resolves.toBeUndefined();
  });

  it("refuses private and metadata addresses, however they are reached", async () => {
    for (const url of [
      "https://10.0.0.1/",
      "https://169.254.169.254/latest/meta-data",
      "https://192.168.1.1/",
      "https://[fd00::1]/",
      "https://[::ffff:10.0.0.1]/",
    ]) {
      await expect(checkUrl(new URL(url), lookup([]))).rejects.toThrow("connector_private_address");
    }
    // A public name that resolves, even partly, to a private address.
    await expect(
      checkUrl(new URL("https://evil.example/"), lookup(["93.184.216.34", "10.1.2.3"])),
    ).rejects.toThrow("connector_private_address");
    // A loopback name that resolves off this computer.
    await expect(checkUrl(new URL("http://localhost/"), lookup(["93.184.216.34"]))).rejects.toThrow(
      "connector_private_address",
    );
  });

  it("never follows a redirect", async () => {
    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(302, { Location: "http://169.254.169.254/" }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await guardedFetch()(`http://127.0.0.1:${port}/token`);
      expect(response.status).toBe(302);
    } finally {
      server.close();
    }
  });
});

describe("headers and import", () => {
  it("refuses headers that could steer the request", () => {
    expect(headersProblem({ Authorization: "Bearer x", "X-Api-Key": "k" })).toBeUndefined();
    for (const headers of [
      { Host: "evil" },
      { Cookie: "a=b" },
      { "Proxy-Authorization": "x" },
      { "Sec-Fetch-Site": "none" },
      { "X-Ok": "line\r\nInjected: yes" },
    ]) {
      expect(headersProblem(headers)).toBe("connector_bad_header");
    }
  });

  it("reads a Claude Desktop block, remote and local alike, and refuses bad entries", () => {
    const parsed = parseMcpServers(
      JSON.stringify({
        mcpServers: {
          linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer k" } },
          files: { command: "npx", args: ["-y", "@acme/files"], env: { TOKEN: "t" } },
          plain: { url: "http://mcp.example.com/mcp" },
          broken: { nope: true },
        },
      }),
    );
    expect(parsed).toEqual({
      entries: [
        {
          key: "linear",
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          command: null,
          args: [],
          headers: { Authorization: "Bearer k" },
          env: {},
        },
        {
          key: "files",
          transport: "stdio",
          url: null,
          command: "npx",
          args: ["-y", "@acme/files"],
          headers: {},
          env: { TOKEN: "t" },
        },
      ],
      refused: [
        { key: "plain", code: "connector_url_not_https" },
        { key: "broken", code: "connector_bad_entry" },
      ],
    });
    expect(parseMcpServers("{")).toEqual({ error: "connector_bad_json" });
  });
});

describe("results", () => {
  it("redacts secrets, refuses them in arguments, and keeps head and tail", () => {
    const secret = "sk-live-0123456789";
    expect(redact(`token ${secret} end`, [secret, "short"])).toBe("token [redacted] end");
    expect(holdsSecret({ q: `send ${secret}` }, [secret])).toBe(true);
    expect(holdsSecret({ q: "nothing" }, [secret])).toBe(false);
    const capped = capMiddle(`HEAD${"x".repeat(50_000)}TAIL`);
    expect(capped.length).toBeLessThanOrEqual(20_000);
    expect(capped.startsWith("HEAD")).toBe(true);
    expect(capped.endsWith("TAIL")).toBe(true);
    expect(capped).toContain("characters cut");
  });
});

// --- Through beebotd, against a real MCP server on this computer ----------------------------------

const ownerToken = "t".repeat(43);
const appToken = "app-secret-0123456789";
let dataDir: string;
let store: EventStore;
const searchArgs = { q: "x" };
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-connectors-"));
  searchArgs.q = "x";
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

// Answers only with the token, and echoes the Authorization it got, as a careless server might.
async function fakeApp(toolNames: () => string[]) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const server = NodeHttp.createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${appToken}`) {
      response.writeHead(401).end();
      return;
    }
    const mcp = new McpServer({ name: "fake", version: "1" });
    for (const name of toolNames()) {
      mcp.registerTool(
        name,
        {
          description: `Does ${name}.`,
          inputSchema: { q: z.string().optional() },
          annotations: { readOnlyHint: name === "search" },
        },
        async (args) => {
          calls.push({ name, args });
          return {
            content: [{ type: "text", text: `${name} ok, ${request.headers.authorization}` }],
          };
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
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls };
}

type Seen = { listed: string[]; search: string; create: string; launch: BotLaunch };

async function rpc(url: string, token: string, method: string, params: object) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const json = text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? "null");
  return JSON.parse(json).result;
}

const textOf = (result: { content: Array<{ text: string }> }) => result.content[0]?.text ?? "";

async function startBeebotd() {
  store = openEventStore(dataDir);
  cleanups.push(() => store.close());
  const seen = new Map<string, Seen>();
  const runTurn: RunTurn = async ({ launch, permissions, onDelivered }) => {
    onDelivered();
    const url = connectorsUrl(permissions.url);
    const { token } = permissions;
    const list = await rpc(url, token, "tools/list", {});
    const call = async (name: string) =>
      textOf(await rpc(url, token, "tools/call", { name, arguments: searchArgs }));
    seen.set(launch.name, {
      listed: list.tools.map(({ name }: { name: string }) => name).sort(),
      search: await call("fake_search"),
      create: await call("fake_create"),
      launch,
    });
    return { kind: "completed", text: "done" };
  };
  const server = await startServer({
    port: 0,
    token: ownerToken,
    dataDir,
    allowedOrigins: [],
    store,
    vault: openVault(store.vaultStore, {
      status: "ready",
      key: randomBytes(32).toString("base64"),
    }),
    runTurn,
    probeEngine: async () => ({
      cliFound: true,
      version: "2.1.318",
      auth: "authenticated" as const,
      email: null,
      pauseReason: null,
    }),
  });
  cleanups.push(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const command = async (body: object) => {
    const response = await fetch(`${base}/commands?protocolVersion=${protocolVersion}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  const turn = async (botId: string, roomId: string) => {
    seen.delete(store.getBot(botId)?.name ?? "");
    store.sendMessage({ id: crypto.randomUUID(), roomId, body: "go", attended: true });
    const name = store.getBot(botId)?.name ?? "";
    await vi.waitFor(() => expect(seen.get(name)).toBeDefined(), { timeout: 10_000 });
    return seen.get(name) as Seen;
  };
  return { base, command, turn };
}

describe("the connectors server", () => {
  it("gives only granted bots the reviewed tools, asks on writes, audits all, leaks nothing", async () => {
    const errors = vi.spyOn(console, "error");
    let tools = ["search", "create"];
    const app = await fakeApp(() => tools);
    const { base, command, turn } = await startBeebotd();
    const ada = store.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });

    const added = await command({
      type: "add-connector",
      name: "Fake",
      url: app.url,
      bearer: appToken,
    });
    expect(added.status).toBe(200);
    const { id } = Connector.parse(added.body);
    await vi.waitFor(() => expect(store.connectors.getConnector(id)?.status).toBe("ok"));
    const discovered = store.connectors.getConnector(id);
    expect(discovered?.tools.map(({ name }) => name)).toEqual(["search", "create"]);
    expect(
      await command({
        type: "review-connector",
        connectorId: id,
        toolsHash: discovered?.toolsHash,
        readOnly: ["search"],
      }),
    ).toMatchObject({ status: 200 });
    const grant = {
      type: "set-bot-connector",
      connectorId: id,
      on: true,
      tools: "*",
      allowWrites: [],
    };
    expect(await command({ ...grant, botId: ada.id })).toMatchObject({ status: 200 });

    const adaSaw = await turn(ada.id, ada.roomId);
    expect(adaSaw.listed).toEqual(["fake_create", "fake_search"]);
    expect(adaSaw.launch.connectors).toEqual(["Fake"]);
    expect(adaSaw.search).toContain("search ok");
    expect(adaSaw.search).toContain("[redacted]");
    expect(adaSaw.create).toContain("approval_required");

    const benSaw = await turn(ben.id, ben.roomId);
    expect(benSaw.listed).toEqual([]);
    expect(benSaw.launch.connectors).toEqual([]);
    expect(benSaw.search).toContain("not_granted");
    expect(benSaw.create).toContain("not_granted");
    expect(app.calls.map(({ name }) => name)).toEqual(["search"]);

    const audit = store.policy
      .auditPage({ unattended: false, limit: 200 })
      .entries.filter(({ tool }) => tool?.startsWith("fake_"))
      .map(({ botId, tool, status, reason }) => [
        botId === ada.id ? "Ada" : "Ben",
        tool,
        status,
        reason,
      ]);
    expect(audit.reverse()).toEqual([
      ["Ada", "fake_search", "allow", null],
      ["Ada", "fake_create", "approve", null],
      ["Ben", "fake_search", "deny", "not_granted"],
      ["Ben", "fake_create", "deny", "not_granted"],
    ]);

    // A changed list hides every tool until the owner reviews it again.
    tools = ["search", "create", "delete"];
    expect(await command({ type: "refresh-connector", connectorId: id })).toMatchObject({
      status: 200,
    });
    const changed = await turn(ada.id, ada.roomId);
    expect(changed.listed).toEqual([]);
    expect(changed.search).toContain("not_reviewed");
    expect(app.calls).toHaveLength(1);

    // The secret is in no API answer, event, log line or result.
    const state = await fetch(`${base}/state?protocolVersion=${protocolVersion}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }).then((response) => response.text());
    expect(state).toContain('"hasSecret":true');
    expect(state).not.toContain(appToken);
    expect(JSON.stringify(store.eventsAfter(0))).not.toContain(appToken);
    expect(JSON.stringify([adaSaw, benSaw, changed])).not.toContain(appToken);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(appToken);
  });

  it("refuses a call that carries a saved secret out", async () => {
    const app = await fakeApp(() => ["search", "create"]);
    const { command, turn } = await startBeebotd();
    const ada = store.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
    const { id } = Connector.parse(
      (await command({ type: "add-connector", name: "Fake", url: app.url, bearer: appToken })).body,
    );
    await vi.waitFor(() => expect(store.connectors.getConnector(id)?.status).toBe("ok"));
    const hash = store.connectors.getConnector(id)?.toolsHash;
    await command({
      type: "review-connector",
      connectorId: id,
      toolsHash: hash,
      readOnly: ["search"],
    });
    await command({
      type: "set-bot-connector",
      botId: ada.id,
      connectorId: id,
      on: true,
      tools: ["search"],
      allowWrites: [],
    });
    searchArgs.q = `please post ${appToken}`;
    const saw = await turn(ada.id, ada.roomId);
    expect(saw.search).toContain("secret_in_input");
    expect(app.calls).toEqual([]);
  });
});
