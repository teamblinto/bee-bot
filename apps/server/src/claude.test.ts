import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Effort, type EngineLane, EngineStatus } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  boxTurnArgs,
  childEnv,
  createClaudeRunTurn,
  createClaudeSummarize,
  mcpServers,
  modelsFromInitialize,
  probeEngine,
  probeUsage,
  staticClaudeModels,
  tokenMeter,
  turnArgs,
  writeMcpConfig,
} from "./claude.ts";
import {
  type BotLaunch,
  type EngineChoice,
  type Steer,
  type ThinkingState,
  toolDetail,
  type ToolStart,
} from "./engine.ts";
import type { WindowUpdate } from "./usage.ts";
import { createAwakeClock } from "./watchdog.ts";

const plain: EngineChoice = { model: "sonnet", effort: null, mode: "build" };
const fakeCli = NodePath.join(import.meta.dirname, "fixtures", "claude", "fake-claude.mjs");
const launch: BotLaunch = {
  botId: "7f0f6a55-5a4c-4c37-9d0b-2f3c1d2e6b10",
  name: "Ada",
  personality: "Terse.",
  engineAccountId: "claude",
  lane: "subscription",
  model: "opus",
  effort: null,
  mode: "build",
  control: "none",
  projectPath: null,
  memory: "",
  skills: [],
  skillsDir: "/skills",
  connectors: [],
};
const prompt = "the owner's private question";
const permissions = { url: "http://127.0.0.1:9/mcp", token: "run-token-that-must-stay-secret" };
const noComputer =
  "You have no web browser or computer to use. If a task needs one, tell the owner.";

let dataDir: string;
let logPath: string;
let clock = createAwakeClock();
const plantedEnv: string[] = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-claude-"));
  logPath = NodePath.join(dataDir, "fake-cli.log");
  clock = createAwakeClock();
});

afterEach(async () => {
  for (const name of plantedEnv.splice(0)) {
    delete process.env[name];
  }
  // Windows locks a killed child's cwd for a few ms after it reports exited, as Access Denied,
  // which rmSync's maxRetries does not retry.
  await vi.waitFor(() => NodeFS.rmSync(dataDir, { recursive: true, force: true }));
});

function plantEnv(name: string, value: string) {
  plantedEnv.push(name);
  process.env[name] = value;
}

// The fake CLI reads its test inputs from a file beside its log, not from the scrubbed environment.
function fakeInput(name: string, value: string) {
  const path = `${logPath}.input.json`;
  const inputs = NodeFS.existsSync(path) ? JSON.parse(NodeFS.readFileSync(path, "utf8")) : {};
  NodeFS.writeFileSync(path, JSON.stringify({ ...inputs, [name]: value }));
}

const fakeCommand = (scenario: string) => [process.execPath, fakeCli, scenario, logPath];

type LogEntry = {
  pid?: number;
  args?: string[];
  cwd?: string;
  env?: string[];
  prompt?: string;
  mcpConfig?: string;
  control?: string;
  loadedEnv?: string[];
};

function cliLog(): LogEntry[] {
  return NodeFS.existsSync(logPath)
    ? NodeFS.readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as LogEntry)
    : [];
}

const spawns = () => cliLog().filter(({ pid }) => pid !== undefined);
const prompts = () => cliLog().flatMap((entry) => entry.prompt ?? []);

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function turn(
  scenario: string,
  signal = new AbortController().signal,
  resume = false,
  memory = "",
  projectPath: string | null = null,
  lane: EngineLane = "subscription",
  onSteerable?: (steer: Steer) => void,
) {
  const deltas: string[] = [];
  const tools: string[] = [];
  const toolIds = new Set<string>();
  const starts: ToolStart[] = [];
  const ends: Array<{ id: string; failed: boolean }> = [];
  const thinking: ThinkingState[] = [];
  const rateLimits: WindowUpdate[] = [];
  let delivered = 0;
  const outcome = createClaudeRunTurn({ command: fakeCommand(scenario), dataDir, clock })({
    approve: async () => ({ behavior: "deny", message: "unused" }),
    prompt,
    sessionId: "00000000-0000-4000-8000-000000000009",
    resume,
    launch: { ...launch, memory, projectPath, lane },
    signal,
    onDelta: (text) => deltas.push(text),
    onToolStart: ({ id, name, detail }) => {
      if (!toolIds.has(id)) {
        tools.push(name);
      }
      toolIds.add(id);
      starts.push({ id, name, detail });
    },
    onToolEnd: (id, failed) => ends.push({ id, failed }),
    onThinking: (state) => thinking.push(state),
    onRateLimit: (updates) => rateLimits.push(...updates),
    permissions,
    onDelivered: () => {
      delivered += 1;
    },
    ...(onSteerable && { onSteerable }),
  });
  return { outcome, deltas, tools, starts, ends, thinking, rateLimits, delivered: () => delivered };
}

describe("probeUsage", () => {
  const probe = (scenario: string) => probeUsage(fakeCommand(scenario), dataDir);

  it("maps a real reply to rows and drops everything else", async () => {
    const result = await probe("usage");
    expect(result).toEqual({
      unavailable: null,
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 43,
          resetsAt: "2026-11-06T06:40:00.580Z",
          status: null,
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          windowDurationMins: 10_080,
          usedPercent: 72,
          resetsAt: "2026-11-08T08:00:00.580Z",
          status: null,
        },
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          windowDurationMins: 10_080,
          usedPercent: 0,
          resetsAt: "2026-11-08T08:00:00.000Z",
          status: null,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/behaviors|subscription|example-agent|breakdown/);
  });

  it("never writes a user message, and uses the turn's flags with no tools", async () => {
    await probe("usage");
    expect(prompts()).toEqual([]);
    expect(cliLog().flatMap((entry) => entry.control ?? [])).toEqual(["initialize", "get_usage"]);
    const args = spawns()[0]?.args ?? [];
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
  });

  it("is unavailable on a changed shape, an error or a reply with no limits", async () => {
    expect(await probe("usage-shape")).toMatchObject({ unavailable: { reason: "probeFailed" } });
    expect(await probe("usage-error")).toMatchObject({ unavailable: { reason: "probeFailed" } });
    expect(await probe("usage-none")).toMatchObject({ unavailable: { reason: "unsupported" } });
  });

  it("applies the turn's gate before asking", async () => {
    expect(await probe("gate-api-key")).toMatchObject({ unavailable: { reason: "unsupported" } });
    expect(cliLog().flatMap((entry) => entry.control ?? [])).not.toContain("get_usage");
  });

  it("gives up and kills the CLI by PID on a timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = probe("usage-silent");
      await vi.waitFor(
        () => expect(cliLog().flatMap((e) => e.control ?? [])).toContain("get_usage"),
        { timeout: 10_000 },
      );
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await pending).toMatchObject({ unavailable: { reason: "probeFailed" } });
    } finally {
      vi.useRealTimers();
    }
    expect(isAlive(spawns()[0]?.pid ?? 0)).toBe(false);
  });
});

describe("toolDetail", () => {
  const cwd = NodePath.join("data", "workspace");

  it("keeps one short line, relative to the workspace", () => {
    const inside = NodePath.join(cwd, "src", "a.ts");
    expect(toolDetail("Read", { file_path: inside }, cwd)).toBe(NodePath.join("src", "a.ts"));
    expect(toolDetail("Bash", { command: "a\n   b" }, cwd)).toBe("a b");
    expect(toolDetail("Bash", { command: "x".repeat(500) }, cwd)).toHaveLength(120);
  });

  it("gives nothing for tools it doesn't know or input it can't read", () => {
    expect(toolDetail("mcp__bee__memory_propose", { text: "private" }, cwd)).toBeNull();
    expect(toolDetail("constructor", {}, cwd)).toBeNull();
    expect(toolDetail("Bash", { command: 7 }, cwd)).toBeNull();
    expect(toolDetail("Bash", undefined, cwd)).toBeNull();
  });
});

describe("tokenMeter", () => {
  it("prices each message's highest counts at the ceiling, once per message", () => {
    const meter = tokenMeter();
    meter.see("msg_1", { input_tokens: 1000, cache_read_input_tokens: 10_000, output_tokens: 1 });
    // message_delta carries no id and the running output count.
    meter.see(undefined, { output_tokens: 500 });
    meter.see("msg_1", { input_tokens: 1000, output_tokens: 200 });
    meter.see("msg_2", { input_tokens: 2000, output_tokens: 100, service_tier: "standard" });
    meter.see("msg_3", "not usage");
    // (3000 * 16 + 600 * 80 + 10000 * 1.6) / 1e6
    expect(meter.ceilingUsd()).toBeCloseTo(0.112, 9);
  });
});

describe("a turn", () => {
  it("streams text and completes from the result, writing the prompt once", async () => {
    const { outcome, deltas, delivered } = turn("success");
    expect(await outcome).toEqual({ kind: "completed", text: "noted" });
    expect(deltas.join("")).toBe("noted");
    expect(prompts()).toEqual([prompt]);
    expect(delivered()).toBe(1);
  });

  it("reports thinking with no text when the CLI hides the thought", async () => {
    const { outcome, thinking } = turn("thinking");
    await outcome;
    expect(thinking).toEqual([
      { active: true, text: "" },
      { active: false, text: "" },
    ]);
  });

  it("passes thought text on when the CLI sends it", async () => {
    const { outcome, thinking } = turn("thought-text");
    await outcome;
    expect(thinking).toEqual([
      { active: true, text: "" },
      { active: true, text: "Weighing it" },
      { active: false, text: "" },
    ]);
  });

  it("reports each tool once by id, with a short detail and its failure state", async () => {
    const { outcome, tools, starts, ends } = turn("tool-detail");
    await outcome;
    expect(tools).toEqual(["Bash", "Read"]);
    expect(starts).toEqual([
      { id: "toolu_1", name: "Bash", detail: null },
      { id: "toolu_1", name: "Bash", detail: "cat ~/secret-input.txt" },
      { id: "toolu_2", name: "Read", detail: null },
      { id: "toolu_2", name: "Read", detail: "notes.md" },
    ]);
    expect(ends).toEqual([
      { id: "toolu_1", failed: true },
      { id: "toolu_2", failed: false },
    ]);
  });

  it("reads limit rows from the stream's 0-1 values, and keeps status without one", async () => {
    const { outcome, rateLimits } = turn("thinking");
    await outcome;
    expect(rateLimits).toEqual([
      {
        id: "five_hour",
        usedPercent: null,
        resetsAt: "2026-11-05T21:30:00.000Z",
        status: "allowed",
      },
    ]);
    const unified = turn("rate-unified");
    await unified.outcome;
    expect(unified.rateLimits.map(({ id, usedPercent }) => [id, usedPercent])).toEqual([
      ["five_hour", 43],
      ["seven_day", 71],
    ]);
  });

  it("streams text deltas only, not thinking", async () => {
    const { outcome, deltas } = turn("thinking");
    const result = await outcome;
    expect(result.kind).toBe("completed");
    expect(result).toEqual({ kind: "completed", text: deltas.join("") });
  });

  it("regenerates the persona file and keeps the bot in its own directory", async () => {
    await turn("success").outcome;
    const args = spawns()[0]?.args ?? [];
    const personaPath = args[args.indexOf("--append-system-prompt-file") + 1] ?? "";
    expect(personaPath.startsWith(NodePath.join(dataDir, "bots", launch.botId))).toBe(true);
    const persona = NodeFS.readFileSync(personaPath, "utf8");
    expect(persona).toContain("Your name is Ada.");
    expect(persona).toContain("Terse.");
    expect(persona).not.toContain("no tools");

    NodeFS.writeFileSync(personaPath, "stale");
    await turn("success").outcome;
    expect(NodeFS.readFileSync(personaPath, "utf8")).toContain("Terse.");
  });

  it("appends the memory primer to the persona file, and nothing when there is none", async () => {
    const personaPath = NodePath.join(dataDir, "bots", launch.botId, "persona.md");
    await turn("success", undefined, false, "[Saved memory]\n- likes tea").outcome;
    expect(NodeFS.readFileSync(personaPath, "utf8")).toBe(
      `Your name is Ada.\n\nTerse.\n\n[Saved memory]\n- likes tea\n\n${noComputer}`,
    );
    await turn("success").outcome;
    expect(NodeFS.readFileSync(personaPath, "utf8")).toBe(
      `Your name is Ada.\n\nTerse.\n\n${noComputer}`,
    );
  });

  it("passes the prompt on stdin only, with no banned flag", async () => {
    await turn("success").outcome;
    const args = spawns()[0]?.args ?? [];
    expect(args.join(" ")).not.toContain(prompt);
    expect(args.join(" ")).not.toMatch(
      /--bare|--safe-mode|--dangerously|bypassPermissions|--permission-mode/,
    );
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--system-prompt-snapshot") + 1]).toBe("off");
  });

  it("runs the bot's model with the six tools behind the permission tool", async () => {
    await turn("success").outcome;
    const args = spawns()[0]?.args ?? [];
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag("--model")).toBe("opus");
    expect(flag("--tools")).toBe("Read,Write,Edit,Glob,Grep,Bash");
    expect(flag("--permission-prompt-tool")).toBe("mcp__bee__approve");
    expect(JSON.parse(flag("--settings") ?? "")).toEqual({
      plansDirectory: ".plans",
      permissions: {
        ask: ["Bash", "Read", "Glob", "Grep"],
        allow: [
          "mcp__bee__memory_search",
          "mcp__bee__memory_get",
          "mcp__bee__memory_propose",
          "mcp__bee__memory_forget",
          "mcp__bee__send_message",
          "mcp__bee__notify",
          "mcp__bee__delegate",
          "mcp__bee__handoff",
          "mcp__bee__read_bot_activity",
          "mcp__bee__ask_user",
          "mcp__bee__create_routine",
          "mcp__bee__share_file",
          "mcp__bee__follow_up",
          "mcp__bee__task_status",
          "mcp__bee__browser_navigate",
          "mcp__bee__browser_snapshot",
          "mcp__bee__browser_click",
          "mcp__bee__browser_type",
          "mcp__bee__browser_back",
          "mcp__bee__request_takeover",
          "mcp__bee__computer_screenshot",
          "mcp__bee__computer_click",
          "mcp__bee__computer_type",
          "mcp__bee__computer_key",
          "mcp__bee__computer_scroll",
          "mcp__bee__computer_drag",
          "mcp__bee__computer_windows",
          "mcp__bee__computer_open",
          "mcp__bee__computer_look",
          "mcp__bee__computer_desktop",
          "mcp__bee__computer_window_click",
          "mcp__bee__computer_window_type",
          "mcp__bee__computer_window_key",
          "mcp__bee__computer_window_scroll",
          "mcp__bee__computer_window_drag",
        ],
      },
    });
  });

  it("mounts the connectors server, allowed as a whole, only for a bot with a grant", () => {
    const flag = (list: string[], name: string) => list[list.indexOf(name) + 1] ?? "";
    const allow = (list: string[]) => JSON.parse(flag(list, "--settings")).permissions.allow;
    expect(allow(turnArgs("p", "s", false, plain, "c"))).not.toContain("mcp__connectors");
    const granted = { ...plain, connectors: ["Notion"] };
    expect(allow(turnArgs("p", "s", false, granted, "c"))).toContain("mcp__connectors");

    const urls = {
      mcp: "http://proxy/bee/mcp",
      hook: "h",
      connectors: "http://proxy/bee/mcp/connectors",
    };
    const box = (choice: EngineChoice & { connectors?: string[] }) => {
      const args = boxTurnArgs("p", "s", false, choice, urls);
      return {
        tools: flag(args, "--allowedTools"),
        config: JSON.parse(flag(args, "--mcp-config")),
      };
    };
    expect(box(plain).tools.split(",")).not.toContain("mcp__connectors");
    expect(Object.keys(box(plain).config.mcpServers)).toEqual(["bee"]);
    expect(box(granted).tools.split(",")).toContain("mcp__connectors");
    expect(box(granted).config.mcpServers.connectors).toEqual({
      type: "http",
      timeout: 900_000,
      url: urls.connectors,
      headers: { Authorization: "Bearer ${BEE_RUN_TOKEN}" },
    });

    const host = mcpServers(
      "http://127.0.0.1:1/mcp",
      "http://127.0.0.1:1/mcp/connectors",
      "Bearer x",
    );
    expect(Object.keys(host)).toEqual(["bee", "connectors"]);
    expect(host.connectors?.url).toBe("http://127.0.0.1:1/mcp/connectors");
  });

  it("starts a session by ID and continues it with --resume", () => {
    expect(turnArgs("p", "s", false, plain, "c").slice(-2)).toEqual(["--session-id", "s"]);
    expect(turnArgs("p", "s", true, plain, "c").slice(-2)).toEqual(["--resume", "s"]);
  });

  describe.each([
    ["a new session", false],
    ["a resumed session", true],
  ])("on %s", (_, resume) => {
    const args = (choice: Partial<EngineChoice>) =>
      turnArgs("p", "s", resume, { ...plain, ...choice }, "c");
    const flag = (list: string[], name: string) =>
      list.includes(name) ? list[list.indexOf(name) + 1] : undefined;

    it.each(["fable", "opus", "claude-sonnet-4-6"])("passes the model %s", (model) => {
      expect(flag(args({ model }), "--model")).toBe(model);
    });

    it.each(Effort.options)("passes the effort %s", (effort) => {
      expect(flag(args({ effort }), "--effort")).toBe(effort);
    });

    it("adds --effort and --permission-mode only when they are set", () => {
      expect(args({})).not.toContain("--effort");
      expect(args({})).not.toContain("--permission-mode");
      expect(flag(args({ mode: "plan" }), "--permission-mode")).toBe("plan");
    });

    it("never hands approvals to the CLI", () => {
      const all = [args({}), args({ mode: "plan", effort: "max" })].flat();
      for (const banned of ["bypassPermissions", "acceptEdits", "auto", "dontAsk"]) {
        expect(all).not.toContain(banned);
      }
      expect(all.join(" ")).not.toMatch(/dangerously/);
    });
  });

  it("reports tool starts by name, in order", async () => {
    const { outcome, tools } = turn("tool-use");
    expect(await outcome).toEqual({ kind: "completed", text: "noted" });
    expect(tools).toEqual(["Bash", "Read"]);
  });
});

describe("the model list", () => {
  const listed = [
    { value: "default", displayName: "Default (recommended)", supportedEffortLevels: ["low"] },
    { value: "fable", displayName: "Fable 5.1", supportedEffortLevels: ["low", "ultra", "max"] },
    { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
  ];

  it("reads the CLI's models, leaving out `default` and levels Bee doesn't know", () => {
    expect(modelsFromInitialize(listed)).toEqual([
      { id: "fable", label: "Fable 5.1", efforts: ["low", "max"] },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", efforts: [] },
    ]);
  });

  it.each([[undefined], [[]], ["nope"], [[{ value: 1 }]]])(
    "falls back when the reply holds %j",
    (models) => {
      expect(modelsFromInitialize(models)).toBeUndefined();
    },
  );

  it("offers fable in the static catalog", () => {
    expect(staticClaudeModels.map(({ id }) => id)).toContain("fable");
  });
});

describe("the run token", () => {
  const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;

  it("reaches the CLI only through a config file that is gone after the turn", async () => {
    const spies = consoleMethods.map((method) => vi.spyOn(console, method));
    await turn("success").outcome;
    const printed = JSON.stringify(spies.map((spy) => spy.mock.calls));
    vi.restoreAllMocks();

    expect(printed).not.toContain(permissions.token);
    const { args = [], env = [] } = spawns()[0] ?? {};
    expect(args.join(" ")).not.toContain(permissions.token);
    expect(env.join(" ")).not.toContain(permissions.token);

    const config = JSON.parse(cliLog().find(({ mcpConfig }) => mcpConfig)?.mcpConfig ?? "");
    expect(config).toEqual({
      mcpServers: {
        bee: {
          type: "http",
          timeout: 900_000,
          url: permissions.url,
          headers: { Authorization: `Bearer ${permissions.token}` },
        },
      },
    });
    const configPath = args[args.indexOf("--mcp-config") + 1] ?? "";
    expect(NodePath.dirname(configPath)).toBe(NodePath.join(dataDir, "runtime"));
    expect(NodeFS.existsSync(configPath)).toBe(false);
  });

  it("fails the turn without starting the CLI when the config can't be written", async () => {
    NodeFS.writeFileSync(NodePath.join(dataDir, "runtime"), "in the way");
    await expect(turn("success").outcome).rejects.toThrow();
    expect(spawns()).toEqual([]);
  });

  it("is written to a file only the owner can read", async () => {
    const path = NodePath.join(dataDir, "runtime", "tight.json");
    await writeMcpConfig(path, permissions.url, permissions.token);
    if (process.platform === "win32") {
      const acl = NodeChildProcess.execFileSync("icacls", [path], { encoding: "utf8" });
      const entries = acl.split("\n").filter((line) => line.includes(":("));
      expect(entries).toHaveLength(1);
      expect(acl).not.toContain("(I)");
      // The one entry is the owner's only if the owner can still read the file.
      expect(NodeFS.readFileSync(path, "utf8")).toContain(permissions.token);
    } else {
      expect(NodeFS.statSync(path).mode & 0o777).toBe(0o600);
      expect(NodeFS.statSync(NodePath.dirname(path)).mode & 0o777).toBe(0o700);
    }
  });
});

describe("outcomes", () => {
  it.each([
    ["login-lost", { kind: "auth_failed", pauseReason: "auth_failed" }],
    ["status-401", { kind: "auth_failed", pauseReason: "auth_failed" }],
    ["unknown-error", { kind: "failed" }],
    ["no-result", { kind: "failed" }],
    ["limit-api-error", { kind: "limited", retryAfterMs: 300_000 }],
    ["limit-assistant", { kind: "limited", retryAfterMs: 300_000 }],
    ["limit-429", { kind: "limited", retryAfterMs: 300_000 }],
    ["limit-overage", { kind: "completed", text: "noted" }],
    ["no-conversation", { kind: "session_lost" }],
    ["no-final-newline", { kind: "completed", text: "noted" }],
    ["waiting-hook", { kind: "waiting", text: "noted" }],
    ["tool-detail", { kind: "completed", text: "noted" }],
  ])("maps %s", async (scenario, expected) => {
    expect(await turn(scenario).outcome).toEqual(expected);
  });

  it("takes the retry time from a rejected rate limit frame", async () => {
    const outcome = await turn("limit-event").outcome;
    expect(outcome.kind).toBe("limited");
    expect(outcome).toHaveProperty("retryAfterMs", expect.closeTo(600_000, -4));
  });

  it("stops a turn that keeps retrying the API", async () => {
    const { outcome } = turn("api-retry");
    expect(await outcome).toEqual({ kind: "failed" });
    await vi.waitFor(() => expect(isAlive(spawns()[0]?.pid ?? 0)).toBe(false));
  }, 15_000);
});

describe("the credential gate", () => {
  it.each([
    ["subscription", "gate-api-key", "credential_source"],
    ["subscription", "gate-token", "credential_source"],
    ["subscription", "gate-console", "credential_source"],
    ["subscription", "gate-logged-out", "auth_failed"],
    ["api_key", "success", "credential_source"],
    ["api_key", "gate-api-key", "credential_source"],
    ["api_key", "gate-logged-out", "auth_failed"],
  ] as const)(
    "on the %s lane, %s never writes the prompt and pauses with %s",
    async (lane, scenario, pauseReason) => {
      const { outcome, delivered } = turn(scenario, undefined, false, "", null, lane);
      expect(await outcome).toEqual({ kind: "auth_failed", pauseReason });
      expect(prompts()).toEqual([]);
      expect(delivered()).toBe(0);
    },
    15_000,
  );

  it("lets a Console login through on the API-key lane", async () => {
    const { outcome } = turn("gate-console", undefined, false, "", null, "api_key");
    expect(await outcome).toMatchObject({ kind: "completed" });
    expect(prompts()).toEqual([prompt]);
  }, 15_000);

  it("fails closed when the gate times out, and kills the child", async () => {
    const { outcome, delivered } = turn("gate-silent");
    expect(await outcome).toEqual({ kind: "auth_failed", pauseReason: "cli_failed" });
    expect(delivered()).toBe(0);
    await vi.waitFor(() => expect(isAlive(spawns()[0]?.pid ?? 0)).toBe(false));
  }, 15_000);

  it("spends none of the gate's wait asleep", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      clock = createAwakeClock();
      const controller = new AbortController();
      const { outcome } = turn("gate-silent", controller.signal);
      await vi.waitFor(() => expect(spawns()).toHaveLength(1), { timeout: 5000 });
      clock.suspend();
      await vi.advanceTimersByTimeAsync(60_000);
      clock.resume();
      await vi.advanceTimersByTimeAsync(4000);
      controller.abort("stop");
      expect(await outcome).toEqual({ kind: "failed" });
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(isAlive(spawns()[0]?.pid ?? 0)).toBe(false));
  }, 15_000);

  it.each(["gate-version", "gate-no-account"])(
    "runs on %s: no CLI version blocks a turn",
    async (scenario) => {
      expect(await turn(scenario).outcome).toMatchObject({ kind: "completed" });
      expect(prompts()).toEqual([prompt]);
    },
    15_000,
  );

  it("pauses a CLI that exits before the handshake as not started, not logged out", async () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const { outcome, delivered } = turn("unknown-flag");
    expect(await outcome).toEqual({ kind: "auth_failed", pauseReason: "cli_failed" });
    expect(delivered()).toBe(0);
    expect(said).toHaveBeenCalledWith(expect.stringContaining("unknown option"));
    said.mockRestore();
  }, 15_000);

  it("pauses on a missing CLI", async () => {
    const outcome = await createClaudeRunTurn({ command: ["beebot-no-such-cli"], dataDir })({
      prompt,
      sessionId: "s",
      resume: false,
      launch,
      signal: new AbortController().signal,
      onDelta: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onThinking: () => {},
      onRateLimit: () => {},
      permissions,
      approve: async () => ({ behavior: "deny", message: "unused" }),
      onDelivered: () => {},
    });
    expect(outcome).toEqual({ kind: "auth_failed", pauseReason: "cli_missing" });
  });

  it("names the cleared config dir when that may be why the login is gone", async () => {
    plantEnv("CLAUDE_CONFIG_DIR", "somewhere");
    expect(await turn("gate-logged-out").outcome).toEqual({
      kind: "auth_failed",
      pauseReason: "config_dir",
    });
  }, 15_000);
});

describe("the child environment", () => {
  const credentials = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "AWS_BEARER_TOKEN_BEDROCK",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "VERTEX_REGION_CLAUDE",
    "CLOUD_ML_REGION",
    "DISABLE_AUTOUPDATER",
    "MCP_TIMEOUT",
    "T3CODE_TOKEN",
    "ELECTRON_RUN_AS_NODE",
    // Not engine credentials, but beebotd's own or the machine's: none is the bot's to see.
    "BEEBOT_VAULT_KEY",
    "CREDENTIALS_DIRECTORY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "SOME_UNLISTED_SECRET",
  ];

  it("never carries planted credentials to the child, and sets its own two", async () => {
    for (const name of credentials) {
      plantEnv(name, "planted");
    }
    await turn("success").outcome;
    const env = spawns()[0]?.env ?? [];
    for (const name of credentials) {
      expect(env).not.toContain(name);
    }
    expect(env).toEqual(
      expect.arrayContaining([
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
      ]),
    );
  });

  it("keeps the Git Bash path, which the CLI needs for its Bash tool on Windows", () => {
    expect(childEnv({ CLAUDE_CODE_GIT_BASH_PATH: "bash.exe", CLAUDE_X: "y" })).toEqual(
      expect.objectContaining({ CLAUDE_CODE_GIT_BASH_PATH: "bash.exe" }),
    );
    expect(childEnv({ CLAUDE_X: "y" })).not.toHaveProperty("CLAUDE_X");
  });

  it("passes only listed names, matched case-insensitively as Windows treats them", () => {
    expect(childEnv({ anthropic_api_key: "x", Path: "p", lc_all: "C", HOME: "h" })).toEqual({
      Path: "p",
      lc_all: "C",
      HOME: "h",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    });
  });
});

// The six sources the authentication docs rank above `/login`, each planted where it lives and
// each reported by the CLI as the source in use, as it would be if the scrub missed it.
describe("a credential source that outranks the login", () => {
  const planted = "sk-ant-planted-credential";

  it.each([
    [
      "cloud provider flags",
      { CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1" },
      { apiProvider: "bedrock" },
    ],
    [
      "ANTHROPIC_AUTH_TOKEN",
      { ANTHROPIC_AUTH_TOKEN: planted },
      { apiKeySource: "ANTHROPIC_AUTH_TOKEN" },
    ],
    ["ANTHROPIC_API_KEY", { ANTHROPIC_API_KEY: planted }, { apiKeySource: "ANTHROPIC_API_KEY" }],
    // A settings key: no scrub reaches it, so only the flags and the gate stand in its way.
    ["apiKeyHelper", {}, { apiKeySource: "apiKeyHelper" }],
    [
      "CLAUDE_CODE_OAUTH_TOKEN",
      { CLAUDE_CODE_OAUTH_TOKEN: planted },
      { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" },
    ],
    // shortcut: no real init reply from a profile was ever captured, so this field is a guess.
    [
      "Anthropic profile and federation credentials",
      {
        ANTHROPIC_PROFILE: "work",
        ANTHROPIC_FEDERATION_RULE_ID: "rule",
        ANTHROPIC_ORGANIZATION_ID: "org",
        ANTHROPIC_IDENTITY_TOKEN_FILE: "token-file",
      },
      { tokenSource: "anthropic_profile" },
    ],
  ])(
    "%s is cleared from the child and fails the turn closed",
    async (_, env, account) => {
      for (const [name, value] of Object.entries(env)) {
        plantEnv(name, value);
      }
      fakeInput("FAKE_CLAUDE_ACCOUNT", JSON.stringify(account));
      const { outcome, delivered } = turn("gate-account");
      expect(await outcome).toEqual({ kind: "auth_failed", pauseReason: "credential_source" });
      expect(prompts()).toEqual([]);
      expect(delivered()).toBe(0);
      const [spawn] = spawns();
      for (const name of Object.keys(env)) {
        expect(spawn?.env).not.toContain(name);
      }
      const args = spawn?.args ?? [];
      expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
      expect(args.join(" ")).not.toContain("apiKeyHelper");
    },
    15_000,
  );
});

describe("session errors", () => {
  it("retries a session ID already in use, once, with --resume", async () => {
    expect(await turn("in-use").outcome).toEqual({ kind: "completed", text: "noted" });
    const [first, second] = spawns().map(({ args }) => args ?? []);
    expect(first).toContain("--session-id");
    expect(second).toContain("--resume");
    expect(prompts()).toEqual([prompt]);
  });

  it("ignores session wording on stderr once the prompt is out", async () => {
    expect(await turn("noisy-success").outcome).toEqual({ kind: "completed", text: "noted" });
    expect(spawns()).toHaveLength(1);
    expect(prompts()).toEqual([prompt]);
  });

  it("gives up after one retry", async () => {
    expect(await turn("always-in-use").outcome).toEqual({ kind: "failed" });
    expect(spawns()).toHaveLength(2);
    expect(prompts()).toEqual([]);
  });
});

describe("steering", () => {
  it("restarts the stopped turn on its session, with the new input", async () => {
    const { promise: steerable, resolve } = Promise.withResolvers<Steer>();
    const steered = turn("steer", undefined, false, "", null, "subscription", resolve);
    const steer = await steerable;
    expect(await steer("and the tests")).toBe(true);
    expect(await steered.outcome).toEqual({ kind: "completed", text: "noted" });
    expect(spawns().map(({ args = [] }) => args.includes("--resume"))).toEqual([false, true]);
    expect(prompts().at(-1)).toContain("and the tests");
    expect(steered.delivered()).toBe(1);
    expect(await steer("too late")).toBe(false);
  }, 15_000);

  it("refuses a steer while a tool runs, and leaves the attempt alone", async () => {
    const controller = new AbortController();
    const { promise: steerable, resolve } = Promise.withResolvers<Steer>();
    const busy = turn("tool-hang", controller.signal, false, "", null, "subscription", resolve);
    const steer = await steerable;
    await vi.waitFor(() => expect(busy.starts).toHaveLength(1), { timeout: 5000 });
    expect(await steer("later")).toBe(false);
    expect(spawns()).toHaveLength(1);
    controller.abort();
    await busy.outcome;
  }, 15_000);
});

describe("stopping", () => {
  it("settles after an abort and kills the child", async () => {
    const controller = new AbortController();
    const { outcome, deltas } = turn("hang", controller.signal);
    await vi.waitFor(() => expect(deltas.length).toBeGreaterThan(0), { timeout: 5000 });
    controller.abort("stop");
    expect(await outcome).toEqual({ kind: "failed" });
    await vi.waitFor(() => expect(isAlive(spawns()[0]?.pid ?? 0)).toBe(false));
  }, 15_000);

  it("settles when aborted before the gate, without writing the prompt", async () => {
    const controller = new AbortController();
    const { outcome } = turn("gate-silent", controller.signal);
    await vi.waitFor(() => expect(spawns()).toHaveLength(1), { timeout: 5000 });
    controller.abort("stop");
    expect(await outcome).toEqual({ kind: "failed" });
    expect(prompts()).toEqual([]);
  }, 15_000);

  it("kills a child that lingers after its result, and keeps the reply", async () => {
    expect(await turn("linger").outcome).toEqual({ kind: "completed", text: "noted" });
    await vi.waitFor(() => expect(isAlive(spawns()[0]?.pid ?? 0)).toBe(false));
  }, 15_000);
});

describe("the engine probe", () => {
  it("passes a subscription login, keeping the email and dropping the org", async () => {
    const status = await probeEngine(fakeCommand("success"), dataDir, "subscription");
    expect(status).toEqual({
      cliFound: true,
      version: "2.1.318",
      auth: "authenticated",
      email: "owner@example.com",
      pauseReason: null,
    });
    expect(EngineStatus.parse(status)).toEqual(status);
    expect(JSON.stringify(status)).not.toContain("Owner Org");
  });

  it("passes a Console login on the API-key lane", async () => {
    const status = await probeEngine(fakeCommand("console-status"), dataDir, "api_key");
    expect(status).toMatchObject({ auth: "authenticated", pauseReason: null });
  });

  it("passes any version, reading it only for display", async () => {
    const status = await probeEngine(fakeCommand("gate-version"), dataDir, "subscription");
    expect(status).toMatchObject({ version: "9.9.9", auth: "authenticated", pauseReason: null });
  });

  it("passes a CLI too old to report its login, leaving the check to the run", async () => {
    const status = await probeEngine(fakeCommand("gate-no-account"), dataDir, "subscription");
    expect(status).toEqual({
      cliFound: true,
      version: "1.0.0",
      auth: "unknown",
      email: null,
      pauseReason: null,
    });
  });

  it.each([
    ["subscription", "logged-out-status", "auth_failed", "unauthenticated"],
    ["subscription", "api-key-status", "credential_source", "authenticated"],
    ["subscription", "console-status", "credential_source", "authenticated"],
    ["api_key", "success", "credential_source", "authenticated"],
    ["api_key", "api-key-status", "credential_source", "authenticated"],
    ["api_key", "logged-out-status", "auth_failed", "unauthenticated"],
  ] as const)("on the %s lane, %s pauses with %s", async (lane, scenario, pauseReason, auth) => {
    expect(await probeEngine(fakeCommand(scenario), dataDir, lane)).toMatchObject({
      pauseReason,
      cliFound: true,
      auth,
    });
  });

  it("pauses on a missing CLI", async () => {
    expect(await probeEngine(["beebot-no-such-cli"], dataDir, "subscription")).toMatchObject({
      pauseReason: "cli_missing",
      cliFound: false,
    });
  });

  it("tells a CLI that fails apart from a missing one", async () => {
    expect(await probeEngine(fakeCommand("broken"), dataDir, "subscription")).toMatchObject({
      pauseReason: "cli_failed",
      cliFound: true,
    });
  });

  it("names the cleared config dir", async () => {
    plantEnv("CLAUDE_CONFIG_DIR", "somewhere");
    const status = await probeEngine(fakeCommand("logged-out-status"), dataDir, "subscription");
    expect(status.pauseReason).toBe("config_dir");
  });
});

describe("a project folder", () => {
  let project: string;
  const noSignal = new AbortController().signal;
  const inProject = (scenario: string) => turn(scenario, noSignal, false, "", project).outcome;

  beforeEach(() => {
    project = NodeFS.realpathSync.native(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-project-")),
    );
  });

  afterEach(() => {
    NodeFS.rmSync(project, { recursive: true, force: true });
  });

  it("is where the turn runs, with the persona kept in the bot's private folder", async () => {
    expect(await inProject("success")).toEqual({ kind: "completed", text: "noted" });
    const [spawn] = spawns();
    expect(spawn?.cwd).toBe(project);
    const args = spawn?.args ?? [];
    const personaPath = args[args.indexOf("--append-system-prompt-file") + 1];
    expect(personaPath).toBe(NodePath.join(dataDir, "bots", launch.botId, "persona.md"));
    expect(NodeFS.readFileSync(personaPath ?? "", "utf8")).toContain("Terse.");
    expect(NodeFS.readdirSync(project)).toEqual([]);
    expect(NodeFS.readdirSync(NodePath.dirname(project))).not.toContain("persona.md");
  });

  it("runs none of a hostile repo's hooks, env block, apiKeyHelper or MCP servers", async () => {
    const write = (name: string, content: unknown) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(project, name)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(project, name), JSON.stringify(content));
    };
    const marker = NodePath.join(project, "mark.cjs");
    NodeFS.writeFileSync(
      marker,
      'require("fs").writeFileSync(require("path").join(__dirname, "ran-" + process.argv[2]), "")',
    );
    const mark = (what: string) =>
      `${JSON.stringify(process.execPath)} ${JSON.stringify(marker)} ${what}`;
    const hook = (what: string) => ({
      SessionStart: [{ hooks: [{ type: "command", command: mark(what) }] }],
    });
    write(".claude/settings.json", {
      env: { BEE_HOSTILE_ENV: "1" },
      hooks: hook("hook"),
      apiKeyHelper: mark("helper"),
    });
    write(".claude/settings.local.json", { hooks: hook("local-hook") });
    write(".mcp.json", {
      mcpServers: { evil: { command: process.execPath, args: [marker, "mcp"] } },
    });
    const ran = () => NodeFS.readdirSync(project).filter((name) => name.startsWith("ran-"));

    // Armed: the same stand-in, launched with no flags, runs all of it.
    const armed = NodePath.join(dataDir, "armed.log");
    NodeChildProcess.spawnSync(process.execPath, [fakeCli, "repo-loader", armed], {
      cwd: project,
      input: "",
    });
    expect(ran().sort()).toEqual(["ran-helper", "ran-hook", "ran-local-hook", "ran-mcp"]);
    expect(NodeFS.readFileSync(armed, "utf8")).toContain("BEE_HOSTILE_ENV");
    for (const name of ran()) {
      NodeFS.rmSync(NodePath.join(project, name));
    }

    expect(await inProject("repo-loader")).toEqual({ kind: "completed", text: "noted" });
    expect(ran()).toEqual([]);
    const loaded = cliLog().find((entry) => entry.loadedEnv)?.loadedEnv;
    expect(loaded).toBeDefined();
    expect(loaded).not.toContain("BEE_HOSTILE_ENV");
  }, 15_000);

  it.each(["gone", "a-file"])("is missing when it is %s, and nothing is spawned", async (name) => {
    const path = NodePath.join(project, name);
    if (name === "a-file") {
      NodeFS.writeFileSync(path, "");
    }
    const { outcome, delivered } = turn("success", noSignal, false, "", path);
    expect(await outcome).toEqual({ kind: "folder_missing" });
    expect(spawns()).toEqual([]);
    expect(delivered()).toBe(0);
    expect(NodeFS.readdirSync(project)).toEqual(name === "gone" ? [] : ["a-file"]);
    expect(NodeFS.existsSync(NodePath.join(dataDir, "bots"))).toBe(false);
  });
});

describe("createClaudeSummarize", () => {
  const bot = { name: "Ada", personality: "You are a patient math tutor." };
  const summarize = (scenario: string, lane: EngineLane = "subscription") =>
    createClaudeSummarize({ command: fakeCommand(scenario), dataDir, clock, lane: () => lane })(
      bot,
      new AbortController().signal,
    );

  it("sends the personality on stdin as text to describe, with no tools or session", async () => {
    expect(await summarize("success")).toBe("noted");
    const args = spawns()[0]?.args ?? [];
    expect(args).toEqual(expect.arrayContaining(["--no-session-persistence", "--system-prompt"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args.join(" ")).not.toContain(bot.personality);
    expect(prompts()).toEqual([expect.stringContaining(`<personality>\n${bot.personality}\n`)]);
  });

  it("sends nothing on a login the account's lane doesn't use", async () => {
    expect(await summarize("gate-api-key")).toBeUndefined();
    expect(prompts()).toEqual([]);
  });

  it("gives up when the CLI is missing", async () => {
    const missing = createClaudeSummarize({
      command: ["beebot-no-such-cli"],
      dataDir,
      lane: () => "subscription",
    });
    expect(await missing(bot, new AbortController().signal)).toBeUndefined();
  });
});
