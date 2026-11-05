import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { childEnv, createClaudeRunTurn, probeClaude, turnArgs } from "./claude.ts";
import type { BotLaunch } from "./engine.ts";

const fakeCli = NodePath.join(import.meta.dirname, "fixtures", "claude", "fake-claude.mjs");
const launch: BotLaunch = {
  botId: "7f0f6a55-5a4c-4c37-9d0b-2f3c1d2e6b10",
  name: "Ada",
  personality: "Terse.",
  engineAccountId: "claude",
};
const prompt = "the owner's private question";

let dataDir: string;
let logPath: string;
const plantedEnv: string[] = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-claude-"));
  logPath = NodePath.join(dataDir, "fake-cli.log");
});

afterEach(() => {
  for (const name of plantedEnv.splice(0)) {
    delete process.env[name];
  }
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

function plantEnv(name: string, value: string) {
  plantedEnv.push(name);
  process.env[name] = value;
}

const fakeCommand = (scenario: string) => [process.execPath, fakeCli, scenario, logPath];

type LogEntry = { pid?: number; args?: string[]; env?: string[]; prompt?: string };

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

function turn(scenario: string, signal = new AbortController().signal, resume = false) {
  const deltas: string[] = [];
  let delivered = 0;
  const outcome = createClaudeRunTurn({ command: fakeCommand(scenario), dataDir })({
    prompt,
    sessionId: "00000000-0000-4000-8000-000000000009",
    resume,
    launch,
    signal,
    onDelta: (text) => deltas.push(text),
    onDelivered: () => {
      delivered += 1;
    },
  });
  return { outcome, deltas, delivered: () => delivered };
}

describe("a turn", () => {
  it("streams text and completes from the result, writing the prompt once", async () => {
    const { outcome, deltas, delivered } = turn("success");
    expect(await outcome).toEqual({ kind: "completed", text: "noted" });
    expect(deltas.join("")).toBe("noted");
    expect(prompts()).toEqual([prompt]);
    expect(delivered()).toBe(1);
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
    expect(persona).toContain("You have no tools");

    NodeFS.writeFileSync(personaPath, "stale");
    await turn("success").outcome;
    expect(NodeFS.readFileSync(personaPath, "utf8")).toContain("Terse.");
  });

  it("passes the prompt on stdin only, with tools off and no banned flag", async () => {
    await turn("success").outcome;
    const args = spawns()[0]?.args ?? [];
    expect(args.join(" ")).not.toContain(prompt);
    expect(args.join(" ")).not.toMatch(
      /--bare|--safe-mode|--dangerously|bypassPermissions|--permission-mode/,
    );
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--system-prompt-snapshot") + 1]).toBe("off");
  });

  it("starts a session by ID and continues it with --resume", () => {
    expect(turnArgs("p", "s", false).slice(-2)).toEqual(["--session-id", "s"]);
    expect(turnArgs("p", "s", true).slice(-2)).toEqual(["--resume", "s"]);
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
  it.each(["gate-api-key", "gate-token", "gate-logged-out"])(
    "%s never writes the prompt and pauses the bot",
    async (scenario) => {
      const { outcome, delivered } = turn(scenario);
      expect(await outcome).toEqual({ kind: "auth_failed", pauseReason: "auth_failed" });
      expect(prompts()).toEqual([]);
      expect(delivered()).toBe(0);
    },
    15_000,
  );

  it("fails closed when the gate times out, and kills the child", async () => {
    const { outcome, delivered } = turn("gate-silent");
    expect(await outcome).toEqual({ kind: "auth_failed", pauseReason: "auth_failed" });
    expect(delivered()).toBe(0);
    await vi.waitFor(() => expect(isAlive(spawns()[0]?.pid ?? 0)).toBe(false));
  }, 15_000);

  it("pauses on a CLI that changed version since startup", async () => {
    expect(await turn("gate-version").outcome).toEqual({
      kind: "auth_failed",
      pauseReason: "cli_version",
    });
    expect(prompts()).toEqual([]);
  }, 15_000);

  it("pauses on a missing CLI", async () => {
    const outcome = await createClaudeRunTurn({ command: ["beebot-no-such-cli"], dataDir })({
      prompt,
      sessionId: "s",
      resume: false,
      launch,
      signal: new AbortController().signal,
      onDelta: () => {},
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

  it("clears names case-insensitively, as Windows treats them", () => {
    expect(childEnv({ anthropic_api_key: "x", PATH: "p" })).not.toHaveProperty("anthropic_api_key");
    expect(childEnv({ PATH: "p" })).toHaveProperty("PATH", "p");
  });
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

describe("the startup probe", () => {
  it("passes on the tested version and a subscription login", async () => {
    expect(await probeClaude(fakeCommand("success"), dataDir)).toBeUndefined();
  });

  it.each([
    ["gate-version", "cli_version"],
    ["logged-out-status", "auth_failed"],
    ["api-key-status", "auth_failed"],
  ])("%s pauses with %s", async (scenario, reason) => {
    expect(await probeClaude(fakeCommand(scenario), dataDir)).toBe(reason);
  });

  it("pauses on a missing CLI", async () => {
    expect(await probeClaude(["beebot-no-such-cli"], dataDir)).toBe("cli_missing");
  });

  it("names the cleared config dir", async () => {
    plantEnv("CLAUDE_CONFIG_DIR", "somewhere");
    expect(await probeClaude(fakeCommand("logged-out-status"), dataDir)).toBe("config_dir");
  });
});
