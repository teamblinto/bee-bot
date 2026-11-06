import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { BotModel, EngineStatus, PauseReason } from "@beebot/contracts";
import { z } from "zod";

import { type BotLaunch, type RunTurn, type TurnOutcome, workspacePath } from "./engine.ts";

export const testedClaudeVersion = "2.1.318";
// Empty, not `user`: `user` loads the owner's plugins, hooks and CLAUDE.md into every bot.
const settingSources = "";
const toolList = "Read,Write,Edit,Glob,Grep,Bash";
// Without `ask`, `Bash ls`, `Bash cat` and in-workspace reads never reach the permission tool.
const askSettings = JSON.stringify({ permissions: { ask: ["Bash", "Read", "Glob", "Grep"] } });
const permissionTool = "mcp__bee__approve";
const mcpTimeoutMs = 900_000;

const gateTimeoutMs = 5000;
const lingerMs = 5000;
const stopGraceMs = 5000;
const closeGraceMs = 1000;
const maxApiRetries = 5;
const defaultLimitMs = 5 * 60_000;
const stderrTailChars = 4096;

const initializeLine = `${JSON.stringify({
  type: "control_request",
  request_id: "init-1",
  request: { subtype: "initialize" },
})}\n`;

const clearedEnv =
  /^(ANTHROPIC_|CLAUDE|T3CODE|AWS_|GOOGLE_APPLICATION|VERTEX_|CLOUD_ML_|DISABLE_|MCP_|ELECTRON_RUN_AS_NODE$)/i;

export function childEnv(parent: NodeJS.ProcessEnv = process.env) {
  return {
    ...Object.fromEntries(Object.entries(parent).filter(([name]) => !clearedEnv.test(name))),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  };
}

// The child can't see this variable, so its login may live in the config dir we just hid.
const authPause = (): PauseReason => (process.env.CLAUDE_CONFIG_DIR ? "config_dir" : "auth_failed");

export function turnArgs(
  personaPath: string,
  sessionId: string,
  resume: boolean,
  model: BotModel,
  configPath: string,
) {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    model,
    "--setting-sources",
    settingSources,
    "--strict-mcp-config",
    "--tools",
    toolList,
    "--settings",
    askSettings,
    "--mcp-config",
    configPath,
    "--permission-prompt-tool",
    permissionTool,
    // On by default, and on means a persona edit never reaches an existing session.
    "--system-prompt-snapshot",
    "off",
    "--append-system-prompt-file",
    personaPath,
    resume ? "--resume" : "--session-id",
    sessionId,
  ];
}

const loose = z.unknown().optional();

const Frame = z.object({
  type: z.string(),
  subtype: loose,
  error: loose,
  errors: loose,
  is_error: loose,
  result: loose,
  api_error: loose,
  api_error_status: loose,
  event: z
    .object({
      type: loose,
      delta: z.object({ type: loose, text: z.unknown() }).optional(),
      content_block: z.object({ type: loose, name: loose }).optional(),
    })
    .optional(),
  rate_limit_info: z
    .object({
      status: loose,
      resetsAt: loose,
      overageStatus: loose,
      isUsingOverage: loose,
    })
    .optional(),
  response: z
    .object({
      request_id: loose,
      response: z
        .object({
          claude_code_version: loose,
          account: z
            .object({
              subscriptionType: loose,
              apiProvider: loose,
              apiKeySource: loose,
              tokenSource: loose,
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});
type Frame = z.infer<typeof Frame>;

// Frames can quote the prompt, so a bad line is dropped without a trace. A missing `result` fails.
function parseFrame(line: string) {
  try {
    return Frame.safeParse(JSON.parse(line)).data;
  } catch {
    return undefined;
  }
}

function gateRejection(frame: Frame) {
  const reply = frame.response?.response;
  if (reply?.claude_code_version !== testedClaudeVersion) {
    return "cli_version";
  }
  const account = reply.account;
  const subscription =
    Boolean(account?.subscriptionType) &&
    account?.apiProvider === "firstParty" &&
    !account.apiKeySource &&
    (account.tokenSource ?? "claude.ai") === "claude.ai";
  return subscription ? undefined : authPause();
}

type Seen = {
  result: Frame | undefined;
  assistantError: unknown;
  apiStatus: unknown;
  rateLimit: Frame["rate_limit_info"];
};

function retryAfterMs(rateLimit: Seen["rateLimit"]) {
  const resetsAt = rateLimit?.resetsAt;
  return typeof resetsAt === "number" ? resetsAt * 1000 - Date.now() : defaultLimitMs;
}

// Never branch on `subtype`: a failed login reports `subtype:"success"` with `is_error:true`.
function mapResult({ result, assistantError, apiStatus, rateLimit }: Seen): TurnOutcome {
  if (result?.is_error === false && typeof result.result === "string") {
    return { kind: "completed", text: result.result };
  }
  if (
    assistantError === "authentication_failed" ||
    (result?.is_error === true && apiStatus === 401)
  ) {
    return { kind: "auth_failed", pauseReason: authPause() };
  }
  // shortcut: no real limit frame was ever captured, so these shapes come from other projects'
  // code and may be wrong. Replace them with a capture the first time a real limit happens.
  const rejected =
    rateLimit?.status === "rejected" &&
    rateLimit.isUsingOverage !== true &&
    rateLimit.overageStatus !== "allowed";
  if (
    rejected ||
    result?.api_error === "usage_limit_reached" ||
    assistantError === "rate_limit" ||
    apiStatus === 429
  ) {
    return { kind: "limited", retryAfterMs: retryAfterMs(rateLimit) };
  }
  return { kind: "failed" };
}

function killTree(pid: number) {
  if (process.platform === "win32") {
    NodeChildProcess.spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

type Attempt = {
  command: readonly string[];
  args: string[];
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onTool: (name: string) => void;
  onDelivered: () => void;
};

function runProcess({ command, args, cwd, prompt, signal, onDelta, onTool, onDelivered }: Attempt) {
  return new Promise<TurnOutcome | "in_use">((resolve) => {
    const [file = "", ...prefix] = command;
    const child = NodeChildProcess.spawn(file, [...prefix, ...args], {
      cwd,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Its own group, so a POSIX stop reaches the whole tree.
      detached: process.platform !== "win32",
    });

    const seen: Seen = {
      result: undefined,
      assistantError: undefined,
      apiStatus: undefined,
      rateLimit: undefined,
    };
    const timers = new Set<NodeJS.Timeout>();
    let gate: "pending" | "open" | PauseReason = "pending";
    let spawnFailed = false;
    let sessionMissing = false;
    let apiRetries = 0;
    let stdout = "";
    let stderr = "";
    let stopping = false;
    let settled = false;

    const after = (ms: number, work: () => void) => timers.add(setTimeout(work, ms));

    function stop() {
      if (stopping) {
        return;
      }
      stopping = true;
      if (child.pid !== undefined) {
        killTree(child.pid);
      }
      // A stop must settle the turn even if the kill silently failed.
      after(stopGraceMs, finish);
    }

    function outcome() {
      // Both come before the gate. Later, the prompt is out and stderr is only noise that must not
      // turn a good reply into a retry that sends the prompt again.
      if (gate === "pending" && /Session ID \S+ is already in use/.test(stderr)) {
        return "in_use";
      }
      if (gate === "pending" && (sessionMissing || stderr.includes("No conversation found"))) {
        return { kind: "session_lost" } satisfies TurnOutcome;
      }
      if (spawnFailed) {
        return { kind: "auth_failed", pauseReason: "cli_missing" } satisfies TurnOutcome;
      }
      if (gate === "open") {
        return mapResult(seen);
      }
      if (gate === "pending" && signal.aborted) {
        return { kind: "failed" } satisfies TurnOutcome;
      }
      return {
        kind: "auth_failed",
        pauseReason: gate === "pending" ? authPause() : gate,
      } satisfies TurnOutcome;
    }

    function finish() {
      if (settled) {
        return;
      }
      onLine(stdout);
      settled = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      signal.removeEventListener("abort", stop);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(outcome());
    }

    function openGate(frame: Frame) {
      const rejection = gateRejection(frame);
      if (rejection) {
        gate = rejection;
        child.stdin.end();
        stop();
        return;
      }
      gate = "open";
      const message = { role: "user", content: [{ type: "text", text: prompt }] };
      child.stdin.write(`${JSON.stringify({ type: "user", message })}\n`, (error) => {
        if (!error) {
          onDelivered();
        }
      });
      child.stdin.end();
    }

    function onLine(line: string) {
      const frame = line.trim() ? parseFrame(line) : undefined;
      if (!frame || settled) {
        return;
      }
      seen.apiStatus = frame.api_error_status ?? seen.apiStatus;
      seen.rateLimit = frame.rate_limit_info ?? seen.rateLimit;
      if (frame.type === "control_response") {
        const ended = stopping || seen.result !== undefined;
        if (gate === "pending" && !ended && frame.response?.request_id === "init-1") {
          openGate(frame);
        }
      } else if (frame.type === "stream_event") {
        const delta = frame.event?.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          onDelta(delta.text);
        }
        const block = frame.event?.content_block;
        if (
          frame.event?.type === "content_block_start" &&
          block?.type === "tool_use" &&
          typeof block.name === "string"
        ) {
          onTool(block.name);
        }
      } else if (frame.type === "assistant") {
        seen.assistantError = frame.error ?? seen.assistantError;
      } else if (frame.type === "system" && frame.subtype === "api_retry") {
        apiRetries += 1;
        if (apiRetries >= maxApiRetries) {
          stop();
        }
      } else if (frame.type === "result") {
        seen.result = frame;
        sessionMissing ||= JSON.stringify(frame.errors ?? "").includes("No conversation found");
        after(lingerMs, stop);
      }
    }

    child.once("error", () => {
      if (child.pid === undefined) {
        spawnFailed = true;
        finish();
      }
    });
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (stdout + chunk).split("\n");
      stdout = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-stderrTailChars);
    });
    // A detached grandchild can hold the pipes open forever, so `close` alone can't be awaited.
    child.once("exit", () => after(closeGraceMs, finish));
    child.once("close", finish);

    after(gateTimeoutMs, () => {
      if (gate === "pending") {
        gate = authPause();
        child.stdin.end();
        stop();
      }
    });
    signal.addEventListener("abort", stop, { once: true });
    child.stdin.write(initializeLine);
  });
}

function personaText({ name, personality }: BotLaunch) {
  return [`Your name is ${name}.`, personality].filter(Boolean).join("\n\n");
}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

// Created empty and tightened before the content goes in, so the token never sits in a looser file.
export async function writeMcpConfig(path: string, url: string, token: string) {
  await NodeFS.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  await (await NodeFS.open(path, "wx", 0o600)).close();
  if (process.platform === "win32") {
    const grant = `${NodeOS.userInfo().username}:F`;
    await execFile("icacls", [path, "/inheritance:r", "/grant:r", grant], { windowsHide: true });
  }
  const bee = {
    type: "http",
    timeout: mcpTimeoutMs,
    url,
    headers: { Authorization: `Bearer ${token}` },
  };
  await NodeFS.writeFile(path, JSON.stringify({ mcpServers: { bee } }));
}

type Options = { command: readonly string[]; dataDir: string };

export function createClaudeRunTurn({ command, dataDir }: Options): RunTurn {
  return async ({
    prompt,
    sessionId,
    resume,
    launch,
    signal,
    onDelta,
    onTool,
    onDelivered,
    permissions,
  }) => {
    const cwd = workspacePath(dataDir, launch.botId);
    const personaPath = NodePath.join(NodePath.dirname(cwd), "persona.md");
    await NodeFS.mkdir(cwd, { recursive: true });
    await NodeFS.writeFile(personaPath, personaText(launch));

    const name = `${NodeCrypto.randomBytes(16).toString("hex")}.json`;
    const configPath = NodePath.join(dataDir, "runtime", name);
    const attempt = (asResume: boolean) =>
      runProcess({
        command,
        args: turnArgs(personaPath, sessionId, asResume, launch.model, configPath),
        cwd,
        prompt,
        signal,
        onDelta,
        onTool,
        onDelivered,
      });
    if (signal.aborted) {
      return { kind: "failed" };
    }
    try {
      await writeMcpConfig(configPath, permissions.url, permissions.token);
      const first = await attempt(resume);
      const outcome = first === "in_use" && !signal.aborted ? await attempt(true) : first;
      return outcome === "in_use" ? { kind: "failed" } : outcome;
    } finally {
      // Never fails the turn: the token dies with the run, and the next boot wipes the directory.
      await NodeFS.rm(configPath, { force: true }).catch(() => {});
    }
  };
}

const AuthStatus = z.object({
  authMethod: loose,
  apiProvider: loose,
  apiKeySource: loose,
});

// Holds the owner's email and org, so nothing from either command may be logged or stored.
export async function probeEngine(command: readonly string[], cwd: string): Promise<EngineStatus> {
  const status = (pauseReason: PauseReason | null, cliFound = true, versionOk = true) => ({
    cliFound,
    versionOk,
    loggedIn: pauseReason === null,
    pauseReason,
    testedVersion: testedClaudeVersion,
  });
  const [file = "", ...prefix] = command;
  const run = (...args: string[]) =>
    execFile(file, [...prefix, ...args], {
      cwd,
      env: childEnv(),
      timeout: gateTimeoutMs,
      windowsHide: true,
    });
  let version: string;
  try {
    version = (await run("--version")).stdout;
  } catch {
    return status("cli_missing", false, false);
  }
  if (version.trim().split(/\s/)[0] !== testedClaudeVersion) {
    return status("cli_version", true, false);
  }
  try {
    const auth = AuthStatus.parse(JSON.parse((await run("auth", "status", "--json")).stdout));
    const subscription =
      auth.authMethod === "claude.ai" && auth.apiProvider === "firstParty" && !auth.apiKeySource;
    return status(subscription ? null : authPause());
  } catch {
    return status(authPause());
  }
}
