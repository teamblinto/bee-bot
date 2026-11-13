import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ChatState,
  protocolVersion,
  ServerMessage,
  UsageSummary,
  type UsageWindow,
} from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

import { workspacePath } from "./engine.ts";
import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";
import {
  aggregateUsage,
  claudeRateLimitEventToUpdate,
  claudeUsageResponseToLimits,
  createLimitRefresher,
  createUsageHistory,
  mergeWindows,
  parseTranscriptLine,
  priceTokens,
  projectFolder,
  unavailableProbe,
  type UsageRecord,
  UsageReply,
} from "./usage.ts";

const token = "t".repeat(43);
const auth = { Authorization: `Bearer ${token}` };

let dir: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-usage-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

const at = (ms: number) => new Date(ms).toISOString();
const usage = { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 };

function line(id: string, timestamp: string, fields: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    sessionId: "session",
    requestId: `req-${id}`,
    cwd: "C:/private/project",
    message: {
      id: `msg-${id}`,
      model: "claude-opus-5-5",
      usage: { ...usage, output_tokens: 40 },
      content: [{ type: "text", text: "a private prompt" }],
    },
    ...fields,
  });
}

describe("the transcript parser", () => {
  it("keeps only the named fields", () => {
    const [record] = parseTranscriptLine(line("a", "2026-11-05T10:00:00.000Z")) ?? [];
    expect(record).toEqual({
      timestampMs: Date.parse("2026-11-05T10:00:00.000Z"),
      model: "claude-opus-5-5",
      sessionId: "session",
      dedupeKey: "msg-a:req-a",
      tokens: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40 },
    });
    expect(JSON.stringify(record)).not.toMatch(/private/);
  });

  it("skips synthetic rows and other entry types, and reports a bad line", () => {
    const synthetic = line("a", "2026-11-05T10:00:00.000Z", {
      message: { id: "m", model: "<synthetic>", usage },
    });
    expect(parseTranscriptLine(synthetic)).toEqual([]);
    expect(parseTranscriptLine(JSON.stringify({ type: "user", usage: {} }))).toEqual([]);
    expect(parseTranscriptLine('{"usage": tru')).toBeUndefined();
  });

  it("counts an advisor call as its own record", () => {
    const iterations = [{ type: "advisor_message", model: "claude-fable-5-1", output_tokens: 7 }];
    const records = parseTranscriptLine(
      line("a", "2026-11-05T10:00:00.000Z", {
        message: { id: "m", model: "claude-opus-5-5", usage: { ...usage, iterations } },
      }),
    );
    expect(records?.map(({ model }) => model)).toEqual(["claude-opus-5-5", "claude-fable-5-1"]);
  });
});

describe("aggregation", () => {
  const now = Date.parse("2026-11-06T12:00:00");
  const record = (fields: Partial<UsageRecord>): UsageRecord => ({
    timestampMs: now - 3_600_000,
    model: "claude-opus-5-5",
    sessionId: "s",
    dedupeKey: null,
    tokens: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
    ...fields,
  });

  it("drops repeats across files and adds up by model, bot and day", () => {
    const repeated = record({ dedupeKey: "m:r" });
    const summary = aggregateUsage(
      [
        { botId: "ada", records: [repeated, repeated] },
        { botId: null, records: [repeated, record({ model: "gpt-unknown", sessionId: "t" })] },
      ],
      7,
      now,
    );
    expect(summary.duplicatesDropped).toBe(2);
    expect(summary.totals).toMatchObject({
      input: 2_000_000,
      costUsd: 4,
      unpricedTokens: 1_000_000,
      sessions: 2,
    });
    expect(summary.bots.map(({ botId, input }) => [botId, input])).toEqual([
      ["ada", 1_000_000],
      [null, 1_000_000],
    ]);
    expect(summary.series).toHaveLength(7);
    expect(summary.series.at(-1)?.input).toBe(2_000_000);
  });

  it("leaves out what is older than the window, and gives hours for one day", () => {
    const summary = aggregateUsage(
      [{ botId: null, records: [record({ timestampMs: now - 3 * 86_400_000 })] }],
      1,
      now,
    );
    expect(summary.totals.input).toBe(0);
    expect(summary.series).toHaveLength(24);
  });

  it("prices known models, whatever their suffix, and nothing else", () => {
    const tokens = {
      input: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
      output: 1_000_000,
    };
    expect(priceTokens("claude-opus-5-5", tokens)).toBeCloseTo(4 + 0.2 + 5 + 20);
    expect(priceTokens("claude-sonnet-5[1m]", tokens)).toBe(priceTokens("claude-sonnet-5", tokens));
    expect(priceTokens("sonnet", tokens)).toBeNull();
  });
});

describe("transcript history", () => {
  const today = at(Date.now() - 60_000);
  const write = (folder: string, name: string, lines: string[]) => {
    NodeFS.mkdirSync(NodePath.join(dir, folder), { recursive: true });
    const path = NodePath.join(dir, folder, name);
    NodeFS.writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  };

  it("attributes a folder to its bot and everything else to outside Bee", async () => {
    const dataDir = NodePath.join("D:", "data");
    const folder = projectFolder(workspacePath(dataDir, "ada"));
    write(folder, "a.jsonl", [line("a", today), 'not json "usage"']);
    write("D--somewhere-else", "b.jsonl", [line("b", today)]);
    const summary = await createUsageHistory(dir).summary(7, new Map([[folder, "ada"]]));
    if (summary.status !== "ok") {
      throw new Error("expected a summary");
    }
    expect(summary.bots.map(({ botId }) => botId).toSorted()).toEqual(["ada", null].toSorted());
    expect(summary.skippedLines).toBe(1);
    expect(JSON.stringify(summary)).not.toMatch(/private/);
  });

  it("reads a file again only when its size or time changed", async () => {
    const path = write("p", "a.jsonl", [line("a", today)]);
    const history = createUsageHistory(dir);
    const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
    NodeFS.utimesSync(path, stamp, stamp);
    await history.summary(7, new Map());
    // Same size and time, other bytes: only a cache hit still reads the old count.
    const changed = NodeFS.readFileSync(path, "utf8").replace(":10,", ":99,");
    NodeFS.writeFileSync(path, changed);
    NodeFS.utimesSync(path, stamp, stamp);
    expect(await history.summary(7, new Map())).toMatchObject({ totals: { input: 10 } });
    NodeFS.appendFileSync(
      path,
      `${line("b", today)}
`,
    );
    expect(await history.summary(7, new Map())).toMatchObject({ totals: { input: 109 } });
  });

  it("is unavailable when the folder is missing", async () => {
    const history = createUsageHistory(NodePath.join(dir, "missing"));
    expect(await history.summary(7, new Map())).toEqual({ status: "unavailable" });
  });
});

describe("limit rows", () => {
  const reply = UsageReply.parse({
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 43, resets_at: "2026-11-06T06:40:00.580945+00:00" } },
  });
  const probed = claudeUsageResponseToLimits(reply).windows;

  it("reads 0-1 from the stream and 0-100 from the reply as the same percentage", () => {
    const updates = claudeRateLimitEventToUpdate({
      rateLimitType: "five_hour",
      utilization: 0.43,
      resetsAt: 1793947200,
    });
    expect(mergeWindows([], updates)[0]?.usedPercent).toBe(probed[0]?.usedPercent);
  });

  it("keeps status and reset time from an event with no utilization", () => {
    const updates = claudeRateLimitEventToUpdate({
      rateLimitType: "five_hour",
      status: "allowed_warning",
      resetsAt: 1793947200,
    });
    expect(mergeWindows(probed, updates)).toEqual<UsageWindow[]>([
      {
        ...(probed[0] as UsageWindow),
        usedPercent: 43,
        status: "allowed_warning",
        resetsAt: "2026-11-06T06:40:00.000Z",
      },
    ]);
    const unknown = mergeWindows([], updates)[0];
    expect(unknown?.usedPercent).toBeNull();
  });

  it("ignores a bucket it has no row for, and lands an overage one on the model's row", () => {
    const fable = { ...(probed[0] as UsageWindow), id: "seven_day_fable", usedPercent: 0 };
    const update = { usedPercent: 9, resetsAt: null, status: null };
    expect(mergeWindows([], [{ ...update, id: "seven_day_overage_included" }])).toEqual([]);
    expect(mergeWindows([], [{ ...update, id: "promo_unknown" }])).toEqual([]);
    expect(
      mergeWindows([fable], [{ ...update, id: "seven_day_overage_included" }])[0]?.usedPercent,
    ).toBe(9);
  });

  it("spend shows only when enabled", () => {
    const parse = (spend: unknown) =>
      claudeUsageResponseToLimits(
        UsageReply.parse({ rate_limits_available: true, rate_limits: { spend } }),
      ).windows;
    const money = (amount: number) => ({ amount_minor: amount, currency: "USD", exponent: 2 });
    expect(parse({ enabled: false, used: money(0), limit: null })).toEqual([]);
    expect(parse({ enabled: true, used: money(25), limit: money(100) })[0]).toMatchObject({
      id: "monthly_spend",
      label: "Monthly spend",
      usedPercent: 25,
    });
  });
});

describe("the limit refresher", () => {
  function refresher(running = false, minGapMs?: number) {
    const saved: unknown[] = [];
    const probe = vi.fn(async () => unavailableProbe("probeFailed"));
    const limits = createLimitRefresher({
      store: { accountRunning: () => running, saveUsage: (_, result) => saved.push(result) },
      probe,
      onSettled: () => {},
      minGapMs,
    });
    return { limits, probe, saved };
  }

  it("refuses during a run on the account", async () => {
    const { limits, probe } = refresher(true);
    expect(await limits.refresh("claude")).toBe("busy");
    expect(probe).not.toHaveBeenCalled();
  });

  it("asks at most once a minute", async () => {
    const { limits, probe } = refresher();
    expect(await limits.refresh("claude")).toBe("refreshed");
    expect(await limits.refresh("claude")).toBe("throttled");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("never asks for an account that has no CLI", async () => {
    const { limits, probe } = refresher();
    expect(await limits.refresh("fake")).toBe("unavailable");
    expect(probe).not.toHaveBeenCalled();
  });

  it("stores a thrown probe as unavailable", async () => {
    const saved: unknown[] = [];
    const limits = createLimitRefresher({
      store: { accountRunning: () => false, saveUsage: (_, result) => saved.push(result) },
      probe: () => Promise.reject(new Error("boom")),
      onSettled: () => {},
    });
    await limits.refresh("claude");
    expect(saved).toEqual([unavailableProbe("probeFailed")]);
  });
});

async function boot(probeUsage = async () => unavailableProbe("probeFailed")) {
  const store = openEventStore(dir);
  const server = await startServer({
    port: 0,
    token,
    dataDir: dir,
    allowedOrigins: [],
    store,
    probeEngine: async () => ({
      cliFound: true,
      version: "2.1.318",
      auth: "authenticated" as const,
      email: null,
      pauseReason: null,
    }),
    probeUsage,
    projectsDir: NodePath.join(dir, "projects"),
  });
  cleanups.push(async () => {
    await server.close();
    store.close();
  });
  return { store, base: `http://127.0.0.1:${server.port}`, port: server.port };
}

describe("the usage routes", () => {
  const query = `protocolVersion=${protocolVersion}`;

  it("sits behind the token and the protocol check", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/usage?days=7&${query}`)).status).toBe(401);
    const old = await fetch(`${base}/usage?days=7&protocolVersion=1`, { headers: auth });
    expect(old.status).toBe(426);
    expect(await old.json()).toMatchObject({ code: "protocol_mismatch" });
  });

  it("refuses a window it doesn't offer, and is unavailable with no folder", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/usage?days=8&${query}`, { headers: auth })).status).toBe(400);
    const response = await fetch(`${base}/usage?days=7&${query}`, { headers: auth });
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  it("counts a bot's private and project folders to it, and nothing else", async () => {
    const { base, store } = await boot();
    const project = NodePath.join(dir, "app");
    NodeFS.mkdirSync(project);
    const bot = store.createBot({
      name: "Ada",
      personality: "",
      engineAccountId: "claude",
      projectPath: project,
    });
    const folders = [
      projectFolder(workspacePath(dir, bot.id)),
      projectFolder(project),
      "D--somewhere-else",
    ];
    folders.forEach((folder, index) => {
      const path = NodePath.join(dir, "projects", folder);
      NodeFS.mkdirSync(path, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(path, "a.jsonl"),
        `${line(String(index), at(Date.now() - 60_000), { requestId: `r${index}` })}\n`,
      );
    });
    const response = await fetch(`${base}/usage?days=7&${query}`, { headers: auth });
    const summary = UsageSummary.parse(await response.json());
    if (summary.status !== "ok") {
      throw new Error("expected a summary");
    }
    const inputs = Object.fromEntries(summary.bots.map((row) => [row.botId, row.input]));
    expect(inputs[bot.id]).toBe(usage.input_tokens * 2);
    expect(inputs["null"]).toBe(usage.input_tokens);
  });

  it("stores a failed check as unavailable, without pausing any bot", async () => {
    const { store, base, port } = await boot();
    const bot = store.createBot({ name: "Ada", personality: "", engineAccountId: "claude" });
    const params = new URLSearchParams({ protocolVersion: String(protocolVersion), token });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${params}`);
    cleanups.push(() => socket.terminate());
    const messages: ServerMessage[] = [];
    socket.on("message", (data) => messages.push(ServerMessage.parse(JSON.parse(String(data)))));
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: "subscribe", afterSeq: 0 }));
    await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));

    const response = await fetch(`${base}/usage/limits?${query}`, {
      method: "POST",
      headers: auth,
    });
    expect(await response.json()).toEqual({ outcome: "refreshed" });

    const state = ChatState.parse(store.state());
    expect(state.usageLimits).toMatchObject([
      { accountId: "claude", windows: [], unavailable: { reason: "probeFailed" } },
    ]);
    expect(state.bots.find(({ id }) => id === bot.id)?.status).toBe("ready");
    await vi.waitFor(() =>
      expect(messages.some((m) => m.type === "event" && m.event.type === "usage.changed")).toBe(
        true,
      ),
    );
  });

  it("keeps the last good rows when a later check fails", async () => {
    const { store } = await boot();
    const window: UsageWindow = {
      id: "five_hour",
      kind: "session",
      label: "Session",
      windowDurationMins: 300,
      usedPercent: 43,
      resetsAt: null,
      status: null,
    };
    store.saveUsage("claude", { windows: [window], unavailable: null });
    store.saveUsage("claude", unavailableProbe("probeFailed"));
    expect(store.state().usageLimits[0]).toMatchObject({
      windows: [window],
      unavailable: { reason: "probeFailed" },
    });
  });
});

it("server code names no credentials path and no vendor endpoint", () => {
  const banned =
    /\.credentials|keychain|secret-tool|(?<!connectors\/)oauth\/|api\.anthropic|anthropic\.com|claude\.ai\/|https?:\/\/(?!127\.0\.0\.1|\$\{proxyHost\})/i;
  const sources = NodeFS.readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => [name, NodeFS.readFileSync(NodePath.join(import.meta.dirname, name), "utf8")]);
  expect(sources.length).toBeGreaterThan(5);
  for (const [name, source] of sources) {
    expect(banned.exec(source ?? "")?.[0], name).toBeUndefined();
  }
});
