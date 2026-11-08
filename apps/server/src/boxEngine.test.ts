import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type BoxLayout,
  createAccountGate,
  credentialMapping,
  supportsSecureStorageDir,
} from "./boxEngine.ts";
import {
  type BoxAttach,
  type BoxExec,
  type BoxRuntime,
  createFakeBoxRuntime,
} from "./boxRuntime.ts";
import { boxTurnArgs, createClaudeRunTurn } from "./claude.ts";
import { createCodexRunTurn } from "./codex.ts";
import type { BotLaunch, RunTurn } from "./engine.ts";

const fixtures = NodePath.join(import.meta.dirname, "fixtures");
const fakeClaude = NodePath.join(fixtures, "claude", "fake-claude.mjs");
const fakeCodex = NodePath.join(fixtures, "codex", "fake-codex.mjs");
const token = "run-token-that-must-stay-secret";
const permissions = { url: "http://127.0.0.1:9/mcp", token };

let dataDir: string;
let logPath: string;

beforeEach(() => {
  dataDir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-box-")));
  logPath = NodePath.join(dataDir, "fake-cli.log");
});

afterEach(async () => {
  await vi.waitFor(() => NodeFS.rmSync(dataDir, { recursive: true, force: true }));
});

const launchFor = (botId: string, engineAccountId: string, lane: BotLaunch["lane"]): BotLaunch => ({
  botId,
  name: "Ada",
  personality: "Terse.",
  engineAccountId,
  lane,
  model: "opus",
  effort: null,
  mode: "build",
  projectPath: null,
  memory: "",
});

// The fake runtime runs the box's command on this machine, so the box's paths are this machine's.
function testLayout(botId: string): BoxLayout {
  const beeDir = NodePath.join(dataDir, "bee", botId);
  return {
    home: NodePath.join(dataDir, "home"),
    workdir: dataDir,
    claudeBinary: NodePath.join(dataDir, "no-claude-here"),
    credentialDir: "/run/bee/credential",
    beeDir: { host: () => beeDir, box: beeDir },
    apiLane: "http://proxy.test:8080",
    beeUrl: (hostUrl) => `http://proxy.test:8080/bee${new URL(hostUrl).pathname}`,
    env: Object.fromEntries(
      ["PATH", "Path", "SystemRoot", "TEMP", "TMP"].flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    ),
  };
}

const cleanExit = (): BoxAttach => {
  const stream = new PassThrough();
  stream.end();
  return { stream, exited: Promise.resolve(0) };
};

type Seen = { botId: string; exec: BoxExec; attach: BoxAttach };

// A fake runtime that answers CODEX_HOME's preparation itself, records every engine attach, and
// lets a test act on one.
async function boxRuntime(botIds: string[], onAttach: (seen: Seen) => void = () => {}) {
  const fake = createFakeBoxRuntime();
  for (const id of botIds) {
    await fake.create(id);
    await fake.start(id);
  }
  const prepared: string[][] = [];
  const runtime: BoxRuntime = {
    ...fake,
    writeBotFile: async (botId, name, content) => {
      const dir = testLayout(botId).beeDir.box;
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, name), content);
    },
    execAttach: async (botId, exec) => {
      if (exec.argv[0] === "sh") {
        prepared.push(exec.argv);
        return cleanExit();
      }
      const attach = await fake.execAttach(botId, exec);
      onAttach({ botId, exec, attach });
      return attach;
    },
  };
  return { runtime, prepared };
}

type Entry = { pid?: number; args?: string[]; env?: string[]; mcpConfig?: string };
const logged = (): Entry =>
  NodeFS.readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .reduce<Entry>((all, line) => Object.assign(all, JSON.parse(line) as Entry), {});

const noop = () => {};
function turn(
  runTurn: RunTurn,
  launch: BotLaunch,
  signal = new AbortController().signal,
  onDelivered = noop,
) {
  return runTurn({
    prompt: "the owner's private question",
    sessionId: "00000000-0000-4000-8000-000000000001",
    resume: false,
    launch,
    signal,
    onDelta: noop,
    onToolStart: noop,
    onToolEnd: noop,
    onThinking: noop,
    onRateLimit: noop,
    permissions,
    onDelivered,
    onSessionId: noop,
    approve: async () => ({ behavior: "deny", message: "no" }),
  });
}

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe("credentialMapping", () => {
  const base = { accountId: "claude", dataDir: "/data", layout: { credentialDir: "/run/bee/c" } };

  it("shares Claude's credential directory only when the CLI can be pointed at it", () => {
    expect(credentialMapping({ ...base, engine: "claude", secureStorageDir: true })).toEqual({
      kind: "shared",
      hostDir: NodePath.join("/data", "credentials", "claude"),
      boxDir: "/run/bee/c",
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/run/bee/c" },
    });
    // Never a symlinked file: Claude's rename would replace the link.
    expect(credentialMapping({ ...base, engine: "claude", secureStorageDir: false })).toEqual({
      kind: "per_box",
    });
  });

  it("links Codex's auth.json into the shared directory, never mounting the file", () => {
    const mapping = credentialMapping({
      ...base,
      accountId: "codex",
      engine: "codex",
      secureStorageDir: false,
    });
    expect(mapping).toMatchObject({ kind: "shared", env: {}, link: "/run/bee/c/auth.json" });
  });
});

describe("supportsSecureStorageDir", () => {
  const answering = (code: number | null): BoxRuntime => ({
    ...createFakeBoxRuntime(),
    execAttach: async () => ({ ...cleanExit(), exited: Promise.resolve(code) }),
  });

  it("is true only when the installed binary names the variable", async () => {
    expect(await supportsSecureStorageDir(answering(0), "b", "/claude", {})).toBe(true);
    expect(await supportsSecureStorageDir(answering(1), "b", "/claude", {})).toBe(false);
    expect(await supportsSecureStorageDir(createFakeBoxRuntime(), "b", "/claude", {})).toBe(false);
  });
});

describe("createAccountGate", () => {
  it("holds a second session on the same account until the first lets go", async () => {
    const gate = createAccountGate();
    const first = await gate("codex", new AbortController().signal);
    let second: (() => void) | undefined;
    const waiting = gate("codex", new AbortController().signal).then((release) => {
      second = release;
    });
    const other = await gate("codex-2", new AbortController().signal);
    expect(other).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second).toBeUndefined();
    first?.();
    await waiting;
    expect(second).toBeDefined();
  });

  it("lets a waiter that gave up pass its place on", async () => {
    const gate = createAccountGate();
    const first = await gate("codex", new AbortController().signal);
    const quitting = new AbortController();
    const gaveUp = gate("codex", quitting.signal);
    const third = gate("codex", new AbortController().signal);
    quitting.abort();
    expect(await gaveUp).toBeUndefined();
    first?.();
    expect(await third).toBeDefined();
  });
});

describe("Claude in a box", () => {
  const botId = "bot-claude";

  it("launches through exec-attach with dontAsk, an exact allowlist and a blocking broker hook", async () => {
    const { runtime } = await boxRuntime([botId]);
    const runTurn = createClaudeRunTurn({
      command: [process.execPath, fakeClaude, "success", logPath],
      dataDir,
      box: { runtime, layout: testLayout(botId) },
    });
    expect(await turn(runTurn, launchFor(botId, "claude", "subscription"))).toMatchObject({
      kind: "completed",
    });
    const { args = [], env = [], mcpConfig = "" } = logged();
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag("--permission-mode")).toBe("dontAsk");
    expect(flag("--setting-sources")).toBe("");
    expect(flag("--allowedTools")?.split(",")).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      ...[
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
      ].map((name) => `mcp__bee__${name}`),
    ]);
    expect(args).not.toContain("--permission-prompt-tool");
    expect(JSON.parse(flag("--settings") ?? "")).toMatchObject({
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "http",
                url: "http://proxy.test:8080/bee/hooks/pre-tool-use",
                onFailure: "block",
                allowedEnvVars: ["BEE_RUN_TOKEN"],
              },
            ],
          },
        ],
      },
    });
    expect(JSON.parse(mcpConfig)).toMatchObject({
      mcpServers: { bee: { url: "http://proxy.test:8080/bee/mcp" } },
    });
    expect(JSON.stringify(args)).not.toContain(token);
    expect(JSON.stringify(args)).not.toContain("private question");
    expect(env).toContain("BEE_RUN_TOKEN");
    expect(env).not.toContain("ANTHROPIC_API_KEY");
  });

  it("points the API lane at the proxy with a placeholder, and accepts that as the lane's key", async () => {
    const { runtime } = await boxRuntime([botId]);
    const runTurn = createClaudeRunTurn({
      command: [process.execPath, fakeClaude, "gate-proxy-key", logPath],
      dataDir,
      box: { runtime, layout: testLayout(botId) },
    });
    expect(await turn(runTurn, launchFor(botId, "claude", "api_key"))).toMatchObject({
      kind: "completed",
    });
    const { env = [] } = logged();
    expect(env).toEqual(expect.arrayContaining(["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"]));
  });

  it("ends the turn and the process when the attach drops", async () => {
    let drop = noop;
    const { runtime } = await boxRuntime([botId], ({ attach }) => {
      drop = () => attach.stream.destroy(new Error("attach dropped"));
    });
    const runTurn = createClaudeRunTurn({
      command: [process.execPath, fakeClaude, "hang", logPath],
      dataDir,
      box: { runtime, layout: testLayout(botId) },
    });
    const started = Date.now();
    const outcome = await turn(runTurn, launchFor(botId, "claude", "subscription"), undefined, () =>
      setTimeout(() => drop(), 100),
    );
    expect(outcome).toEqual({ kind: "failed" });
    expect(Date.now() - started).toBeLessThan(4000);
    const { pid = 0 } = logged();
    await vi.waitFor(() => expect(gone(pid)).toBe(true));
  });

  it("keeps the persona off argv", () => {
    const args = boxTurnArgs(
      "/run/bee/bot/persona.md",
      "s",
      false,
      {
        model: "opus",
        effort: null,
        mode: "plan",
      },
      { mcp: "m", hook: "h" },
    );
    expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe("/run/bee/bot/persona.md");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
  });
});

describe("Codex in a box", () => {
  it("gets its own CODEX_HOME with the rules cleared, and an untrusted workspace", async () => {
    const { runtime, prepared } = await boxRuntime(["bot-codex"]);
    const layout = testLayout("bot-codex");
    const runTurn = createCodexRunTurn({
      command: [process.execPath, fakeCodex, "success", logPath],
      dataDir,
      box: { runtime, layout },
    });
    expect(await turn(runTurn, launchFor("bot-codex", "codex", "subscription"))).toMatchObject({
      kind: "completed",
    });
    const codexHome = `${layout.home}/.codex`;
    expect(prepared).toEqual([
      [
        "sh",
        "-c",
        expect.stringContaining('rm -rf "$1/rules"'),
        "sh",
        codexHome,
        "/run/bee/credential/auth.json",
      ],
    ]);
    const { args = [], env = [] } = logged();
    expect(args.join(" ")).toContain(`${JSON.stringify(dataDir)}={trust_level="untrusted"}`);
    expect(args).toContain('forced_login_method="chatgpt"');
    expect(env).toContain("CODEX_HOME");
    expect(JSON.stringify(args)).not.toContain(token);
  });

  it("sends the API lane to the proxy with no login and no key in the box", async () => {
    const { runtime, prepared } = await boxRuntime(["bot-codex"]);
    const runTurn = createCodexRunTurn({
      command: [process.execPath, fakeCodex, "gate-logged-out", logPath],
      dataDir,
      box: { runtime, layout: testLayout("bot-codex") },
    });
    expect(await turn(runTurn, launchFor("bot-codex", "codex", "api_key"))).toMatchObject({
      kind: "completed",
    });
    expect(prepared[0]?.at(-1)).toBe("");
    const { args = [], env = [] } = logged();
    expect(args).toContain('model_provider="bee"');
    expect(args.join(" ")).toContain('base_url = "http://proxy.test:8080/openai/v1"');
    expect(args.join(" ")).not.toContain("forced_login_method");
    expect(env.filter((name) => /OPENAI|API_KEY/i.test(name))).toEqual([]);
  });

  it("makes a second subscription bot on the same account wait for the first app-server to go", async () => {
    const events: string[] = [];
    const { runtime } = await boxRuntime(["bot-a", "bot-b"], ({ botId, attach }) => {
      events.push(`${botId} attached`);
      void attach.exited.then(() => events.push(`${botId} gone`));
    });
    // Ignores the end of stdin, so it outlives its turn until the kill.
    const runTurn = createCodexRunTurn({
      command: [process.execPath, fakeCodex, "linger-after-stdin", logPath],
      dataDir,
      box: { runtime, layout: testLayout("bot-a") },
    });
    const first = turn(runTurn, launchFor("bot-a", "codex", "subscription"));
    await vi.waitFor(() => expect(events).toContain("bot-a attached"));
    const second = turn(runTurn, launchFor("bot-b", "codex", "subscription"));
    expect(await first).toMatchObject({ kind: "completed" });
    expect(await second).toMatchObject({ kind: "completed" });
    expect(events.indexOf("bot-b attached")).toBeGreaterThan(events.indexOf("bot-a gone"));
    expect(events.indexOf("bot-a gone")).toBeGreaterThan(-1);
  });

  it("ends the turn when the attach drops", async () => {
    let drop = noop;
    const { runtime } = await boxRuntime(["bot-codex"], ({ attach }) => {
      drop = () => attach.stream.destroy(new Error("attach dropped"));
    });
    const runTurn = createCodexRunTurn({
      command: [process.execPath, fakeCodex, "hang", logPath],
      dataDir,
      box: { runtime, layout: testLayout("bot-codex") },
    });
    const outcome = await turn(
      runTurn,
      launchFor("bot-codex", "codex", "subscription"),
      undefined,
      () => setTimeout(() => drop(), 100),
    );
    expect(outcome).toEqual({ kind: "failed" });
    const { pid = 0 } = logged();
    await vi.waitFor(() => expect(gone(pid)).toBe(true));
  });
});
