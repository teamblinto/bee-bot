import * as NodeCrypto from "node:crypto";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type Bot,
  type Command,
  type Continuation,
  type PendingApproval,
  protocolVersion,
  ServerMessage,
} from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

import {
  boxVerdict,
  createApprovals,
  type Execute,
  inputDigest,
  writeAction,
} from "./approvals.ts";
import { type Decide, decide as policyDecide } from "./broker.ts";
import { waitingMessage } from "./continuations.ts";
import { fakeRunTurn, type RunTurn, type TurnOutcome, workspacePath } from "./engine.ts";
import { startServer } from "./server.ts";
import { type EventStore, openEventStore } from "./store.ts";

const ownerToken = "t".repeat(43);
const secret = "hunter2-do-not-keep";
const command = `echo ${secret}`;

type Permissions = { url: string; token: string };
type Turn = {
  permissions: Permissions;
  tool: (name: string) => void;
  finish: (outcome: TurnOutcome) => void;
};

let dataDir: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dataDir = NodeFS.realpathSync.native(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-approvals-")),
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

function connect(port: number) {
  const params = new URLSearchParams({
    protocolVersion: String(protocolVersion),
    token: ownerToken,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${params}`);
  cleanups.push(() => socket.terminate());
  const messages: ServerMessage[] = [];
  socket.on("message", (data) => messages.push(ServerMessage.parse(JSON.parse(data.toString()))));
  const cards = () =>
    messages.flatMap((m) => (m.type === "pending-approvals" ? [m.approvals] : [])).at(-1);
  const ready = once(socket, "open").then(async () => {
    socket.send(JSON.stringify({ type: "subscribe", afterSeq: 0 }));
    await vi.waitFor(() => expect(cards()).toBeDefined());
  });
  return { socket, messages, cards, ready };
}

type BootOptions = {
  runTurn?: RunTurn;
  approvalTimeoutMs?: number;
  turnTimeoutMs?: number;
  mcpKeepaliveMs?: number;
  continuationTtlMs?: number;
  decide?: Decide;
  executors?: ReadonlyMap<string, Execute>;
};

async function boot(options: BootOptions = {}) {
  const turns: Turn[] = [];
  const scripted: RunTurn = ({ permissions, signal, onToolStart }) =>
    new Promise((resolve) => {
      turns.push({
        permissions,
        tool: (name: string) => onToolStart({ id: crypto.randomUUID(), name, detail: null }),
        finish: resolve,
      });
      signal.addEventListener("abort", () => resolve({ kind: "failed" }));
    });
  const store = openEventStore(dataDir);
  const server = await startServer({
    port: 0,
    token: ownerToken,
    dataDir,
    allowedOrigins: [],
    fakeEngine: true,
    store,
    probeEngine: async () => ({
      cliFound: true,
      version: "2.1.318",
      auth: "authenticated" as const,
      email: null,
      pauseReason: null,
    }),
    runTurn: scripted,
    ...options,
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
  const client = connect(server.port);
  await client.ready;

  const post = (body: Command) =>
    fetch(`http://127.0.0.1:${server.port}/commands?protocolVersion=${protocolVersion}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify(body),
    });

  async function startTurn(
    engineAccountId: "claude" | "fake" = "claude",
    projectPath: string | null = null,
  ) {
    const bot = (await (
      await post({ type: "create-bot", name: "Ada", personality: "", engineAccountId, projectPath })
    ).json()) as Bot;
    await post({ type: "set-bot-engine", botId: bot.id, access: "supervised" });
    const before = turns.length;
    await post({
      type: "send-message",
      messageId: NodeCrypto.randomUUID(),
      roomId: bot.roomId,
      body: "hello",
    });
    await vi.waitFor(() => expect(turns.length).toBe(before + 1), { timeout: 3000 });
    return { bot, turn: turns[before] as Turn };
  }

  const decide = (card: PendingApproval, decision: "allow" | "deny" | "always", digest?: string) =>
    post({
      type: "decide-approval",
      approvalId: card.id,
      digest:
        digest ?? (store.state().approvals.find(({ id }) => id === card.id)?.digest as string),
      decision,
    });

  const nextCard = async (count = 1) => {
    await vi.waitFor(() => expect(client.cards()).toHaveLength(count), { timeout: 3000 });
    return client.cards()?.at(-1) as PendingApproval;
  };

  return {
    store,
    port: server.port,
    power: server.power,
    stop,
    client,
    post,
    startTurn,
    decide,
    nextCard,
    turns,
  };
}

const rpc = (method: string, params?: unknown, id: number | undefined = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

function mcp({ url, token }: Permissions, body: string, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
}

const toolCall = (tool_name: string, input: unknown) =>
  rpc("tools/call", {
    name: "approve",
    arguments: { tool_name, input, tool_use_id: "toolu_1" },
  });

async function memoryCall(permissions: Permissions, name: string, args: unknown) {
  const response = await mcp(permissions, rpc("tools/call", { name, arguments: args }));
  expect(response.headers.get("content-type")).toBe("application/json");
  const { result } = (await response.json()) as { result: { content: [{ text: string }] } };
  return result.content[0].text;
}

async function decisionOf(response: Response) {
  const text = await response.text();
  const data = /^event: message\ndata: (.*)\n\n$/m.exec(text)?.[1] ?? "";
  return JSON.parse(JSON.parse(data).result.content[0].text) as {
    behavior: string;
    message?: string;
    updatedInput?: unknown;
  };
}

function rows(sql: string) {
  const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

// The approval gate's own rows. The broker decides first and writes its rows too.
const auditRows = () =>
  rows(
    `SELECT tool, status, reason FROM audit_log
     WHERE tool IS NOT NULL AND status NOT IN ('allow', 'deny', 'approve', 'hand_off') ORDER BY id`,
  );

describe("the MCP endpoint", () => {
  it("answers the handshake as plain JSON, and notifications with 202", async () => {
    const { startTurn } = await boot();
    const { permissions } = (await startTurn()).turn;

    const init = await mcp(permissions, rpc("initialize", { protocolVersion: "2025-06-18" }));
    expect(init.headers.get("content-type")).toBe("application/json");
    expect(await init.json()).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
    });

    const list = (await (await mcp(permissions, rpc("tools/list"))).json()) as {
      result: { tools: Array<{ name: string; annotations?: unknown }> };
    };
    expect(list.result.tools.map(({ name }) => name)).toEqual([
      "approve",
      "memory_search",
      "memory_get",
      "memory_propose",
      "memory_forget",
      "send_message",
      "notify",
      "delegate",
      "handoff",
      "ask_user",
      "create_routine",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "request_takeover",
      "computer_screenshot",
      "computer_click",
      "computer_type",
      "computer_key",
      "computer_scroll",
      "computer_drag",
    ]);
    // A read-only hint would let the CLI run a memory call alongside a tool, ahead of the taint.
    expect(list.result.tools.every(({ annotations }) => annotations === undefined)).toBe(true);
    expect(await (await mcp(permissions, rpc("ping"))).json()).toMatchObject({ result: {} });

    const note = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect((await mcp(permissions, note)).status).toBe(202);

    const unknown = await mcp(permissions, rpc("server/discover"));
    expect(await unknown.json()).toMatchObject({ id: 1, error: { code: -32601 } });
  });

  it("refuses other methods, any Origin, and bad bodies", async () => {
    const { startTurn } = await boot();
    const { permissions } = (await startTurn()).turn;
    const bearer = { Authorization: `Bearer ${permissions.token}` };
    expect((await fetch(permissions.url, { headers: bearer })).status).toBe(405);
    const fromBrowser = await mcp(permissions, rpc("ping"), { Origin: "http://127.0.0.1:5833" });
    expect(fromBrowser.status).toBe(403);
    expect(fromBrowser.headers.has("access-control-allow-origin")).toBe(false);
    expect((await mcp(permissions, "not json")).status).toBe(400);
  });

  it("takes a 1 MB Write, past the 256 KB command cap, but not one over 16 MB", async () => {
    const { startTurn, nextCard, decide } = await boot();
    const { permissions } = (await startTurn()).turn;
    const content = "x".repeat(1024 * 1024);
    const call = mcp(permissions, toolCall("Write", { file_path: "big.txt", content }));
    await decide(await nextCard(), "deny");
    expect((await call).status).toBe(200);
    const huge = "x".repeat(17 * 1024 * 1024);
    const refused = await mcp(permissions, toolCall("Write", { file_path: "a", content: huge }));
    expect(refused.status).toBe(413);
  });

  it("flushes SSE headers at once, keeps the line alive, then frames the result", async () => {
    const { startTurn, nextCard, decide } = await boot({ mcpKeepaliveMs: 10 });
    const { permissions } = (await startTurn()).turn;

    const response = await mcp(permissions, toolCall("Bash", { command }));
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(": keepalive\n\n");

    await decide(await nextCard(), "allow");
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value);
    }
    const frame = text.replaceAll(": keepalive\n\n", "");
    expect(frame).toMatch(/^event: message\ndata: \{.*\}\n\n$/);
    const message = JSON.parse(frame.split("data: ")[1] ?? "");
    expect(message).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(JSON.parse(message.result.content[0].text)).toEqual({
      behavior: "allow",
      updatedInput: { command },
    });
  });
});

describe("run tokens", () => {
  it("are refused once their run ends, and owner credentials never work", async () => {
    const { startTurn, store } = await boot();
    const { turn, bot } = await startTurn();
    expect((await mcp(turn.permissions, rpc("ping"))).status).toBe(200);
    const owner = { ...turn.permissions, token: ownerToken };
    expect((await mcp(owner, rpc("ping"))).status).toBe(401);
    expect((await mcp({ ...turn.permissions, token: "" }, rpc("ping"))).status).toBe(401);

    turn.finish({ kind: "completed", text: "done" });
    await vi.waitFor(() => {
      expect(store.state().runs.find(({ botId }) => botId === bot.id)?.status).toBe("Completed");
    });
    expect((await mcp(turn.permissions, rpc("ping"))).status).toBe(401);
  });

  it("act only on their own run", async () => {
    const { startTurn, nextCard, store } = await boot();
    const first = await startTurn("claude");
    const second = await startTurn("fake");
    expect(first.turn.permissions.token).not.toBe(second.turn.permissions.token);

    void mcp(second.turn.permissions, toolCall("Bash", { command })).catch(() => {});
    await nextCard();
    const [approval] = store.state().approvals;
    const run = store.state().runs.find(({ id }) => id === approval?.runId);
    expect(run?.botId).toBe(second.bot.id);
    expect(approval?.botId).toBe(second.bot.id);
  });

  it("are refused after a stop, while the turn is still winding down", async () => {
    const { startTurn, post } = await boot();
    const { turn, bot } = await startTurn();
    await post({ type: "stop-bot", botId: bot.id });
    expect((await mcp(turn.permissions, rpc("ping"))).status).toBe(401);
  });
});

describe("a tool call", () => {
  it("is denied with no card for an unknown tool or malformed input", async () => {
    const { startTurn, client, store } = await boot();
    const { permissions } = (await startTurn()).turn;
    for (const body of [
      toolCall("WebFetch", { url: "https://example.com" }),
      toolCall("Bash", "not an object"),
      toolCall("Bash", { command: 7 }),
      toolCall("Read", {}),
      toolCall("Write", { file_path: "a.txt" }),
      toolCall("Write", { file_path: "a.txt", content: 7 }),
      toolCall("Edit", { file_path: "a.txt", old_string: "x" }),
      toolCall("Edit", { file_path: "a.txt", new_string: "y" }),
      toolCall("Edit", {
        file_path: "a.txt",
        old_string: "x",
        new_string: "y",
        replace_all: "yes",
      }),
      rpc("tools/call", { name: "other", arguments: {} }),
    ]) {
      expect(await decisionOf(await mcp(permissions, body))).toMatchObject({ behavior: "deny" });
    }
    expect(client.cards()).toEqual([]);
    expect(store.state().approvals).toEqual([]);
  });

  it("is refused with no card or row when the path is off limits, and audited", async () => {
    const { startTurn, client, store } = await boot();
    const { permissions } = (await startTurn()).turn;
    const file_path = NodePath.join(dataDir, "..", "elsewhere", ".ssh", "id_rsa");
    const decision = await decisionOf(await mcp(permissions, toolCall("Read", { file_path })));
    expect(decision.behavior).toBe("deny");
    expect(decision.message).toContain("off limits");
    expect(client.cards()).toEqual([]);
    expect(store.state().approvals).toEqual([]);
    expect(auditRows()).toEqual([{ tool: "Read", status: "refused", reason: null }]);
  });

  it("is refused on allow when a link swapped in during the hold makes the path off limits", async () => {
    const { startTurn, nextCard, decide } = await boot();
    const { turn, bot } = await startTurn();
    const workspace = NodePath.join(dataDir, "bots", bot.id, "workspace");
    NodeFS.mkdirSync(workspace, { recursive: true });
    const link = NodePath.join(workspace, "swapped");
    const file_path = NodePath.join(link, "beebot.db");
    const call = mcp(turn.permissions, toolCall("Read", { file_path }));
    const card = await nextCard();
    NodeFS.symlinkSync(dataDir, link, "junction");
    await decide(card, "allow");
    expect(await decisionOf(await call)).toMatchObject({ behavior: "deny" });
  });

  it("shows the exact command, waits, and releases the input on allow", async () => {
    const { startTurn, nextCard, decide, store } = await boot();
    const { permissions } = (await startTurn()).turn;
    const call = mcp(permissions, toolCall("Bash", { command }));
    const card = await nextCard();
    expect(card).toMatchObject({ detail: command, canAlwaysAllow: false });
    expect(Date.parse(card.expiresAt)).toBeGreaterThan(Date.now());
    expect(store.state().approvals[0]).toMatchObject({
      tool: "Bash",
      status: "pending",
      digest: inputDigest("Bash", { command }),
    });

    expect((await decide(card, "allow")).status).toBe(200);
    expect(await decisionOf(await call)).toEqual({
      behavior: "allow",
      updatedInput: { command },
    });
    expect(store.state().approvals[0]).toMatchObject({ status: "allowed", reason: "owner" });
    expect(auditRows()).toEqual([{ tool: "Bash", status: "allowed", reason: "owner" }]);
  });

  it.each([
    ["Read", { file_path: "notes.txt" }, "notes.txt"],
    ["Write", { file_path: "a b.txt", content: "x" }, "a b.txt"],
    ["Edit", { file_path: "a.txt", old_string: "x", new_string: "y" }, "a.txt"],
    ["Glob", { pattern: "*.txt", path: "src" }, "*.txt in src"],
    ["Grep", { pattern: "TODO" }, "TODO"],
  ])("describes %s with the model's own strings", async (tool, input, detail) => {
    const { startTurn, nextCard, decide } = await boot();
    const { permissions } = (await startTurn()).turn;
    const call = mcp(permissions, toolCall(tool, input));
    const card = await nextCard();
    expect(card.detail).toBe(detail);
    await decide(card, "deny");
    expect(await decisionOf(await call)).toMatchObject({ behavior: "deny" });
  });

  it.each([
    ["Bash", { command }],
    ["Read", { file_path: "a.txt" }],
    ["Glob", { pattern: "*" }],
    ["Grep", { pattern: "x" }],
  ])("has no change to show for %s", async (tool, input) => {
    const { startTurn, nextCard, decide } = await boot();
    const { permissions } = (await startTurn()).turn;
    const call = mcp(permissions, toolCall(tool, input));
    const card = await nextCard();
    expect(card.change).toBeNull();
    await decide(card, "deny");
    await call;
  });

  describe("that changes a file", () => {
    async function cardFor(tool: string, input: Record<string, unknown>) {
      const { startTurn, nextCard, decide } = await boot();
      const { permissions } = (await startTurn()).turn;
      const call = mcp(permissions, toolCall(tool, input));
      const card = await nextCard();
      await decide(card, "allow");
      const decision = await decisionOf(await call);
      return { change: card.change, decision };
    }

    it("shows what a Write would put in the file", async () => {
      const { change } = await cardFor("Write", { file_path: "a.txt", content: "one\ntwo\n" });
      expect(change).toEqual({
        action: "create",
        removed: null,
        added: "one\ntwo\n",
        hiddenChars: 0,
        replaceAll: false,
      });
    });

    it("shows both sides of an Edit", async () => {
      const input = { file_path: "a.txt", old_string: "old", new_string: "new" };
      expect((await cardFor("Edit", input)).change).toEqual({
        action: "edit",
        removed: "old",
        added: "new",
        hiddenChars: 0,
        replaceAll: false,
      });
    });

    it("says when an Edit replaces every match", async () => {
      const input = { file_path: "a.txt", old_string: "a", new_string: "b", replace_all: true };
      expect((await cardFor("Edit", input)).change?.replaceAll).toBe(true);
    });

    it("cuts at the last newline, leaving no stray carriage return", async () => {
      const line = `${"x".repeat(999)}\r\n`;
      const content = line.repeat(30);
      const { change } = await cardFor("Write", { file_path: "a.txt", content });
      expect(change?.added).toBe(line.repeat(18) + "x".repeat(999));
      expect(change?.hiddenChars).toBe(content.length - (change?.added.length ?? 0));
    });

    it("cuts text with no newlines at the cap, without splitting a surrogate pair", async () => {
      const content = `${"x".repeat(19_999)}😀${"y".repeat(100)}`;
      const { change } = await cardFor("Write", { file_path: "a.txt", content });
      expect(change?.added).toBe("x".repeat(19_999));
      expect(change?.hiddenChars).toBe(102);
    });

    it("never turns long text into an empty-looking card", async () => {
      const content = `\r\n\n${"x".repeat(30_000)}`;
      const { change } = await cardFor("Write", { file_path: "a.txt", content });
      expect(change?.added).toBe(content.slice(0, 20_000));
      expect(change?.hiddenChars).toBe(10_003);
    });

    it("counts what is hidden from both sides of an Edit", async () => {
      const input = {
        file_path: "a.txt",
        old_string: "o".repeat(20_500),
        new_string: "n".repeat(20_001),
      };
      const { change } = await cardFor("Edit", input);
      expect(change?.removed).toHaveLength(20_000);
      expect(change?.added).toHaveLength(20_000);
      expect(change?.hiddenChars).toBe(501);
    });

    it("still releases the whole input on allow when the preview was cut", async () => {
      const input = { file_path: "a.txt", content: "x".repeat(50_000), extra: { kept: true } };
      const { change, decision } = await cardFor("Write", input);
      expect(change?.hiddenChars).toBe(30_000);
      expect(decision).toEqual({ behavior: "allow", updatedInput: input });
    });

    it("tells create from replace, and calls anything else a write", async () => {
      const { startTurn, nextCard, decide } = await boot();
      const { turn, bot } = await startTurn();
      const workspace = workspacePath(dataDir, bot.id);
      NodeFS.mkdirSync(NodePath.join(workspace, "folder"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(workspace, "there.txt"), "before");
      const actionFor = async (file_path: string) => {
        const call = mcp(turn.permissions, toolCall("Write", { file_path, content: "x" }));
        const card = await nextCard();
        await decide(card, "deny");
        await call;
        return card.change?.action;
      };
      expect(await actionFor("new.txt")).toBe("create");
      expect(await actionFor("there.txt")).toBe("replace");
      expect(await actionFor("folder")).toBe("write");
    });

    it("calls it a write, and never throws, when the stat fails", () => {
      expect(writeAction("bad path")).toBe("write");
    });
  });

  it("shows content on the card only: never the database, events, audit log or /state", async () => {
    const mark = "distinctive-content-mark";
    const { startTurn, nextCard, decide, port, store, client, stop } = await boot();
    const { permissions } = (await startTurn()).turn;
    const input = { file_path: "a.txt", old_string: `${mark}-old`, new_string: `${mark}-new` };
    const call = mcp(permissions, toolCall("Edit", input));
    const card = await nextCard();
    expect(card.change?.removed).toContain(mark);

    const state = await fetch(`http://127.0.0.1:${port}/state?protocolVersion=${protocolVersion}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(await state.text()).not.toContain(mark);
    await decide(card, "allow");
    await call;

    expect(JSON.stringify(store.eventsAfter(0))).not.toContain(mark);
    expect(JSON.stringify(rows("SELECT * FROM audit_log"))).not.toContain(mark);
    expect(JSON.stringify(client.messages.filter((m) => m.type === "event"))).not.toContain(mark);
    await stop();
    for (const file of NodeFS.readdirSync(dataDir).filter((name) => name.startsWith("beebot"))) {
      expect(NodeFS.readFileSync(NodePath.join(dataDir, file), "latin1")).not.toContain(mark);
    }
  });

  it("keeps the input out of the database, the events and the logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method),
    );
    const { startTurn, nextCard, decide, stop } = await boot();
    const { permissions } = (await startTurn()).turn;
    const call = mcp(permissions, toolCall("Bash", { command }));
    await decide(await nextCard(), "deny");
    await call;
    await stop();
    const printed = JSON.stringify(spies.map((spy) => spy.mock.calls));
    vi.restoreAllMocks();
    expect(printed).not.toContain(secret);
    for (const file of NodeFS.readdirSync(dataDir).filter((name) => name.startsWith("beebot"))) {
      expect(NodeFS.readFileSync(NodePath.join(dataDir, file), "latin1")).not.toContain(secret);
    }
  });
});

describe("a decision", () => {
  it("is refused when the digest differs, and the card stays open", async () => {
    const { startTurn, nextCard, decide, client } = await boot();
    const { permissions } = (await startTurn()).turn;
    const call = mcp(permissions, toolCall("Bash", { command }));
    const card = await nextCard();
    const refused = await decide(card, "allow", inputDigest("Bash", { command: "rm -rf /" }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ code: "digest_mismatch" });
    expect(client.cards()).toHaveLength(1);
    await decide(card, "deny");
    await call;
  });

  it("is refused the second time, and for an unknown approval", async () => {
    const { startTurn, nextCard, decide } = await boot();
    const { permissions } = (await startTurn()).turn;
    const call = mcp(permissions, toolCall("Bash", { command }));
    const card = await nextCard();
    const digest = inputDigest("Bash", { command });
    expect((await decide(card, "deny", digest)).status).toBe(200);
    const second = await decide(card, "allow", digest);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ code: "approval_closed" });
    expect(await decisionOf(await call)).toMatchObject({ behavior: "deny" });
    const unknown = await decide({ ...card, id: NodeCrypto.randomUUID() }, "allow", digest);
    expect(await unknown.json()).toEqual({ code: "approval_closed" });
  });
});

describe("always allow", () => {
  it.each([
    ["Bash", { command }],
    ["Write", { file_path: "a.txt", content: "x" }],
    ["Edit", { file_path: "a.txt", old_string: "x", new_string: "y" }],
  ])("is refused for %s", async (tool, input) => {
    const { startTurn, nextCard, decide } = await boot();
    const { permissions } = (await startTurn()).turn;
    const call = mcp(permissions, toolCall(tool, input));
    const card = await nextCard();
    expect(card.canAlwaysAllow).toBe(false);
    const refused = await decide(card, "always");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ code: "always_not_allowed" });
    expect(rows("SELECT * FROM bot_tool_grants")).toEqual([]);
    await decide(card, "deny");
    await call;
  });

  it("is refused outside the workspace", async () => {
    const { startTurn, nextCard, decide } = await boot();
    const { permissions } = (await startTurn()).turn;
    const file_path = NodePath.join(dataDir, "..", "elsewhere", "notes.txt");
    const call = mcp(permissions, toolCall("Read", { file_path }));
    const card = await nextCard();
    expect(card.canAlwaysAllow).toBe(false);
    expect((await decide(card, "always")).status).toBe(403);
    await decide(card, "deny");
    await call;
  });

  it("saves the grant before releasing the call, for this bot and tool only", async () => {
    const { startTurn, nextCard, decide, client, store, turns } = await boot();
    const { turn, bot } = await startTurn();
    const read = (file_path: string) => mcp(turn.permissions, toolCall("Read", { file_path }));

    const first = read("notes.txt");
    const card = await nextCard();
    expect(card.canAlwaysAllow).toBe(true);
    expect((await decide(card, "always")).status).toBe(200);
    expect(await decisionOf(await first)).toMatchObject({ behavior: "allow" });
    expect(rows("SELECT bot_id AS botId, tool FROM bot_tool_grants")).toEqual([
      { botId: bot.id, tool: "Read" },
    ]);

    const count = store.state().approvals.length;
    expect(await decisionOf(await read("other.txt"))).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "other.txt" },
    });
    expect(store.state().approvals).toHaveLength(count);
    expect(auditRows().at(-1)).toEqual({ tool: "Read", status: "allowed", reason: "always" });

    const outside = read(NodePath.join(dataDir, "..", "elsewhere", "notes.txt"));
    const outsideCard = await nextCard();
    await decide(outsideCard, "deny");
    expect(await decisionOf(await outside)).toMatchObject({ behavior: "deny" });

    const glob = mcp(turn.permissions, toolCall("Glob", { pattern: "*" }));
    const globCard = await nextCard();
    await decide(globCard, "deny");
    await glob;

    turn.finish({ kind: "completed", text: "done" });
    await vi.waitFor(() => expect(client.cards()).toEqual([]));
    expect(turns).toHaveLength(1);
  });
});

describe("a held call", () => {
  it("is denied when the timeout passes", async () => {
    const { startTurn, store, client } = await boot({ approvalTimeoutMs: 30 });
    const { permissions } = (await startTurn()).turn;
    const call = mcp(permissions, toolCall("Bash", { command }));
    expect(await decisionOf(await call)).toMatchObject({ behavior: "deny" });
    expect(store.state().approvals[0]).toMatchObject({ status: "denied", reason: "timeout" });
    await vi.waitFor(() => expect(client.cards()).toEqual([]));
    expect(auditRows()).toEqual([{ tool: "Bash", status: "denied", reason: "timeout" }]);
  });

  it("spends none of its timeout asleep", async () => {
    const { startTurn, nextCard, store, power } = await boot({ approvalTimeoutMs: 300 });
    const { permissions } = (await startTurn()).turn;
    const call = mcp(permissions, toolCall("Bash", { command }));
    await nextCard();
    power("suspend");
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(store.state().approvals[0]).toMatchObject({ status: "pending" });

    power("resume");
    expect(await decisionOf(await call)).toMatchObject({ behavior: "deny" });
    expect(store.state().approvals[0]).toMatchObject({ status: "denied", reason: "timeout" });
  });

  it.each(["stop-bot", "stop-all"] as const)("is denied by %s", async (type) => {
    const { startTurn, nextCard, store, post } = await boot();
    const { turn, bot } = await startTurn();
    const call = mcp(turn.permissions, toolCall("Bash", { command }));
    await nextCard();
    await post(type === "stop-bot" ? { type, botId: bot.id } : { type });
    expect(await decisionOf(await call)).toMatchObject({ behavior: "deny" });
    expect(store.state().approvals[0]).toMatchObject({ status: "denied", reason: "stopped" });
    await vi.waitFor(() => {
      expect(store.state().runs.find(({ botId }) => botId === bot.id)?.status).toBe("Cancelled");
    });
  });

  it("is denied when its run ends", async () => {
    const { startTurn, nextCard, store } = await boot();
    const { turn } = await startTurn();
    const call = mcp(turn.permissions, toolCall("Bash", { command }));
    await nextCard();
    turn.finish({ kind: "failed" });
    expect(await decisionOf(await call)).toMatchObject({ behavior: "deny" });
    expect(store.state().approvals[0]).toMatchObject({ status: "denied", reason: "stopped" });
  });

  it("is denied when the CLI drops the connection", async () => {
    const { startTurn, nextCard, store, client } = await boot();
    const { permissions } = (await startTurn()).turn;
    const { hostname, port, pathname } = new URL(permissions.url);
    const request = NodeHttp.request({
      host: hostname,
      port,
      path: pathname,
      method: "POST",
      headers: { Authorization: `Bearer ${permissions.token}` },
    });
    request.on("error", () => {});
    request.end(toolCall("Bash", { command }));
    await nextCard();
    request.destroy();
    await vi.waitFor(() => {
      expect(store.state().approvals[0]).toMatchObject({ status: "denied", reason: "stopped" });
    });
    expect(client.cards()).toEqual([]);
  });

  it("reappears for a client that reconnects", async () => {
    const { startTurn, nextCard, port, decide } = await boot();
    const { permissions } = (await startTurn()).turn;
    const call = mcp(permissions, toolCall("Bash", { command }));
    const card = await nextCard();

    const later = connect(port);
    await later.ready;
    expect(later.cards()).toEqual([card]);
    await decide(card, "deny");
    await call;
  });

  it("expires on restart, with an event and an audit row", async () => {
    const first = await boot();
    const { permissions } = (await first.startTurn()).turn;
    const call = mcp(permissions, toolCall("Bash", { command })).catch(() => "dropped" as const);
    await first.nextCard();
    await first.stop();
    await call;
    expect(rows("SELECT status FROM approvals")).toEqual([{ status: "pending" }]);

    const second = await boot();
    expect(second.client.cards()).toEqual([]);
    expect(second.store.state().approvals[0]).toMatchObject({
      status: "expired",
      reason: "server_restarted",
    });
    const events = second.store.eventsAfter(0).filter(({ type }) => type === "approval.changed");
    expect(events.at(-1)).toMatchObject({ approval: { status: "expired" } });
    expect(auditRows().at(-1)).toEqual({
      tool: "Bash",
      status: "expired",
      reason: "server_restarted",
    });
  });
});

describe("the turn timer", () => {
  it("pauses while a card waits and resumes with the time that was left", async () => {
    const { startTurn, nextCard, decide, store } = await boot({ turnTimeoutMs: 400 });
    const { turn, bot } = await startTurn();
    const status = () => store.state().runs.find(({ botId }) => botId === bot.id);
    const call = mcp(turn.permissions, toolCall("Bash", { command }));
    const card = await nextCard();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(status()?.status).toBe("Running");
    await decide(card, "allow");
    await call;
    await vi.waitFor(() => expect(status()?.reason).toBe("timeout"), { timeout: 1000 });
  });
});

describe("the fake engine's /approve", () => {
  const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;

  it("goes through the real gate and never prints the token", async () => {
    const spies = consoleMethods.map((method) => vi.spyOn(console, method));
    const tokens: string[] = [];
    const runTurn: RunTurn = (turn) => {
      tokens.push(turn.permissions.token);
      return fakeRunTurn(turn);
    };
    const { store, post, nextCard, decide, client } = await boot({ runTurn });
    const send = (roomId: string, body: string) =>
      post({ type: "send-message", messageId: NodeCrypto.randomUUID(), roomId, body });
    const bot = (await (
      await post({ type: "create-bot", name: "Fay", personality: "", engineAccountId: "fake" })
    ).json()) as Bot;
    await post({ type: "set-bot-engine", botId: bot.id, access: "supervised" });

    await send(bot.roomId, "/approve Bash npm run build --flag");
    const card = await nextCard();
    expect(card.detail).toBe("npm run build --flag");
    await decide(card, "allow");
    await vi.waitFor(() => expect(store.state().messages).toHaveLength(2));
    expect(store.state().messages[1]).toMatchObject({
      body: "Test engine: allowed",
      tools: ["Bash"],
    });

    await send(bot.roomId, "/approve Read notes.txt");
    const second = await nextCard();
    expect(second.detail).toBe("notes.txt");
    await decide(second, "deny");
    await vi.waitFor(() => expect(store.state().messages).toHaveLength(4));
    expect(store.state().messages[3]?.body).toBe("Test engine: denied");
    expect(client.messages.some((m) => m.type === "tool-start" && m.name === "Read")).toBe(true);

    for (const tool of ["Write", "Edit"]) {
      const count = store.state().messages.length;
      await send(bot.roomId, `/approve ${tool} notes.txt`);
      const change = await nextCard();
      expect(change.change?.added).toBeTruthy();
      await decide(change, "deny");
      await vi.waitFor(() => expect(store.state().messages).toHaveLength(count + 2));
    }

    const printed = JSON.stringify(spies.map((spy) => spy.mock.calls));
    vi.restoreAllMocks();
    expect(tokens).toHaveLength(4);
    for (const token of tokens) {
      expect(printed).not.toContain(token);
      expect(JSON.stringify(client.messages)).not.toContain(token);
    }
  });
});

describe("memory tools", () => {
  it("can't reach another bot's memory, whatever the arguments", async () => {
    const { startTurn, store } = await boot();
    const { bot: ada, turn } = await startTurn();
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    const theirs = store.addMemory({ botId: ben.id, text: "the ben secret", type: "user" });
    store.sendMessage({ id: "ben-1", roomId: ben.roomId, body: "ben secret", attended: false });
    const id = theirs?.id ?? "";
    const missing = NodeCrypto.randomUUID();
    const file = NodePath.join(dataDir, "bots", ben.id, "memory", `${id}.md`);
    const bytes = NodeFS.readFileSync(file, "utf8");
    const answers = async (target: string) => ({
      get: await memoryCall(turn.permissions, "memory_get", { id: target, botId: ben.id }),
      forget: await memoryCall(turn.permissions, "memory_forget", {
        id: target,
        reason: "stale",
        botId: ben.id,
        bot_id: ben.id,
      }),
      replace: await memoryCall(turn.permissions, "memory_propose", {
        text: "overwritten",
        type: "user",
        supersedes: target,
        botId: ben.id,
      }),
    });

    expect(await answers(id)).toEqual(await answers(missing));
    expect((await answers("../../../beebot.db")).get).toBe("Not found.");
    expect(
      await memoryCall(turn.permissions, "memory_search", { query: "secret", botId: ben.id }),
    ).toBe("No results.");
    expect(NodeFS.readFileSync(file, "utf8")).toBe(bytes);
    expect(store.activeMemory(ben.id, id)?.text).toBe("the ben secret");

    const saved = await memoryCall(turn.permissions, "memory_propose", {
      text: "my own",
      type: "user",
      botId: ben.id,
    });
    const ownId = /as (.+)\.$/.exec(saved)?.[1] ?? "";
    expect(store.activeMemory(ada.id, ownId)?.botId).toBe(ada.id);
    expect(store.activeMemory(ben.id, ownId)).toBeUndefined();
  });

  describe("after a tool in the same turn", () => {
    const proposal = { text: "taken from a tool", type: "project" };
    const statusAfterPropose = async (store: EventStore, turn: Turn) => {
      await memoryCall(turn.permissions, "memory_propose", proposal);
      return store.state().memories.find(({ text }) => text === proposal.text)?.status;
    };

    it("a propose lands as pending once the stream shows a tool start", async () => {
      const { startTurn, store } = await boot();
      const { turn } = await startTurn();
      turn.tool("Read");
      expect(await statusAfterPropose(store, turn)).toBe("pending");
    });

    // The race: the stream frame may still be in a pipe, so `approve` alone has to order this.
    it("a propose lands as pending when the stream frame never came, once approve saw the tool", async () => {
      const { startTurn, store, nextCard, decide } = await boot();
      const { turn } = await startTurn();
      const call = mcp(turn.permissions, toolCall("Read", { file_path: "notes.txt" }));
      const card = await nextCard();
      expect(await statusAfterPropose(store, turn)).toBe("pending");
      await decide(card, "allow");
      expect((await decisionOf(await call)).behavior).toBe("allow");
    });

    it("approve marks the scope before it even parses the call", async () => {
      const { startTurn, store } = await boot();
      const { turn } = await startTurn();
      const refused = await mcp(turn.permissions, toolCall("NotATool", {}));
      expect((await decisionOf(refused)).behavior).toBe("deny");
      expect(await statusAfterPropose(store, turn)).toBe("pending");
    });

    it("a failed mark denies the tool", async () => {
      const { startTurn, store, client } = await boot();
      const { turn } = await startTurn();
      const failed = vi.spyOn(store, "markTainted").mockImplementation(() => {
        throw new Error("disk full");
      });
      const call = await mcp(turn.permissions, toolCall("Read", { file_path: "notes.txt" }));
      failed.mockRestore();
      expect((await decisionOf(call)).behavior).toBe("deny");
      expect(client.cards()).toEqual([]);
    });

    it("a memory tool does not taint", async () => {
      const { startTurn, store } = await boot();
      const { turn } = await startTurn();
      turn.tool("mcp__bee__memory_search");
      await memoryCall(turn.permissions, "memory_search", { query: "x" });
      expect(await statusAfterPropose(store, turn)).toBe("active");
    });

    it("forget and supersede only ask, and leave the target active", async () => {
      const { startTurn, store } = await boot();
      const { bot, turn } = await startTurn();
      const target = store.addMemory({ botId: bot.id, text: "keep me", type: "user" });
      const id = target?.id ?? "";
      turn.tool("Bash");

      expect(await memoryCall(turn.permissions, "memory_forget", { id, reason: "stale" })).toBe(
        "Sent to the owner for review.",
      );
      expect(
        await memoryCall(turn.permissions, "memory_propose", {
          text: "replacement",
          type: "user",
          supersedes: id,
        }),
      ).toMatch(/^Sent to the owner for review as /);

      expect(store.activeMemory(bot.id, id)?.text).toBe("keep me");
      expect(
        store
          .state()
          .memories.filter(({ status }) => status === "pending")
          .map(({ sourceRef }) => sourceRef),
      ).toEqual([`forget:${id}`, `supersede:${id}`]);
    });

    it("the taint outlives the turn: a resumed session stays tainted", async () => {
      const { startTurn, store, post, turns } = await boot();
      const { bot, turn } = await startTurn();
      turn.tool("Read");
      turn.finish({ kind: "completed", text: "done" });
      await vi.waitFor(() => expect(store.state().runs[0]?.status).toBe("Completed"));
      await post({
        type: "send-message",
        messageId: NodeCrypto.randomUUID(),
        roomId: bot.roomId,
        body: "again",
      });
      await vi.waitFor(() => expect(turns).toHaveLength(2), { timeout: 3000 });
      expect(await statusAfterPropose(store, turns[1] as Turn)).toBe("pending");
    });
  });

  it("stay out of logs and the audit log, end to end on the fake engine", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const { store, post, client } = await boot({ runTurn: fakeRunTurn });
    const bot = (await (
      await post({ type: "create-bot", name: "Ada", personality: "", engineAccountId: "fake" })
    ).json()) as Bot;
    await post({
      type: "send-message",
      messageId: NodeCrypto.randomUUID(),
      roomId: bot.roomId,
      body: `/remember ${secret}`,
    });

    await vi.waitFor(() => expect(store.state().messages).toHaveLength(2), { timeout: 3000 });
    const [memory] = store.state().memories;
    expect(memory).toMatchObject({ text: secret, status: "active", source: "agent", type: "user" });
    expect(store.state().messages[1]).toMatchObject({
      body: `Saved as ${memory?.id}.`,
      tools: ["mcp__bee__memory_propose"],
    });
    expect(client.messages.some((m) => m.type === "tool-start")).toBe(true);
    expect(JSON.stringify(rows("SELECT * FROM audit_log"))).not.toContain(secret);
    const printed = JSON.stringify(spies.map((spy) => spy.mock.calls));
    vi.restoreAllMocks();
    expect(printed).not.toContain(secret);
  });

  it("answer without the error when the store fails, and log only its kind", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { startTurn } = await boot();
    const { turn } = await startTurn();
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    db.exec("DROP TABLE memory_fts");
    db.close();
    const answer = await memoryCall(turn.permissions, "memory_search", { query: secret });
    const printed = JSON.stringify(errors.mock.calls);
    vi.restoreAllMocks();
    expect(answer).toBe("Memory is unavailable right now.");
    expect(printed).not.toContain(secret);
  });
});

describe("access levels", () => {
  const offLimits = () => NodePath.join(dataDir, "..", "elsewhere", ".ssh", "id_rsa");
  const changeFields = { content: "x", old_string: "x", new_string: "y" };
  const toolInput = (tool: string, where: string): Record<string, unknown> =>
    tool === "Bash"
      ? { command: "ls" }
      : tool === "Glob" || tool === "Grep"
        ? { pattern: "x", path: where }
        : { file_path: NodePath.join(where, "a.txt"), ...changeFields };

  async function atLevel(access: "supervised" | "auto-edits" | "full") {
    const server = await boot();
    const { bot, turn } = await server.startTurn();
    await server.post({ type: "set-bot-engine", botId: bot.id, access });
    return { ...server, bot, turn };
  }

  const tools = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] as const;
  const cases = tools.flatMap((tool) =>
    (["inside", "outside"] as const).flatMap((where) => [
      ["supervised", tool, where, false] as const,
      [
        "auto-edits",
        tool,
        where,
        where === "inside" && (tool === "Write" || tool === "Edit"),
      ] as const,
      ["full", tool, where, true] as const,
    ]),
  );

  it.each(cases)("%s: %s %s the workspace, automatic is %s", async (access, tool, where, auto) => {
    const { bot, turn, decide, nextCard, client } = await atLevel(access);
    const place =
      where === "inside" ? workspacePath(dataDir, bot.id) : NodePath.join(dataDir, "..", "out");
    const call = mcp(turn.permissions, toolCall(tool, toolInput(tool, place)));
    if (auto) {
      expect(await decisionOf(await call)).toMatchObject({ behavior: "allow" });
      expect(client.cards() ?? []).toEqual([]);
      expect(auditRows().at(-1)).toEqual({ tool, status: "allowed", reason: `access:${access}` });
      return;
    }
    await decide(await nextCard(), "deny");
    expect(await decisionOf(await call)).toMatchObject({ behavior: "deny" });
  });

  it.each(["supervised", "auto-edits", "full"] as const)(
    "refuses a forbidden path at %s",
    async (access) => {
      const { turn, client } = await atLevel(access);
      for (const tool of ["Read", "Write", "Edit"]) {
        const input = { file_path: offLimits(), ...changeFields };
        const refused = await decisionOf(await mcp(turn.permissions, toolCall(tool, input)));
        expect(refused).toMatchObject({ behavior: "deny" });
      }
      expect(client.cards() ?? []).toEqual([]);
      expect(auditRows().map(({ status }) => status)).toEqual(["refused", "refused", "refused"]);
    },
  );

  it("applies a lowered level to the next call of a running turn", async () => {
    const { bot, turn, post, nextCard, decide } = await atLevel("full");
    const bash = () => mcp(turn.permissions, toolCall("Bash", { command: "ls" }));
    expect(await decisionOf(await bash())).toMatchObject({ behavior: "allow" });

    await post({ type: "set-bot-engine", botId: bot.id, access: "supervised" });
    const held = bash();
    await decide(await nextCard(), "deny");
    expect(await decisionOf(await held)).toMatchObject({ behavior: "deny" });
  });

  it("never writes the tool input to the audit log", async () => {
    const { turn } = await atLevel("full");
    await mcp(turn.permissions, toolCall("Bash", { command }));
    expect(JSON.stringify(rows("SELECT * FROM audit_log"))).not.toContain(secret);
    expect(auditRows().at(-1)).toEqual({ tool: "Bash", status: "allowed", reason: "access:full" });
  });

  it("asks about everything in a Plan turn, even at full access", async () => {
    const server = await boot();
    const created = await server.post({
      type: "create-bot",
      name: "Ada",
      personality: "",
      engineAccountId: "claude",
    });
    const bot = (await created.json()) as Bot;
    await server.post({ type: "set-bot-engine", botId: bot.id, mode: "plan", access: "full" });
    const before = server.turns.length;
    await server.post({
      type: "send-message",
      messageId: NodeCrypto.randomUUID(),
      roomId: bot.roomId,
      body: "plan",
    });
    await vi.waitFor(() => expect(server.turns.length).toBe(before + 1), { timeout: 3000 });
    const { permissions } = server.turns[before] as Turn;
    const held = mcp(permissions, toolCall("Bash", { command: "rm -rf x" }));
    await server.decide(await server.nextCard(), "deny");
    expect(await decisionOf(await held)).toMatchObject({ behavior: "deny" });
  });

  it("gives full access to attended runs only", async () => {
    const store = openEventStore(dataDir);
    cleanups.push(() => store.close());
    const bot = store.createBot({ name: "Ada", personality: "", engineAccountId: "claude" });
    store.setBotEngine(bot.id, { model: "sonnet", effort: null, mode: "build", access: "full" });
    store.sendMessage({ id: "m", roomId: bot.roomId, body: "hi", attended: false });
    const [wake] = store.dueWakes(new Date().toISOString());
    store.queueRun(wake as NonNullable<typeof wake>);
    const claimed = store.claimRun(
      store.queuedRuns()[0]?.id as string,
      "boot",
      new Date().toISOString(),
    );
    expect(claimed?.attended).toBe(false);

    const approvals = createApprovals({ store, dataDir, onChange: () => {} });
    cleanups.push(() => approvals.close());
    const mode = { attended: false, plan: false };
    approvals.openRun(claimed?.id as string, bot.id, mode);
    const run = { ...mode, id: claimed?.id as string, botId: bot.id, tokenHash: Buffer.alloc(0) };
    const closed = new AbortController();
    const decision = approvals.approve(
      run,
      { tool_name: "Bash", input: { command: "ls" } },
      closed.signal,
    );
    expect(approvals.pending()).toHaveLength(1);
    closed.abort();
    expect(await decision).toMatchObject({ behavior: "deny" });
  });
});

describe("a bot with a project folder", () => {
  let project: string;

  beforeEach(() => {
    project = NodeFS.realpathSync.native(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-project-")),
    );
    cleanups.push(() => NodeFS.rmSync(project, { recursive: true, force: true }));
  });

  async function atLevel(access: "supervised" | "auto-edits" | "full") {
    const server = await boot();
    const { bot, turn } = await server.startTurn("claude", project);
    await server.post({ type: "set-bot-engine", botId: bot.id, access });
    return { ...server, bot, turn };
  }

  const write = (file_path: string) => toolCall("Write", { file_path, content: "x" });

  it("auto-accepts edits in the folder, and asks about the same edit outside it", async () => {
    const { turn, decide, nextCard, client } = await atLevel("auto-edits");
    const file = NodePath.join(project, "src", "a.ts");
    expect(await decisionOf(await mcp(turn.permissions, write(file)))).toMatchObject({
      behavior: "allow",
    });
    expect(client.cards() ?? []).toEqual([]);

    const call = mcp(turn.permissions, write(NodePath.join(dataDir, "..", "out", "a.ts")));
    await decide(await nextCard(), "deny");
    expect(await decisionOf(await call)).toMatchObject({ behavior: "deny" });
  });

  it("resolves a relative Write against the folder to tell create from replace", async () => {
    NodeFS.mkdirSync(NodePath.join(project, "src"));
    NodeFS.writeFileSync(NodePath.join(project, "src", "there.txt"), "before");
    const { turn, decide, nextCard } = await atLevel("supervised");
    const actionFor = async (file_path: string) => {
      const call = mcp(turn.permissions, write(file_path));
      const card = await nextCard();
      await decide(card, "deny");
      await call;
      return card.change?.action;
    };
    expect(await actionFor("src/there.txt")).toBe("replace");
    expect(await actionFor("src/new.txt")).toBe("create");
    expect(await actionFor(NodePath.join(project, "src", "there.txt"))).toBe("replace");
  });

  it("refuses the bot's old private workspace: it is Bee's data now", async () => {
    const { bot, turn } = await atLevel("auto-edits");
    const file = NodePath.join(workspacePath(dataDir, bot.id), "a.ts");
    const answer = await decisionOf(await mcp(turn.permissions, write(file)));
    expect(answer.message).toMatch(/off limits/);
  });

  it.each([".npmrc", NodePath.join(".docker", "config.json")])(
    "asks about %s even at Auto-accept edits",
    async (name) => {
      const { turn, decide, nextCard } = await atLevel("auto-edits");
      const call = mcp(turn.permissions, write(NodePath.join(project, name)));
      const card = await nextCard();
      expect(card.canAlwaysAllow).toBe(false);
      await decide(card, "allow");
      expect(await decisionOf(await call)).toMatchObject({ behavior: "allow" });
    },
  );

  it("offers no Always allow for a credential path, and a grant doesn't reach it", async () => {
    const { turn, bot, store, decide, nextCard } = await atLevel("supervised");
    store.grantTool(bot.id, "Read");
    const file_path = NodePath.join(project, ".npmrc");
    const call = mcp(turn.permissions, toolCall("Read", { file_path }));
    const card = await nextCard();
    expect(card.canAlwaysAllow).toBe(false);
    expect((await decide(card, "always")).status).toBe(403);
    await decide(card, "deny");
    expect(await decisionOf(await call)).toMatchObject({ behavior: "deny" });

    const plain = toolCall("Read", { file_path: NodePath.join(project, "notes.txt") });
    expect(await decisionOf(await mcp(turn.permissions, plain))).toMatchObject({
      behavior: "allow",
    });
  });

  it("keeps Full access as it was: a credential path in the folder doesn't ask", async () => {
    const { turn } = await atLevel("full");
    const answer = await mcp(turn.permissions, write(NodePath.join(project, ".npmrc")));
    expect(await decisionOf(answer)).toMatchObject({ behavior: "allow" });
  });
});

describe("a Box bot's verdict", () => {
  const can = { surface: true, executable: true };

  it("waits only when someone could answer and Bee could act on it", () => {
    expect(boxVerdict({ kind: "approve" }, can)).toEqual({ answer: "wait", kind: "approval" });
    expect(boxVerdict({ kind: "approve" }, { ...can, surface: false })).toEqual({
      answer: "deny",
      message: "Denied: nobody can approve this right now.",
    });
    expect(boxVerdict({ kind: "approve" }, { ...can, executable: false })).toMatchObject({
      answer: "deny",
    });
  });

  it("hands a person's job to the owner, though Bee has no way to do it", () => {
    const handOff = { kind: "hand_off", reason: "payment" } as const;
    expect(boxVerdict(handOff, { ...can, executable: false })).toEqual({
      answer: "wait",
      kind: "hand_off",
    });
    expect(boxVerdict(handOff, { ...can, surface: false })).toMatchObject({ answer: "deny" });
  });

  it("passes the broker's allow and deny straight through", () => {
    expect(boxVerdict({ kind: "allow" }, { surface: false, executable: false })).toEqual({
      answer: "allow",
    });
    expect(boxVerdict({ kind: "deny", reason: "not in the manifest" }, can)).toEqual({
      answer: "deny",
      message: "Refused: not in the manifest",
    });
  });
});

describe("in Box mode a tool call", () => {
  const ask: Decide = ({ labels }) => (labels.sideEffect ? { kind: "approve" } : { kind: "allow" });
  let ran: string[];
  const execute: Execute = async ({ payload }) => {
    ran.push(payload);
    return { ok: true, output: "done" };
  };

  beforeEach(() => {
    ran = [];
  });

  async function boxBoot(options: BootOptions = {}, existing?: Bot) {
    const executors = new Map([
      ["Bash", execute],
      ["Write", execute],
    ]);
    const env = await boot({ runTurn: fakeRunTurn, decide: ask, executors, ...options });
    const bot =
      existing ??
      ((await (
        await env.post({
          type: "create-bot",
          name: "Bo",
          personality: "",
          engineAccountId: "claude",
        })
      ).json()) as Bot);
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    db.prepare("UPDATE bots SET boundary = 'box' WHERE id = ?").run(bot.id);
    db.close();
    const send = (body: string) =>
      env.post({
        type: "send-message",
        messageId: NodeCrypto.randomUUID(),
        roomId: bot.roomId,
        body,
      });
    const bodies = () =>
      env.store
        .state()
        .messages.filter(({ roomId }) => roomId === bot.roomId)
        .map(({ body }) => body);
    const waiting = async () => {
      await vi.waitFor(() => expect(env.store.state().continuations).toHaveLength(1), {
        timeout: 3000,
      });
      return env.store.state().continuations[0] as Continuation;
    };
    const answer = (card: Continuation, decision: "approve" | "deny", digest = card.digest) =>
      env.post({ type: "decide-continuation", continuationId: card.id, digest, decision });
    const lastRun = () => env.store.state().runs.find(({ botId }) => botId === bot.id);
    return { ...env, bot, send, bodies, waiting, answer, lastRun };
  }

  it("ends the turn, then runs the approved action once and resumes the saved session", async () => {
    const { store, bot, client, send, bodies, waiting, answer, lastRun } = await boxBoot();
    await send("/approve Bash echo hi");
    const card = await waiting();
    expect(card).toMatchObject({ kind: "approval", tool: "Bash", shown: "Bash: echo hi" });
    await vi.waitFor(() => expect(lastRun()?.status).toBe("WaitingUser"));
    expect(store.botBusy(bot.id)).toBe(false);
    expect(client.cards()).toEqual([]);

    expect((await answer(card, "approve")).status).toBe(200);
    expect((await answer(card, "approve")).status).toBe(409);
    await vi.waitFor(() =>
      expect(bodies().at(-1)).toMatch(/^Test engine reply: Approved and done/),
    );
    expect(ran).toHaveLength(1);
    expect(JSON.parse(ran[0] ?? "")).toMatchObject({ tool: "Bash", input: { command: "echo hi" } });
    expect(store.state().continuations).toEqual([]);

    await send("/recall");
    await vi.waitFor(() =>
      expect(bodies().at(-1)).toBe("Test engine recalls: /approve Bash echo hi | done"),
    );
  });

  it("tells the bot when the owner denies, and runs nothing", async () => {
    const { send, bodies, waiting, answer } = await boxBoot();
    await send("/approve Bash rm -rf build");
    await answer(await waiting(), "deny");
    await vi.waitFor(() =>
      expect(bodies().slice(-2)).toEqual([
        "Denied:\nBash: rm -rf build",
        "Test engine reply: Denied:\nBash: rm -rf build",
      ]),
    );
    expect(ran).toEqual([]);
  });

  it("refuses an answer to anything but what was shown, and the card stays", async () => {
    const { store, send, waiting, answer } = await boxBoot();
    await send("/approve Bash echo hi");
    const card = await waiting();
    const response = await answer(card, "approve", "something else");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "digest_mismatch" });
    expect(store.state().continuations).toEqual([card]);
  });

  it("is refused at run time when its target changed after the owner saw it", async () => {
    const { bot, send, bodies, waiting, answer } = await boxBoot();
    await send("/approve Write notes.txt");
    const card = await waiting();
    expect(card.shown).toBe("Write: notes.txt\n(create)\n+ Written by the test engine.");
    const workspace = workspacePath(dataDir, bot.id);
    NodeFS.mkdirSync(workspace, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(workspace, "notes.txt"), "the owner's notes\n");
    await answer(card, "approve");
    await vi.waitFor(() =>
      expect(bodies()).toContain(
        `Not run, because it changed after the owner saw it:\n${card.shown}`,
      ),
    );
    expect(ran).toEqual([]);
  });

  it("is denied when nobody answers in time, and a late answer changes nothing", async () => {
    const { send, bodies, waiting, answer } = await boxBoot({ continuationTtlMs: 300 });
    await send("/approve Bash echo hi");
    const card = await waiting();
    await vi.waitFor(
      () => expect(bodies()).toContain("No answer in time, so this was not run:\nBash: echo hi"),
      { timeout: 5000 },
    );
    expect((await answer(card, "approve")).status).toBe(409);
    expect(ran).toEqual([]);
  });

  it("hands a person's job to the owner and never runs it", async () => {
    const handOff: Decide = () => ({ kind: "hand_off", reason: "payment" });
    const { send, bodies, waiting, answer } = await boxBoot({
      decide: handOff,
      executors: new Map(),
    });
    await send("/approve Bash pay invoice 42");
    const card = await waiting();
    expect(card.kind).toBe("hand_off");
    await answer(card, "approve");
    await vi.waitFor(() =>
      expect(bodies()).toContain("The owner did this themselves:\nBash: pay invoice 42"),
    );
    expect(ran).toEqual([]);
  });

  it("can't be run or asked twice by an owner message sent while it waits", async () => {
    const { send, bodies, waiting, answer, lastRun } = await boxBoot();
    await send("/approve Bash echo hi");
    const card = await waiting();
    await vi.waitFor(() => expect(lastRun()?.status).toBe("WaitingUser"));
    await send("Yes, go ahead.");
    await vi.waitFor(() => expect(bodies().at(-1)).toBe("Test engine reply: Yes, go ahead."));
    await send("/approve Bash echo hi");
    await vi.waitFor(() => expect(bodies().at(-1)).toBe("Test engine: waiting"));
    expect(ran).toEqual([]);
    expect(rows("SELECT id FROM continuations")).toEqual([{ id: card.id }]);
    await answer(card, "approve");
    await vi.waitFor(() => expect(bodies().at(-1)).toMatch(/^Test engine reply: Approved/));
    expect(ran).toHaveLength(1);
  });

  it("keeps waiting through a restart, and runs once approved after it", async () => {
    const first = await boxBoot();
    await first.send("/approve Bash echo hi");
    const card = await first.waiting();
    await vi.waitFor(() => expect(first.lastRun()?.status).toBe("WaitingUser"));
    await first.stop();

    const second = await boxBoot({}, first.bot);
    expect(second.store.state().continuations).toEqual([card]);
    await second.answer(card, "approve");
    await vi.waitFor(() => expect(second.bodies().at(-1)).toMatch(/^Test engine reply: Approved/));
    expect(ran).toHaveLength(1);
  });

  it("reports an action cut off by a restart as unknown, and never runs it again", async () => {
    let started = 0;
    const hang: Execute = () => {
      started += 1;
      return new Promise(() => {});
    };
    const first = await boxBoot({ executors: new Map([["Bash", hang]]) });
    await first.send("/approve Bash deploy");
    const card = await first.waiting();
    await first.answer(card, "approve");
    await vi.waitFor(() =>
      expect(rows("SELECT status FROM continuations")).toEqual([{ status: "claimed" }]),
    );
    await first.stop();

    const second = await boxBoot({}, first.bot);
    await vi.waitFor(() =>
      expect(second.bodies()).toContain(
        "Outcome unknown: Bee stopped while running this and did not retry it. Check before trying again:\nBash: deploy",
      ),
    );
    expect(rows("SELECT status FROM continuations")).toEqual([{ status: "unknown" }]);
    expect(started).toBe(1);
    expect(ran).toEqual([]);
  });

  it("answers Claude's PreToolUse hook now: allow, or a deny that waits on the owner", async () => {
    const answers: unknown[] = [];
    let calls = 0;
    const hookTurn: RunTurn = async ({ permissions }) => {
      calls += 1;
      if (calls > 1) {
        return { kind: "completed", text: "resumed" };
      }
      const hook = (tool_name: string, tool_input: object, token = permissions.token) =>
        fetch(new URL("/hooks/pre-tool-use", permissions.url), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }),
        });
      expect((await hook("Bash", { command: "echo hi" }, "wrong")).status).toBe(401);
      for (const [tool, input] of [
        ["Read", { file_path: "notes.txt" }],
        ["Bash", { command: "echo hi" }],
        ["mcp__bee__memory_search", { query: "x" }],
        ["WebFetch", { url: "https://example.com" }],
      ] as const) {
        answers.push(await (await hook(tool, input)).json());
      }
      return { kind: "waiting", text: "waiting" };
    };
    const { send, waiting, answer, bodies } = await boxBoot({ runTurn: hookTurn });
    await send("go");
    const card = await waiting();
    await vi.waitFor(() => expect(answers).toHaveLength(4));
    const decision = (answer: unknown) =>
      (
        answer as {
          hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string };
        }
      ).hookSpecificOutput;
    expect(decision(answers[0])?.permissionDecision).toBe("allow");
    expect(decision(answers[1])).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: waitingMessage(card.id),
    });
    expect(answers[2]).toEqual({});
    expect(decision(answers[3])?.permissionDecision).toBe("deny");
    await answer(card, "approve");
    await vi.waitFor(() => expect(bodies().at(-1)).toBe("resumed"));
    expect(ran).toHaveLength(1);
  });

  it("holds an approved browser action as a continuation, and performs it once", async () => {
    const replies: string[] = [];
    let calls = 0;
    const browserTurn: RunTurn = async ({ permissions }) => {
      calls += 1;
      if (calls > 1) {
        return { kind: "completed", text: "resumed" };
      }
      const call = rpc("tools/call", { name: "browser_click", arguments: { ref: "1:0" } });
      const response = await mcp(permissions, call);
      const { result } = (await response.json()) as { result: { content: [{ text: string }] } };
      replies.push(result.content[0].text);
      return { kind: "waiting", text: "waiting" };
    };
    const performed: string[] = [];
    const click: Execute = async ({ payload }) => {
      performed.push(payload);
      return { ok: true, output: "clicked" };
    };
    const { store, bot, post, send, waiting, answer, bodies } = await boxBoot({
      runTurn: browserTurn,
      decide: policyDecide,
      executors: new Map([["browser_click", click]]),
    });
    await post({ type: "set-bot-manifest", botId: bot.id, manifest: ["browser"] });
    expect(store.getBot(bot.id)?.manifest).toEqual(["browser"]);
    await send("click it");
    const card = await waiting();
    expect(card).toMatchObject({ tool: "browser_click", shown: 'browser_click: {"ref":"1:0"}' });
    expect(replies).toEqual([waitingMessage(card.id)]);
    await answer(card, "approve");
    await vi.waitFor(() => expect(bodies().at(-1)).toBe("resumed"));
    expect(performed.map((payload) => JSON.parse(payload))).toEqual([
      { tool: "browser_click", input: { ref: "1:0" } },
    ]);
  });

  it("refuses a browser tool the bot's manifest doesn't grant", async () => {
    const replies: string[] = [];
    const browserTurn: RunTurn = async ({ permissions }) => {
      const call = rpc("tools/call", { name: "browser_snapshot", arguments: {} });
      const response = await mcp(permissions, call);
      const { result } = (await response.json()) as { result: { content: [{ text: string }] } };
      replies.push(result.content[0].text);
      return { kind: "completed", text: "done" };
    };
    const { send, bodies } = await boxBoot({ runTurn: browserTurn, decide: policyDecide });
    await send("look");
    await vi.waitFor(() => expect(bodies().at(-1)).toBe("done"));
    expect(JSON.parse(replies[0] ?? "")).toMatchObject({
      status: "refused",
      reason: "not_granted",
    });
  });

  it("is closed by a stop, with nothing sent back", async () => {
    const { store, bot, post, send, bodies, waiting, answer } = await boxBoot();
    await send("/approve Bash echo hi");
    const card = await waiting();
    await post({ type: "stop-bot", botId: bot.id });
    await vi.waitFor(() => expect(store.state().continuations).toEqual([]));
    expect((await answer(card, "approve")).status).toBe(409);
    expect(bodies().filter((body) => body.startsWith("Denied"))).toEqual([]);
    expect(ran).toEqual([]);
  });
});
