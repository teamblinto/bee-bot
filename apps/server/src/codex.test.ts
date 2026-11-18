import * as NodeCrypto from "node:crypto";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type BotAccess,
  type Command,
  type EngineLane,
  EngineStatus,
  type PendingApproval,
  protocolVersion,
  ServerMessage,
} from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

import {
  childEnv,
  createCodexRunTurn,
  probeCodex,
  staticCodexModels,
  unwrapShell,
} from "./codex.ts";
import {
  type BotLaunch,
  type Steer,
  type ThinkingState,
  type ToolStart,
  workspacePath,
} from "./engine.ts";
import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";

const fakeCli = NodePath.join(import.meta.dirname, "fixtures", "codex", "fake-codex.mjs");
const launch: BotLaunch = {
  botId: "7f0f6a55-5a4c-4c37-9d0b-2f3c1d2e6b10",
  name: "Ada",
  personality: "Terse.",
  engineAccountId: "codex",
  lane: "subscription",
  model: "gpt-6.1-sol",
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

let dataDir: string;
let logPath: string;
let outside: string;
const plantedEnv: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dataDir = NodeFS.realpathSync.native(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-codex-")),
  );
  outside = NodeFS.realpathSync.native(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-outside-")),
  );
  logPath = NodePath.join(dataDir, "fake-cli.log");
  plantEnv("FAKE_OUTSIDE", outside);
  plantEnv("FAKE_HOME", NodeOS.homedir());
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  for (const name of plantedEnv.splice(0)) {
    delete process.env[name];
  }
  // Windows locks a killed child's cwd for a few ms after it reports exited, as Access Denied,
  // which rmSync's maxRetries does not retry.
  await vi.waitFor(() => NodeFS.rmSync(dataDir, { recursive: true, force: true }));
  NodeFS.rmSync(outside, { recursive: true, force: true });
});

function plantEnv(name: string, value: string) {
  plantedEnv.push(name);
  process.env[name] = value;
}

const fakeCommand = (scenario: string) => [process.execPath, fakeCli, scenario, logPath];

type LogEntry = {
  pid?: number;
  args?: string[];
  cwd?: string;
  env?: string[];
  token?: string;
  rpc?: string;
  params?: Record<string, unknown>;
  answered?: string;
  result?: Record<string, unknown>;
  error?: { code: number };
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
const calls = () => cliLog().flatMap(({ rpc }) => rpc ?? []);
const called = (method: string) => cliLog().find(({ rpc }) => rpc === method)?.params;
const answered = () => cliLog().filter(({ answered: method }) => method);

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type TurnOptions = {
  signal?: AbortSignal;
  resume?: boolean;
  sessionId?: string;
  fields?: Partial<BotLaunch>;
  allow?: boolean;
  onSessionId?: (id: string) => void;
  onSteerable?: (steer: Steer) => void;
};

function turn(scenario: string, options: TurnOptions = {}) {
  const { signal, resume = false, sessionId = "placeholder", fields, allow = true } = options;
  const deltas: string[] = [];
  const starts: ToolStart[] = [];
  const ends: Array<{ id: string; failed: boolean }> = [];
  const thinking: ThinkingState[] = [];
  const asked: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const order: string[] = [];
  const outcome = createCodexRunTurn({ command: fakeCommand(scenario), dataDir })({
    prompt,
    sessionId,
    resume,
    launch: { ...launch, ...fields },
    signal: signal ?? new AbortController().signal,
    onDelta: (text) => deltas.push(text),
    onToolStart: (tool) => starts.push(tool),
    onToolEnd: (id, failed) => ends.push({ id, failed }),
    onThinking: (state) => thinking.push(state),
    onRateLimit: () => {},
    permissions,
    onDelivered: () => {
      order.push(`delivered after ${calls().join(" ")}`);
    },
    onSessionId:
      options.onSessionId ??
      ((id) => {
        order.push(`session ${id} after ${calls().join(" ")}`);
      }),
    ...(options.onSteerable && { onSteerable: options.onSteerable }),
    approve: async (tool, input) => {
      asked.push({ tool, input });
      return allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "no" };
    },
  });
  return { outcome, deltas, starts, ends, thinking, asked, order };
}

const decisions = () => answered().map(({ result }) => result?.decision);

describe("the launch", () => {
  const argsOf = () => spawns()[0]?.args ?? [];
  const settings = () => {
    const args = argsOf();
    return args.flatMap((arg, index) => (args[index - 1] === "-c" ? [arg] : []));
  };

  it("starts the app server, one process for the turn, in the bot's own folder", async () => {
    expect(await turn("success").outcome).toEqual({ kind: "completed", text: "noted" });
    const [spawn, ...others] = spawns();
    expect(others).toEqual([]);
    expect(spawn?.args?.[0]).toBe("app-server");
    expect(spawn?.cwd).toBe(workspacePath(dataDir, launch.botId));
  });

  it("untrusts the working folder and every ancestor, in the case the platform needs", async () => {
    await turn("success").outcome;
    const projects = settings().find((setting) => setting.startsWith("projects=")) ?? "";
    const folder = workspacePath(dataDir, launch.botId);
    const keyOf = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
    for (const path of [folder, NodePath.dirname(folder), dataDir, NodePath.parse(dataDir).root]) {
      expect(projects).toContain(`${JSON.stringify(keyOf(path))}={trust_level="untrusted"}`);
    }
  });

  it("shuts the owner's and the repo's extras out, and never `code_mode_host`", async () => {
    await turn("success").outcome;
    expect(settings()).toEqual(
      expect.arrayContaining([
        "notify=[]",
        'web_search="disabled"',
        "project_doc_max_bytes=0",
        "skills.bundled.enabled=false",
        'model_provider="openai"',
        'forced_login_method="chatgpt"',
      ]),
    );
    const args = argsOf();
    const disabled = args.flatMap((arg, index) => (args[index - 1] === "--disable" ? [arg] : []));
    expect(disabled).toEqual(
      expect.arrayContaining([
        "hooks",
        "plugins",
        "apps",
        "multi_agent",
        "memories",
        "unified_exec_tty",
      ]),
    );
    expect(disabled).not.toContain("code_mode_host");
    expect(disabled).not.toContain("unified_exec");
  });

  it("forces the API-key login on the API-key lane", async () => {
    await turn("gate-api-key", { fields: { lane: "api_key" } }).outcome;
    expect(settings()).toContain('forced_login_method="api"');
    expect(settings()).not.toContain('forced_login_method="chatgpt"');
  });

  it("exposes the memory tools but not `approve`, and hides the token from the shell", async () => {
    await turn("success").outcome;
    expect(settings()).toEqual(
      expect.arrayContaining([
        `mcp_servers.bee.url=${JSON.stringify(permissions.url)}`,
        'mcp_servers.bee.bearer_token_env_var="BEE_MCP_TOKEN"',
        'mcp_servers.bee.enabled_tools=["memory_search","memory_get","memory_propose","memory_forget","send_message","notify","delegate","handoff","read_bot_activity","ask_user","create_routine"]',
        'mcp_servers.bee.default_tools_approval_mode="approve"',
        'shell_environment_policy.exclude=["BEE_MCP_TOKEN"]',
      ]),
    );
  });

  it("mounts the connectors server, without a tool list, only for a bot with a grant", async () => {
    await turn("success").outcome;
    expect(settings().join(" ")).not.toContain("mcp_servers.connectors");
  });

  it("gives a granted bot the connectors server and names its apps", async () => {
    await turn("success", { fields: { connectors: ["Notion"] } }).outcome;
    const connectors = settings().filter((setting) =>
      setting.startsWith("mcp_servers.connectors."),
    );
    expect(connectors).toEqual([
      `mcp_servers.connectors.url=${JSON.stringify(new URL("/mcp/connectors", permissions.url).href)}`,
      'mcp_servers.connectors.bearer_token_env_var="BEE_MCP_TOKEN"',
      'mcp_servers.connectors.default_tools_approval_mode="approve"',
    ]);
    expect(called("thread/start")?.developerInstructions).toContain(
      "Connected apps you may use through the connectors tools: Notion.",
    );
  });

  it("carries the run token in the child's environment only", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method),
    );
    await turn("success").outcome;
    const printed = JSON.stringify(spies.map((spy) => spy.mock.calls));
    vi.restoreAllMocks();
    expect(printed).not.toContain(permissions.token);
    expect(argsOf().join(" ")).not.toContain(permissions.token);
    expect(JSON.stringify(cliLog().filter(({ rpc }) => rpc))).not.toContain(permissions.token);
    expect(cliLog().find(({ token }) => token)?.token).toBe(permissions.token);
  });

  it("keeps the prompt off argv and asks with the only workable policy", async () => {
    await turn("success", { fields: { effort: "high" } }).outcome;
    expect(argsOf().join(" ")).not.toContain(prompt);
    expect(called("initialize")).toMatchObject({ capabilities: { experimentalApi: true } });
    expect(calls()).toContain("initialized");
    expect(called("thread/start")).toMatchObject({
      model: "gpt-6.1-sol",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      developerInstructions:
        "Your name is Ada.\n\nTerse.\n\nYou have no web browser or computer to use. If a task " +
        "needs one, tell the owner.",
    });
    expect(called("thread/start")).not.toHaveProperty("ephemeral");
    expect(called("turn/start")).toEqual({
      threadId: "thread-from-codex",
      input: [{ type: "text", text: prompt, text_elements: [] }],
      effort: "high",
    });
  });

  it("leaves out an unset effort, and reads only in Plan mode", async () => {
    await turn("success", { fields: { mode: "plan" } }).outcome;
    expect(called("thread/start")).toMatchObject({ sandbox: "read-only" });
    expect(called("turn/start")).not.toHaveProperty("effort");
  });

  it.each([
    ["a new thread", "thread/start", false],
    ["a resumed thread", "thread/resume", true],
  ])("turns off skills and servers by name on %s, leaving bee", async (_, method, resume) => {
    await turn("success", { resume, sessionId: "stored" }).outcome;
    expect(called(method)?.config).toEqual({
      "skills.config": [
        { name: "repo-skill", enabled: false },
        { name: "owner-skill", enabled: false },
      ],
      "mcp_servers.owner_server.enabled": false,
    });
  });

  it.each(["project-active", "config-shape", "dotted-server"])(
    "%s fails closed before any thread or prompt",
    async (scenario) => {
      const { outcome, order } = turn(scenario);
      expect(await outcome).toEqual({ kind: "failed" });
      expect(calls()).not.toContain("thread/start");
      expect(calls()).not.toContain("turn/start");
      expect(order).toEqual([]);
    },
  );
});

describe("the credential gate", () => {
  it.each([
    ["subscription", "gate-logged-out", "auth_failed"],
    ["subscription", "gate-api-key", "credential_source"],
    ["subscription", "gate-bedrock", "credential_source"],
    ["api_key", "success", "credential_source"],
    ["api_key", "gate-bedrock", "credential_source"],
    ["api_key", "gate-logged-out", "auth_failed"],
  ] as const)(
    "on the %s lane, %s never sends the prompt and pauses with %s",
    async (lane, scenario, pauseReason) => {
      const { outcome, order } = turn(scenario, { fields: { lane } });
      expect(await outcome).toEqual({ kind: "auth_failed", pauseReason });
      expect(calls()).not.toContain("thread/start");
      expect(order).toEqual([]);
    },
  );

  it("lets an API-key login through on the API-key lane", async () => {
    const { outcome } = turn("gate-api-key", { fields: { lane: "api_key" } });
    expect(await outcome).toEqual({ kind: "completed", text: "noted" });
  });

  it.each(["gate-version", "gate-no-version", "gate-no-account-read"])(
    "%s still runs the turn",
    async (scenario) => {
      expect(await turn(scenario).outcome).toEqual({ kind: "completed", text: "noted" });
      expect(calls()).toContain("turn/start");
    },
  );

  it("pauses on a missing CLI", async () => {
    const outcome = await createCodexRunTurn({ command: ["beebot-no-such-cli"], dataDir })({
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

  it("fails closed when the gate times out, and kills the child", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { outcome, order } = turn("gate-silent");
      await vi.waitFor(() => expect(calls()).toContain("initialize"));
      await vi.advanceTimersByTimeAsync(36_000);
      expect(await outcome).toEqual({ kind: "auth_failed", pauseReason: "cli_failed" });
      expect(order).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(isAlive(spawns()[0]?.pid ?? 0)).toBe(false));
  });
});

describe("sessions", () => {
  it("stores the thread before the prompt, and reports delivery after acceptance", async () => {
    const { outcome, order } = turn("success");
    await outcome;
    const beforePrompt = "session thread-from-codex after";
    expect(order[0]).toContain(beforePrompt);
    expect(order[0]).not.toContain("turn/start");
    expect(order[1]).toContain("turn/start");
  });

  it("sends no prompt when the thread can't be stored", async () => {
    const onSessionId = () => {
      throw new Error("disk full");
    };
    const { outcome, order } = turn("success", { onSessionId });
    expect(await outcome).toEqual({ kind: "failed" });
    expect(calls()).not.toContain("turn/start");
    expect(order).toEqual([]);
  });

  it("resumes the stored thread", async () => {
    const result = turn("success", { resume: true, sessionId: "stored-thread" });
    expect(await result.outcome).toEqual({ kind: "completed", text: "noted" });
    expect(calls()).not.toContain("thread/start");
    expect(called("thread/resume")).toMatchObject({ threadId: "stored-thread" });
    expect(called("turn/start")).toMatchObject({ threadId: "stored-thread" });
  });

  it("sends a changed persona into a resumed thread once, before the prompt", async () => {
    const personaPath = NodePath.join(dataDir, "bots", launch.botId, "persona.md");
    await turn("success").outcome;
    expect(calls()).not.toContain("thread/inject_items");

    NodeFS.rmSync(logPath);
    await turn("success", { resume: true, sessionId: "t" }).outcome;
    expect(calls()).not.toContain("thread/inject_items");

    NodeFS.rmSync(logPath);
    const fields = { personality: "Now verbose." };
    await turn("success", { resume: true, sessionId: "t", fields }).outcome;
    expect(JSON.stringify(called("thread/inject_items"))).toContain("Now verbose.");
    expect(calls().indexOf("thread/inject_items")).toBeLessThan(calls().indexOf("turn/start"));
    expect(NodeFS.readFileSync(personaPath, "utf8")).toContain("Now verbose.");

    NodeFS.rmSync(logPath);
    await turn("success", { resume: true, sessionId: "t", fields }).outcome;
    expect(calls()).not.toContain("thread/inject_items");
  });

  it("sends no prompt when a changed persona can't be delivered", async () => {
    const result = turn("inject-fails", { resume: true, sessionId: "t" });
    expect(await result.outcome).toEqual({ kind: "failed" });
    expect(calls()).not.toContain("turn/start");
  });

  it("reports a thread Codex no longer has as lost, without a prompt", async () => {
    const { outcome, order } = turn("lost-thread", { resume: true, sessionId: "gone" });
    expect(await outcome).toEqual({ kind: "session_lost" });
    expect(calls()).not.toContain("turn/start");
    expect(order).toEqual([]);
  });

  it("treats any other thread failure as a failure", async () => {
    expect(await turn("resume-other-error", { resume: true }).outcome).toEqual({ kind: "failed" });
    expect(await turn("thread-fails").outcome).toEqual({ kind: "failed" });
  });

  it("reports no delivery when turn/start is rejected", async () => {
    const { outcome, order } = turn("turn-rejected");
    expect(await outcome).toEqual({ kind: "failed" });
    expect(order.filter((line) => line.startsWith("delivered"))).toEqual([]);
  });
});

describe("a turn", () => {
  it("streams everything but keeps only the answer as the reply", async () => {
    const { outcome, deltas } = turn("phases");
    expect(await outcome).toEqual({ kind: "completed", text: "The answer." });
    expect(deltas).toEqual(["Looking first.", "The answer."]);
  });

  it("keeps the commentary when that is all there is", async () => {
    expect(await turn("commentary-only").outcome).toEqual({
      kind: "completed",
      text: "Only this.",
    });
  });

  it("reports thinking and passes its text on", async () => {
    const { outcome, thinking } = turn("thinking");
    await outcome;
    expect(thinking).toEqual([
      { active: true, text: "" },
      { active: true, text: "Weighing" },
      { active: true, text: " it" },
      { active: false, text: "" },
    ]);
  });

  it("reports tools by their Bee names, with the shell wrapper stripped", async () => {
    const { outcome, starts, ends } = turn("tools");
    await outcome;
    expect(starts).toContainEqual({ id: "cmd-1", name: "Bash", detail: "cat ~/secret-input.txt" });
    expect(starts).toContainEqual({ id: "m-1", name: "mcp__bee__memory_search", detail: null });
    expect(ends).toEqual([
      { id: "cmd-1", failed: true },
      { id: "m-1", failed: false },
    ]);
  });

  it("reports an item seen only on completion, or with no id", async () => {
    const { outcome, starts } = turn("completion-only-item");
    await outcome;
    expect(starts).toContainEqual({ id: "n-1", name: "somethingNew", detail: null });
    const noId = turn("no-id-item");
    await noId.outcome;
    expect(noId.starts.map(({ name }) => name)).toEqual(["somethingNew"]);
  });
});

describe("steering", () => {
  it("sends input to the live turn, which answers it", async () => {
    const { promise: steerable, resolve } = Promise.withResolvers<Steer>();
    const { outcome } = turn("steer", { onSteerable: resolve });
    const steer = await steerable;
    expect(await steer("and the tests")).toBe(true);
    expect(await outcome).toEqual({ kind: "completed", text: "partial\n\nheard and the tests" });
    expect(called("turn/steer")).toEqual({
      threadId: "thread-from-codex",
      input: [{ type: "text", text: "and the tests", text_elements: [] }],
      expectedTurnId: "turn-1",
    });
    expect(await steer("too late")).toBe(false);
  });
});

describe("outcomes", () => {
  it.each([
    ["limit-usage", { kind: "limited", retryAfterMs: 300_000 }],
    ["limit-rate", { kind: "limited", retryAfterMs: 300_000 }],
    ["limit-429", { kind: "limited", retryAfterMs: 300_000 }],
    ["exit-mid-turn", { kind: "limited", retryAfterMs: 300_000 }],
    ["auth-unauthorized", { kind: "auth_failed", pauseReason: "auth_failed" }],
    ["auth-401", { kind: "auth_failed", pauseReason: "auth_failed" }],
    ["failed-other", { kind: "failed" }],
    ["failed-text", { kind: "failed" }],
    ["interrupted", { kind: "failed" }],
    ["exit-silently", { kind: "failed" }],
    ["retry-then-success", { kind: "completed", text: "noted" }],
  ])("maps %s", async (scenario, expected) => {
    expect(await turn(scenario).outcome).toEqual(expected);
  });

  it("takes the retry time from the exhausted window", async () => {
    const outcome = await turn("limit-reset").outcome;
    expect(outcome.kind).toBe("limited");
    expect(outcome).toHaveProperty("retryAfterMs", expect.closeTo(600_000, -4));
  });

  it("is folder_missing without a spawn", async () => {
    const gone = NodePath.join(outside, "gone");
    expect(await turn("success", { fields: { projectPath: gone } }).outcome).toEqual({
      kind: "folder_missing",
    });
    expect(spawns()).toEqual([]);
  });
});

describe("requests from the server", () => {
  it("refuses everything it can't answer, so the turn doesn't hang", async () => {
    const { outcome, asked } = turn("refused");
    expect(await outcome).toEqual({ kind: "completed", text: "survived" });
    expect(asked).toEqual([]);
    const replies = Object.fromEntries(
      answered().map(({ answered: method, result, error }) => [method, result ?? error?.code]),
    );
    expect(replies).toEqual({
      "item/permissions/requestApproval": -32_601,
      "item/tool/requestUserInput": { answers: {} },
      "mcpServer/elicitation/request": { action: "decline" },
      "item/tool/call": -32_601,
      "account/chatgptAuthTokens/refresh": -32_601,
      applyPatchApproval: -32_601,
      "something/brandNew": -32_601,
    });
  });

  it.each(["network-kind", "network-context", "no-command"])(
    "%s is declined without a card",
    async (scenario) => {
      const { outcome, asked } = turn(scenario);
      await outcome;
      expect(asked).toEqual([]);
      expect(decisions()).toEqual(["decline"]);
    },
  );

  it.each(["patch-unknown", "patch-empty", "patch-newline", "patch-shape"])(
    "%s is declined without a card: what can't be shown can't be approved",
    async (scenario) => {
      const { outcome, asked } = turn(scenario);
      await outcome;
      expect(asked).toEqual([]);
      expect(decisions()).toEqual(["decline"]);
    },
  );

  it("answers only accept or decline", async () => {
    await turn("approve").outcome;
    expect(answered().map(({ result }) => result)).toEqual([{ decision: "accept" }]);
    await turn("approve", { allow: false }).outcome;
    expect(answered().map(({ result }) => result)).toEqual([
      { decision: "accept" },
      { decision: "decline" },
    ]);
  });

  it("asks about the bare command, not the wrapper", async () => {
    const { outcome, asked } = turn("approve");
    await outcome;
    expect(asked).toEqual([{ tool: "Bash", input: { command: "cat ~/secret-input.txt" } }]);
  });

  it("marks every line of a patch, so content can't forge a file header", async () => {
    plantEnv("FAKE_PROJECT", "/p");
    const { outcome, asked } = turn("patch-outside");
    await outcome;
    expect(asked).toEqual([
      {
        tool: "Patch",
        input: {
          paths: ["/p/a.txt", `${outside}/b.txt`],
          diff: `=== /p/a.txt\n+one\n+=== forged\n=== ${outside}/b.txt\n@@ -1 +1 @@\n-a\n+b`,
        },
      },
    ]);
  });

  it("puts a move's destination through the same gate", async () => {
    plantEnv("FAKE_PROJECT", "/p");
    const { outcome, asked } = turn("patch-move");
    await outcome;
    expect(asked[0]?.input).toEqual({
      paths: ["/p/old.txt", `${outside}/new.txt`],
      diff: `=== /p/old.txt -> ${outside}/new.txt\n@@ -1 +1 @@\n-a\n+b`,
    });
  });

  it("learns a patch's changes from patchUpdated too", async () => {
    plantEnv("FAKE_PROJECT", "/p");
    const { outcome, asked, starts } = turn("patch-updated");
    await outcome;
    expect(asked[0]?.input.paths).toEqual(["/p/a.txt"]);
    expect(starts.at(0)).toEqual({ id: "patch-1", name: "Patch", detail: null });
    expect(starts.at(1)).toEqual({ id: "patch-1", name: "Patch", detail: "/p/a.txt" });
  });
});

describe("stopping", () => {
  it("interrupts the turn and settles", async () => {
    const controller = new AbortController();
    const { outcome, deltas } = turn("hang", { signal: controller.signal });
    await vi.waitFor(() => expect(deltas.length).toBeGreaterThan(0), { timeout: 5000 });
    controller.abort("stop");
    expect(await outcome).toEqual({ kind: "failed" });
    expect(called("turn/interrupt")).toEqual({ threadId: "thread-from-codex", turnId: "turn-1" });
    await vi.waitFor(() => expect(isAlive(spawns()[0]?.pid ?? 0)).toBe(false));
  });

  it("kills a child that ignores the interrupt, and still settles", async () => {
    const controller = new AbortController();
    const { outcome, deltas } = turn("ignores-interrupt", { signal: controller.signal });
    await vi.waitFor(() => expect(deltas.length).toBeGreaterThan(0), { timeout: 5000 });
    controller.abort("stop");
    expect(await outcome).toEqual({ kind: "failed" });
    await vi.waitFor(() => expect(isAlive(spawns()[0]?.pid ?? 0)).toBe(false));
  }, 15_000);

  it("settles when aborted during the gate, without a prompt", async () => {
    const controller = new AbortController();
    const { outcome, order } = turn("gate-silent", { signal: controller.signal });
    await vi.waitFor(() => expect(calls()).toContain("initialize"), { timeout: 5000 });
    controller.abort("stop");
    expect(await outcome).toEqual({ kind: "failed" });
    expect(order).toEqual([]);
    expect(called("turn/interrupt")).toBeUndefined();
  }, 15_000);

  it("spawns nothing when already aborted", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    expect(await turn("success", { signal: controller.signal }).outcome).toEqual({
      kind: "failed",
    });
    expect(spawns()).toEqual([]);
  });

  it("kills a child that outlives its turn, and keeps the reply", async () => {
    expect(await turn("linger-after-stdin").outcome).toEqual({ kind: "completed", text: "noted" });
    await vi.waitFor(() => expect(isAlive(spawns()[0]?.pid ?? 0)).toBe(false));
  }, 15_000);
});

describe("unwrapShell", () => {
  const powershell = String.raw`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"`;

  it.each([
    [`${powershell} -NoProfile -Command 'git status'`, "git status"],
    [`${powershell} -Command 'git status'`, "git status"],
    [String.raw`${powershell} -Command "Get-Content \"C:\\x\""`, String.raw`Get-Content "C:\\x"`],
    ["powershell.exe -Command 'dir'", "dir"],
    ["pwsh -NoProfile -Command 'dir'", "dir"],
    ["/bin/bash -lc 'ls -la'", "ls -la"],
    ["/usr/bin/zsh -lc 'ls'", "ls"],
    ['bash -lc "echo \\"hi\\""', 'echo "hi"'],
    ["sh -lc 'ls\nwhoami'", "ls\nwhoami"],
  ])("strips %s", (raw, shown) => {
    expect(unwrapShell(raw)).toBe(shown);
  });

  it.each([
    ["an inner single quote", `${powershell} -Command 'it''s'`],
    ["a command after the payload", `${powershell} -Command 'a'; evil 'b'`],
    ["an unescaped inner double quote", `bash -lc "a" b "c"`],
    ["a dangling quote", `bash -lc 'a`],
    ["an unquoted payload", "bash -lc ls"],
    ["an extra flag", `${powershell} -ExecutionPolicy Bypass -Command 'a'`],
    ["a shell the model picked", String.raw`"C:\\evil\\powershell.exe" -Command 'git status'`],
    ["a lookalike", "/tmp/bash -lc 'ls'"],
    ["no wrapper", "git status"],
  ])("leaves the raw string on %s", (_, raw) => {
    expect(unwrapShell(raw)).toBe(raw);
  });
});

describe("the child environment", () => {
  const credentials = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_IDENTITY_TOKEN_FILE",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_CONNECTORS_TOKEN",
    "CODEX_APP_SERVER_URL",
    "AWS_BEARER_TOKEN_BEDROCK",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "AZURE_OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ELECTRON_RUN_AS_NODE",
  ];

  it("never carries planted credentials to the child", async () => {
    for (const name of credentials) {
      plantEnv(name, "planted");
    }
    await turn("success").outcome;
    const env = spawns()[0]?.env ?? [];
    for (const name of credentials) {
      expect(env).not.toContain(name);
    }
    expect(env).toContain("BEE_MCP_TOKEN");
  });

  it("keeps CODEX_HOME, where the login lives, and clears names case-insensitively", () => {
    const kept = childEnv({ CODEX_HOME: "home", openai_api_key: "x", codex_x: "y", PATH: "p" });
    expect(kept).toEqual({ CODEX_HOME: "home", PATH: "p" });
  });
});

describe("the engine probe", () => {
  const probe = (
    scenario: string,
    onModels?: (models: unknown[]) => void,
    lane: EngineLane = "subscription",
  ) => probeCodex(fakeCommand(scenario), dataDir, lane, onModels);

  it("passes and lists models with no thread or prompt, keeping only the email", async () => {
    const models: unknown[] = [];
    const status = await probe("success", (list) => models.push(...list));
    expect(status).toEqual({
      cliFound: true,
      version: "0.167.0",
      auth: "authenticated",
      email: "owner@example.com",
      pauseReason: null,
    });
    expect(EngineStatus.parse(status)).toEqual(status);
    expect(models).toEqual([{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: ["low"] }]);
    expect(calls()).toEqual(["initialize", "initialized", "account/read", "model/list"]);
  });

  it("passes an API-key login on the API-key lane, and never passes on the key", async () => {
    const status = await probe("gate-api-key", undefined, "api_key");
    expect(status).toMatchObject({ auth: "authenticated", email: null, pauseReason: null });
    expect(JSON.stringify(status)).not.toContain("sk-planted");
  });

  it.each([
    ["gate-version", "9.9.9", "authenticated"],
    ["gate-no-version", null, "authenticated"],
    ["gate-no-account-read", "0.167.0", "unknown"],
  ] as const)("passes %s, reading version %s", async (scenario, version, auth) => {
    expect(await probe(scenario)).toMatchObject({ version, auth, pauseReason: null });
  });

  it.each([
    ["subscription", "gate-logged-out", "auth_failed", "unauthenticated"],
    ["subscription", "gate-api-key", "credential_source", "authenticated"],
    ["api_key", "success", "credential_source", "authenticated"],
  ] as const)(
    "on the %s lane, %s pauses with %s and lists nothing",
    async (lane, scenario, pauseReason, auth) => {
      const onModels = vi.fn();
      expect(await probe(scenario, onModels, lane)).toMatchObject({
        pauseReason,
        cliFound: true,
        auth,
      });
      expect(onModels).not.toHaveBeenCalled();
    },
  );

  it("tells a CLI that doesn't answer apart from a missing one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const status = probe("gate-silent");
      await vi.waitFor(() => expect(calls()).toContain("initialize"));
      await vi.advanceTimersByTimeAsync(36_000);
      expect(await status).toMatchObject({ cliFound: true, pauseReason: "cli_failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the static list when the reply lists nothing", async () => {
    const onModels = vi.fn();
    expect((await probe("model-list-empty", onModels)).pauseReason).toBeNull();
    expect(onModels).not.toHaveBeenCalled();
    expect(staticCodexModels.length).toBeGreaterThan(0);
  });

  it("pauses on a missing CLI", async () => {
    expect(await probeCodex(["beebot-no-such-cli"], dataDir, "subscription")).toMatchObject({
      pauseReason: "cli_missing",
      cliFound: false,
    });
  });
});

describe("through the real server, store and approvals", () => {
  const ownerToken = "t".repeat(43);

  async function boot(
    scenario: string,
    access: BotAccess = "supervised",
    lane: EngineLane = "subscription",
  ) {
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
      runTurn: createCodexRunTurn({ command: fakeCommand(scenario), dataDir }),
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
    });
    const params = new URLSearchParams({
      protocolVersion: String(protocolVersion),
      token: ownerToken,
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?${params}`);
    cleanups.push(() => socket.terminate());
    const messages: ServerMessage[] = [];
    socket.on("message", (data) => messages.push(ServerMessage.parse(JSON.parse(data.toString()))));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "subscribe", afterSeq: 0 }));
    const cards = () =>
      messages.flatMap((m) => (m.type === "pending-approvals" ? [m.approvals] : [])).at(-1);
    await vi.waitFor(() => expect(cards()).toBeDefined());

    const post = (body: Command) =>
      fetch(`http://127.0.0.1:${server.port}/commands?protocolVersion=${protocolVersion}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify(body),
      });
    const bot = (await (
      await post({
        type: "create-bot",
        name: "Ada",
        personality: "",
        engineAccountId: "claude",
        projectPath: null,
      })
    ).json()) as { id: string; roomId: string };
    await post({ type: "set-bot-engine", botId: bot.id, access });
    await post({ type: "set-account-lane", engineAccountId: "claude", lane });
    plantEnv("FAKE_PROJECT", workspacePath(dataDir, bot.id));
    await post({
      type: "send-message",
      messageId: NodeCrypto.randomUUID(),
      roomId: bot.roomId,
      body: "hello",
    });
    const nextCard = async () => {
      await vi.waitFor(() => expect(cards()).toHaveLength(1), { timeout: 5000 });
      return cards()?.[0] as PendingApproval;
    };
    const decide = (card: PendingApproval, decision: "allow" | "deny") =>
      post({
        type: "decide-approval",
        approvalId: card.id,
        digest: store.state().approvals.find(({ id }) => id === card.id)?.digest as string,
        decision,
      });
    return { nextCard, decide };
  }

  function rows(sql: string) {
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    try {
      return db.prepare(sql).all() as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  }

  const runFinished = () =>
    vi.waitFor(
      () => {
        const [run] = rows("SELECT status FROM runs");
        expect(run?.status).toMatch(/Completed|Failed|Cancelled/);
      },
      { timeout: 8000 },
    );
  const tainted = () => Number(rows("SELECT tainted FROM scopes")[0]?.tainted);
  const brokerKinds = "('allow', 'deny', 'approve', 'hand_off')";
  // The approval gate's own rows. The broker decides first and writes its rows too.
  const auditRows = () =>
    rows(
      `SELECT tool, status, reason FROM audit_log
       WHERE tool IS NOT NULL AND status NOT IN ${brokerKinds} ORDER BY id`,
    );
  const brokerRows = () =>
    rows(`SELECT tool, status FROM audit_log WHERE status IN ${brokerKinds} ORDER BY id`);

  it("holds a command for the owner and runs it on allow", async () => {
    const { nextCard, decide } = await boot("approve");
    const card = await nextCard();
    expect(card.detail).toBe("cat ~/secret-input.txt");
    await decide(card, "allow");
    await runFinished();
    expect(decisions()).toEqual(["accept"]);
    expect(auditRows()).toEqual([{ tool: "Bash", status: "allowed", reason: "owner" }]);
    expect(brokerRows()).toEqual([{ tool: "Bash", status: "allow" }]);
  });

  it("declines a command the owner denied", async () => {
    const { nextCard, decide } = await boot("approve");
    await decide(await nextCard(), "deny");
    await runFinished();
    expect(decisions()).toEqual(["decline"]);
  });

  it("shows a patch file by file, and applies it on allow", async () => {
    const { nextCard, decide } = await boot("patch-outside");
    const card = await nextCard();
    expect(card.change?.action).toBe("patch");
    expect(card.change?.files?.map(({ added }) => added)).toEqual(["one\n=== forged", "b"]);
    expect(card.change?.files?.[1]?.removed).toBe("a");
    await decide(card, "allow");
    await runFinished();
    expect(decisions()).toEqual(["accept"]);
  });

  it("denies a whole patch when one path is refused, with no card", async () => {
    await boot("patch-refused", "full");
    await runFinished();
    expect(decisions()).toEqual(["decline"]);
    expect(auditRows()).toEqual([{ tool: "Patch", status: "refused", reason: null }]);
  });

  it("lets Auto-accept edits pass a patch inside the folder", async () => {
    await boot("patch-inside", "auto-edits");
    await runFinished();
    expect(decisions()).toEqual(["accept"]);
    expect(auditRows()).toEqual([
      { tool: "Patch", status: "allowed", reason: "access:auto-edits" },
    ]);
  });

  it("holds an Auto-accept patch that reaches outside the folder", async () => {
    const { nextCard, decide } = await boot("patch-outside", "auto-edits");
    await decide(await nextCard(), "deny");
    await runFinished();
    expect(decisions()).toEqual(["decline"]);
  });

  it.each([
    ["unknown-item", 1],
    ["owner-mcp", 1],
    ["completion-only-item", 1],
    ["silent-items", 0],
    ["bee-only", 0],
  ])("%s leaves the scope's taint at %i", async (scenario, expected) => {
    await boot(scenario);
    await runFinished();
    expect(tainted()).toBe(expected);
  });

  it("keeps tool input beyond its detail, the token and the account out of the database and the logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method),
    );
    const { nextCard, decide } = await boot("approve");
    await decide(await nextCard(), "allow");
    await runFinished();
    const printed = JSON.stringify(spies.map((spy) => spy.mock.calls));
    vi.restoreAllMocks();
    const files = NodeFS.readdirSync(dataDir).filter((name) => name.startsWith("beebot.db"));
    // The reply keeps each tool's short detail on purpose, so only that may name the input.
    const stored = files
      .map((name) => NodeFS.readFileSync(NodePath.join(dataDir, name), "latin1"))
      .join("")
      .replace(/"detail":"[^"]*secret-input[^"]*"/g, "");
    for (const secret of ["secret-input", "owner@example.com", "Owner Workspace"]) {
      expect(stored).not.toContain(secret);
      expect(printed).not.toContain(secret);
    }
  });

  it("runs on the API-key lane without the key reaching the database or the logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method),
    );
    await boot("gate-api-key", "supervised", "api_key");
    await runFinished();
    const printed = JSON.stringify(spies.map((spy) => spy.mock.calls));
    vi.restoreAllMocks();
    expect(rows("SELECT status FROM runs")).toEqual([{ status: "Completed" }]);
    expect(rows("SELECT lane FROM engine_accounts WHERE id = 'claude'")).toEqual([
      { lane: "api_key" },
    ]);
    const stored = NodeFS.readdirSync(dataDir)
      .filter((name) => name.startsWith("beebot.db"))
      .map((name) => NodeFS.readFileSync(NodePath.join(dataDir, name), "latin1"))
      .join("");
    expect(stored).not.toContain("sk-planted");
    expect(printed).not.toContain("sk-planted");
  });
});
