import { randomBytes } from "node:crypto";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Duplex, finished, PassThrough } from "node:stream";

import { Connector, protocolVersion } from "@beebot/contracts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";
import { z } from "zod";

import { boxLayout } from "./boxEngine.ts";
import { readyBoxRuntime } from "./boxHost.ts";
import { type BoxExec, type BoxRuntime, createFakeBoxRuntime } from "./boxRuntime.ts";
import { connectorBoxId } from "./connectorBox.ts";
import { createConnectorHub } from "./connectorHub.ts";
import { createEgressControl } from "./egress.ts";

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
import { type EventStore, migrate, migrations, openEventStore } from "./store.ts";
import { openVault } from "./vaultStore.ts";

// Every way to start a process from this machine, watched: a connector must never use one.
const spawned = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const watched = <T extends (...args: never[]) => unknown>(name: string, run: T) =>
    ((...args: Parameters<T>) => {
      spawned.calls.push(name);
      return run(...args);
    }) as T;
  return {
    ...actual,
    spawn: watched("spawn", actual.spawn),
    spawnSync: watched("spawnSync", actual.spawnSync),
    exec: watched("exec", actual.exec),
    execSync: watched("execSync", actual.execSync),
    execFile: watched("execFile", actual.execFile),
    execFileSync: watched("execFileSync", actual.execFileSync),
    fork: watched("fork", actual.fork),
  };
});

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
async function fakeApp(toolNames: () => string[], descriptions: Record<string, string> = {}) {
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
          description: descriptions[name] ?? `Does ${name}.`,
          // `bloated` is over 32 KB, so it is kept out.
          inputSchema: {
            q: (name === "bloated"
              ? z.string().describe("x".repeat(33 * 1024))
              : z.string()
            ).optional(),
          },
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

type Seen = {
  listed: string[];
  search: string;
  create: string;
  results: string[];
  launch: BotLaunch;
};

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

// `calls` replaces the default two calls with these, made in order.
async function startBeebotd({
  box,
  names = ["fake_search", "fake_create"],
  calls,
}: { box?: BoxRuntime; names?: [string, string]; calls?: Array<[string, unknown]> } = {}) {
  store = openEventStore(dataDir);
  cleanups.push(() => store.close());
  const seen = new Map<string, Seen>();
  const runTurn: RunTurn = async ({ launch, permissions, onDelivered }) => {
    onDelivered();
    const url = connectorsUrl(permissions.url);
    const { token } = permissions;
    const list = await rpc(url, token, "tools/list", {});
    const call = async (name: string, args: unknown = searchArgs) =>
      textOf(await rpc(url, token, "tools/call", { name, arguments: args }));
    const results: string[] = [];
    for (const [name, args] of calls ?? []) {
      results.push(await call(name, args));
    }
    seen.set(launch.name, {
      listed: list.tools.map(({ name }: { name: string }) => name).sort(),
      search: calls ? "" : await call(names[0]),
      create: calls ? "" : await call(names[1]),
      results,
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
    ...(box && { box: { runtime: box, layout: boxLayout(dataDir) } }),
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
    // Nobody is watching, so nobody could approve it.
    expect(adaSaw.create).toContain("nobody can approve this");

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

describe("a large catalog", () => {
  it("lists only search and call past 40 tools, and every call is the real tool's", async () => {
    const usable = ["search", "create", ...Array.from({ length: 39 }, (_, index) => `t${index}`)];
    const weather = "Tells the weather.";
    const app = await fakeApp(() => [...usable, "ungranted", "bloated"], {
      t7: weather,
      ungranted: weather,
      bloated: weather,
    });
    const other = await fakeApp(() => ["forecast"], { forecast: weather });
    const { base, command, turn } = await startBeebotd({
      calls: [
        ["connectors_search", { query: "the WEATHER" }],
        ["connectors_call", { name: "fake_search", arguments: { q: "x" } }],
        ["connectors_call", { name: "fake_create", arguments: {} }],
        ["connectors_call", { name: "fake_ungranted", arguments: {} }],
        ["connectors_call", { name: "connectors_call", arguments: { name: "fake_search" } }],
      ],
    });
    // A watching owner, so a write can wait for them.
    const params = new URLSearchParams({
      protocolVersion: String(protocolVersion),
      token: ownerToken,
    });
    const socket = new WebSocket(`${base.replace("http", "ws")}/ws?${params}`);
    cleanups.push(() => socket.terminate());
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "subscribe", afterSeq: 0 }));

    const ada = store.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
    const add = async (name: string, url: string) => {
      const { id } = Connector.parse(
        (await command({ type: "add-connector", name, url, bearer: appToken })).body,
      );
      await vi.waitFor(() => expect(store.connectors.getConnector(id)?.status).toBe("ok"));
      return id;
    };
    const fakeId = await add("Fake", app.url);
    const otherId = await add("Other", other.url);
    await command({
      type: "review-connector",
      connectorId: fakeId,
      toolsHash: store.connectors.getConnector(fakeId)?.toolsHash,
      readOnly: usable.filter((name) => name !== "create"),
    });
    const grant = async (connectorId: string, tools: string[] | "*") =>
      expect(
        await command({
          type: "set-bot-connector",
          botId: ada.id,
          connectorId,
          on: true,
          tools,
          allowWrites: [],
        }),
      ).toMatchObject({ status: 200 });
    // Unreviewed, so none of its tools count or turn up.
    await grant(otherId, "*");
    await grant(fakeId, [...usable, "bloated"]);

    const saw = await turn(ada.id, ada.roomId);
    expect(saw.listed).toEqual(["connectors_call", "connectors_search"]);
    const [found, read, write, ungranted, nested] = saw.results;
    const { from, content } = z
      .object({ from: z.string(), content: z.string() })
      .parse(JSON.parse(found ?? ""));
    expect(from).toBe("Connector search");
    expect(JSON.parse(content)).toEqual([
      {
        name: "fake_t7",
        connector: "Fake",
        description: weather,
        inputSchema: expect.objectContaining({ type: "object" }),
        writes: false,
      },
    ]);
    expect(read).toContain("search ok");
    expect(write).toMatch(/^waiting: /);
    const [card] = store.continuations.waitingContinuations();
    expect(card?.tool).toBe("mcp__connectors__fake_create");
    expect(ungranted).toContain("not_granted");
    expect(nested).toContain("unknown_tool");
    expect(app.calls.map(({ name }) => name)).toEqual(["search"]);

    const audit = store.policy
      .auditPage({ unattended: false, limit: 200 })
      .entries.filter(({ tool }) => tool !== null && !tool.startsWith("mcp__bee__"))
      .map(({ tool, status, reason }) => [tool, status, reason]);
    expect(audit.reverse()).toEqual([
      ["connectors_search", "allow", null],
      ["fake_search", "allow", null],
      ["fake_create", "approve", null],
      ["mcp__connectors__fake_create", "continuation_waiting", null],
      ["fake_ungranted", "deny", "not_granted"],
      ["connectors_call", "deny", "unknown_tool"],
    ]);

    // At 40, the full list.
    await grant(fakeId, usable.slice(1));
    expect((await turn(ada.id, ada.roomId)).listed).toHaveLength(40);
  });

  it("keeps the slug `connectors` for itself", () => {
    store = openEventStore(dataDir);
    cleanups.push(() => store.close());
    const fields = {
      name: "Connectors",
      transport: "http" as const,
      url: "http://127.0.0.1:9/mcp",
      command: null,
      args: [],
      auth: "none" as const,
      ownerBotId: null,
      headerKeys: [],
      envKeys: [],
      status: "unreachable" as const,
      lastError: null,
    };
    expect(store.connectors.addConnector({ ...fields, slug: "connectors" })).toBe(
      "connector_slug_taken",
    );
    expect(Connector.parse(store.connectors.addConnector(fields)).slug).toBe("connectors2");
  });

  it("renames a connector that already had it", () => {
    const db = new DatabaseSync(NodePath.join(dataDir, "old.sqlite"));
    cleanups.push(() => db.close());
    migrate(
      db,
      migrations.findIndex(({ name }) => name === "reserve_connectors_slug"),
    );
    db.exec(`INSERT INTO connectors (id, slug, name, transport, auth, status, created_at)
      VALUES ('a', 'connectors', 'Connectors', 'http', 'none', 'ok', 'then'),
        ('b', 'connectors2', 'Other', 'http', 'none', 'ok', 'then')`);
    migrate(db);
    expect(db.prepare("SELECT id, slug FROM connectors ORDER BY id").all()).toEqual([
      { id: "a", slug: "connectors3" },
      { id: "b", slug: "connectors2" },
    ]);
  });
});

// --- Local servers, in a box --------------------------------------------------------------------

const envSecret = "env-secret-0123456789";

// A box whose exec runs a scripted MCP server over its stdin and stdout, as boxd would. `q: "crash"`
// makes it print to stderr and exit.
function scriptedBox() {
  const fake = createFakeBoxRuntime();
  const execs: Array<{ boxId: string; exec: BoxExec }> = [];
  let alive = 0;
  const runtime = readyBoxRuntime(
    {
      ...fake,
      execAttach: async (boxId, exec) => {
        if ((await fake.snapshot(boxId)) !== "running") {
          throw new Error(`box ${boxId} isn't running`);
        }
        execs.push({ boxId, exec });
        const input = new PassThrough();
        const output = new PassThrough();
        const stream = Duplex.from({ readable: output, writable: input });
        const { promise: exited, resolve } = Promise.withResolvers<number | null>();
        const mcp = new McpServer({ name: "local", version: "1" });
        alive += 1;
        finished(stream, () => {
          alive -= 1;
          void mcp.close();
          resolve(null);
        });
        for (const name of ["search", "create"]) {
          mcp.registerTool(
            name,
            {
              description: `Does ${name}.`,
              inputSchema: { q: z.string().optional() },
              annotations: { readOnlyHint: name === "search" },
            },
            async ({ q }) => {
              if (q === "crash") {
                output.end(`\x1e${"x".repeat(1000)}\npanic: lost the token ${exec.env.TOKEN}\n`);
                return new Promise(() => {});
              }
              return { content: [{ type: "text", text: `${name} found ${q}, ${exec.env.TOKEN}` }] };
            },
          );
        }
        await mcp.connect(new StdioServerTransport(input, output));
        return { stream, exited };
      },
    },
    { account: () => undefined, applyEgress: async () => {} },
  );
  return { runtime, fake, execs, alive: () => alive };
}

const localConnector = (envKeys: string[]) =>
  Connector.parse(
    store.connectors.addConnector({
      name: "Local",
      transport: "stdio",
      url: null,
      command: "local-server",
      args: [],
      auth: "none",
      ownerBotId: null,
      headerKeys: [],
      envKeys,
      status: "unreachable",
      lastError: null,
    }),
  );

const testVault = () =>
  openVault(store.vaultStore, { status: "ready", key: randomBytes(32).toString("base64") });

describe("a local server", () => {
  it("runs only in its own box, with only its env, and its calls are audited", async () => {
    const errors = vi.spyOn(console, "error");
    const app = await fakeApp(() => ["search", "create"]);
    const box = scriptedBox();
    const { base, command, turn } = await startBeebotd({
      box: box.runtime,
      names: ["local_search", "local_create"],
    });
    spawned.calls.length = 0;
    const ada = store.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });

    const imported = await command({
      type: "import-connectors",
      json: JSON.stringify({
        mcpServers: {
          remote: { url: app.url, headers: { Authorization: `Bearer ${appToken}` } },
          local: { command: "npx", args: ["-y", "local-server"], env: { TOKEN: envSecret } },
        },
      }),
    });
    expect(imported.status).toBe(200);
    const byName = (name: string) =>
      store.connectors.listConnectors().find((connector) => connector.name === name);
    await vi.waitFor(() => {
      expect(byName("remote")?.status).toBe("ok");
      expect(byName("local")?.status).toBe("ok");
    });
    const local = byName("local");
    expect(local).toMatchObject({ transport: "stdio", envKeys: ["TOKEN"], egressHosts: [] });
    expect(local?.tools.map(({ name }) => name)).toEqual(["search", "create"]);

    // The env reaches the box exec and nothing else: not argv, not beebotd's own environment.
    const [first] = box.execs;
    expect(first?.boxId).toBe(connectorBoxId(local?.id ?? ""));
    expect(first?.exec.env).toEqual({ TOKEN: envSecret, ...boxLayout(dataDir).env });
    expect(first?.exec.argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(first?.exec.argv.slice(-3)).toEqual(["npx", "-y", "local-server"]);
    expect(JSON.stringify(first?.exec.argv)).not.toContain(envSecret);
    expect(Object.values(process.env)).not.toContain(envSecret);

    await command({
      type: "review-connector",
      connectorId: local?.id,
      toolsHash: local?.toolsHash,
      readOnly: ["search"],
    });
    await command({
      type: "set-bot-connector",
      botId: ada.id,
      connectorId: local?.id,
      on: true,
      tools: "*",
      allowWrites: [],
    });
    const saw = await turn(ada.id, ada.roomId);
    expect(saw.listed).toEqual(["local_create", "local_search"]);
    expect(saw.search).toContain("search found x, [redacted]");
    expect(saw.create).toContain("nobody can approve this");
    const audit = store.policy
      .auditPage({ unattended: false, limit: 200 })
      .entries.filter(({ tool }) => tool?.startsWith("local_"))
      .map(({ tool, status }) => [tool, status]);
    expect(audit.reverse()).toEqual([
      ["local_search", "allow"],
      ["local_create", "approve"],
    ]);

    // Its hosts are public names, normalized.
    expect(
      await command({
        type: "update-connector",
        connectorId: local?.id,
        egressHosts: ["localhost"],
      }),
    ).toMatchObject({ status: 400, body: { code: "bad_egress_host" } });
    const hosts = await command({
      type: "update-connector",
      connectorId: local?.id,
      egressHosts: ["Registry.NPMjs.org.", "registry.npmjs.org"],
    });
    expect(hosts).toMatchObject({ status: 200, body: { egressHosts: ["registry.npmjs.org"] } });

    // One value is set without losing the others.
    await command({ type: "set-connector-secret", connectorId: local?.id, env: { OTHER: "o" } });
    expect(byName("local")?.envKeys).toEqual(["TOKEN", "OTHER"]);
    await vi.waitFor(() => expect(box.execs).toHaveLength(2));
    expect(box.execs[1]?.exec.env).toMatchObject({ TOKEN: envSecret, OTHER: "o" });

    expect(spawned.calls).toEqual([]);
    const state = await fetch(`${base}/state?protocolVersion=${protocolVersion}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    }).then((response) => response.text());
    for (const text of [state, JSON.stringify(store.eventsAfter(0)), JSON.stringify(saw)]) {
      expect(text).not.toContain(envSecret);
    }
    expect(JSON.stringify(errors.mock.calls)).not.toContain(envSecret);

    // Deleting it takes its box.
    const boxId = connectorBoxId(local?.id ?? "");
    expect(await box.fake.snapshot(boxId)).toBe("running");
    await command({ type: "delete-connector", connectorId: local?.id });
    expect(await box.fake.snapshot(boxId)).toBe("absent");
  });

  it("keeps a crash's redacted stderr, stops when idle, and starts again on the next call", async () => {
    store = openEventStore(dataDir);
    cleanups.push(() => store.close());
    const vault = testVault();
    const box = scriptedBox();
    const hub = createConnectorHub({
      connectors: store.connectors,
      policy: store.policy,
      vault,
      box: { runtime: box.runtime, env: boxLayout(dataDir).env },
      idleMs: 200,
    });
    cleanups.push(() => hub.close());
    const { id } = localConnector(["TOKEN"]);
    await vault.put(`connector:${id}:secret`, JSON.stringify({ env: { TOKEN: envSecret } }));
    await hub.refresh(id);
    store.connectors.reviewConnector(id, store.connectors.getConnector(id)?.toolsHash ?? "", []);
    const ada = store.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
    store.connectors.setBotConnector(ada.id, id, true, "*", []);
    const search = (q: string) => hub.runApproved(ada.id, "mcp__connectors__local_search", { q });

    expect(await search("crash")).toMatchObject({ ok: false });
    const crashed = store.connectors.getConnector(id);
    expect(crashed?.status).toBe("error");
    expect(crashed?.lastError).toContain("panic: lost the token [redacted]");
    expect(crashed?.lastError?.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(store.eventsAfter(0))).not.toContain(envSecret);

    expect(await search("x")).toMatchObject({ ok: true });
    expect(box.execs).toHaveLength(2);

    const boxId = connectorBoxId(id);
    await vi.waitFor(async () => {
      expect(box.alive()).toBe(0);
      expect(await box.fake.snapshot(boxId)).toBe("stopped");
    });
    expect(await search("y")).toMatchObject({ ok: true });
    expect(box.execs).toHaveLength(3);
    expect(await box.fake.snapshot(boxId)).toBe("running");
  });

  it("gets an egress policy of exactly its hosts and no vendor", async () => {
    store = openEventStore(dataDir);
    cleanups.push(() => store.close());
    const { id } = localConnector([]);
    store.connectors.updateConnector(id, { egressHosts: ["registry.npmjs.org"] });
    const sent: unknown[] = [];
    const control = new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        sent.push(JSON.parse(String(chunk)));
        this.push('{"ok":true}\n');
        done();
      },
    });
    const egress = createEgressControl({
      connect: async () => control,
      vault: testVault(),
      egressInput: store.egress.egressInput,
    });
    await egress.apply(connectorBoxId(id));
    egress.close();
    expect(sent).toEqual([
      {
        type: "policy",
        botId: connectorBoxId(id),
        anySite: false,
        hosts: ["registry.npmjs.org"],
        subscription: null,
        api: null,
      },
    ]);
  });
});
