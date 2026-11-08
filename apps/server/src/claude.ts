import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  Effort,
  type EngineLane,
  type EngineModel,
  type EngineStatus,
  type PauseReason,
} from "@beebot/contracts";
import { z } from "zod";

import {
  cliVersion,
  type EngineChoice,
  killTree,
  personaText,
  type RunTurn,
  spawnMissing,
  type Steer,
  type ThinkingState,
  toolDetail,
  type ToolStart,
  type TurnOutcome,
  workingFolder,
  workspacePath,
} from "./engine.ts";
import { cleanSummary, type Summarize, summaryInstructions, summaryPrompt } from "./summary.ts";
import {
  claudeRateLimitEventToUpdate,
  claudeUsageResponseToLimits,
  unavailableProbe,
  type UsageProbe,
  UsageReply,
  type WindowUpdate,
} from "./usage.ts";
import { type AwakeClock, awakeTimeout, createAwakeClock } from "./watchdog.ts";

// Empty, not `user`: `user` loads the owner's plugins, hooks and CLAUDE.md into every bot.
const settingSources = "";
const toolList = "Read,Write,Edit,Glob,Grep,Bash";
// Without `ask`, `Bash ls`, `Bash cat` and in-workspace reads never reach the permission tool.
// Exact names: `allow` keeps these off the permission tool, whose schema refuses them, and a call
// reaching `approve` would taint the scope. A new bee tool must be added here on purpose.
const askSettings = JSON.stringify({
  // Relative to the workspace. Plan mode writes this file without asking, and the default is under
  // ~/.claude, a path no bot may touch.
  plansDirectory: ".plans",
  permissions: {
    ask: ["Bash", "Read", "Glob", "Grep"],
    allow: [
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
    ].map((name) => `mcp__bee__${name}`),
  },
});
const permissionTool = "mcp__bee__approve";
const mcpTimeoutMs = 900_000;

const gateTimeoutMs = 5000;
const lingerMs = 5000;
const stopGraceMs = 5000;
const closeGraceMs = 1000;
const maxApiRetries = 5;
const defaultLimitMs = 5 * 60_000;
const stderrTailChars = 4096;
const steerNote = "New input arrived, so your turn was stopped. Carry on with this in mind:";
const cutOffNote =
  "Your turn was stopped while a tool was running, so it may or may not have taken effect. Check before you repeat it, then carry on.";
const usageTimeoutMs = 15_000;

const initializeLine = `${JSON.stringify({
  type: "control_request",
  request_id: "init-1",
  request: { subtype: "initialize" },
})}\n`;

const usageLine = `${JSON.stringify({
  type: "control_request",
  request_id: "usage-1",
  request: { subtype: "get_usage" },
})}\n`;

// The Git Bash path stays: without it the CLI can lose the Bash tool on Windows.
const clearedEnv =
  /^(?!CLAUDE_CODE_GIT_BASH_PATH$)(ANTHROPIC_|CLAUDE|T3CODE|AWS_|GOOGLE_APPLICATION|VERTEX_|CLOUD_ML_|DISABLE_|MCP_|ELECTRON_RUN_AS_NODE$)/i;

export function childEnv(parent: NodeJS.ProcessEnv = process.env) {
  return {
    ...Object.fromEntries(Object.entries(parent).filter(([name]) => !clearedEnv.test(name))),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  };
}

// The child can't see this variable, so its login may live in the config dir we just hid.
const authPause = (): PauseReason => (process.env.CLAUDE_CONFIG_DIR ? "config_dir" : "auth_failed");

const allEfforts = Effort.options;

// Used until the CLI's `initialize` reply lists the real models.
export const staticClaudeModels: EngineModel[] = [
  { id: "fable", label: "Fable", efforts: allEfforts },
  { id: "opus", label: "Opus", efforts: allEfforts },
  { id: "sonnet", label: "Sonnet", efforts: allEfforts },
  { id: "haiku", label: "Haiku", efforts: allEfforts },
];

const CliModel = z.object({
  value: z.string().min(1),
  displayName: z.string().min(1),
  supportedEffortLevels: z.array(z.string()).optional(),
});

// `default` follows whatever the CLI picks today, so a bot on it could change model unasked.
export function modelsFromInitialize(models: unknown): EngineModel[] | undefined {
  const listed = z
    .array(CliModel)
    .safeParse(models)
    .data?.filter(({ value }) => value !== "default")
    .map(({ value, displayName, supportedEffortLevels = [] }) => ({
      id: value,
      label: displayName,
      efforts: supportedEffortLevels.flatMap((level) => Effort.safeParse(level).data ?? []),
    }));
  return listed?.length ? listed : undefined;
}

export function turnArgs(
  personaPath: string,
  sessionId: string,
  resume: boolean,
  { model, effort, mode }: EngineChoice,
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
    ...(effort ? ["--effort", effort] : []),
    // The only mode that ever reaches the CLI: approvals stay with the permission tool below.
    ...(mode === "plan" ? ["--permission-mode", "plan"] : []),
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

// Carries the full tool input and thought. Only `toolDetail` may read from it, and nothing may log it.
const Block = z.object({
  type: loose,
  id: loose,
  name: loose,
  input: loose,
  tool_use_id: loose,
  is_error: loose,
});

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
      index: loose,
      delta: z.object({ type: loose, text: loose, thinking: loose }).optional(),
      content_block: z.object({ type: loose, id: loose, name: loose }).optional(),
    })
    .optional(),
  // `.catch`: a user frame's content can be a plain string, and a shape change here must never cost
  // the frame's `error` or the turn's result.
  message: z
    .object({ content: z.array(Block).catch([]) })
    .optional()
    .catch(undefined),
  rate_limit_info: z
    .object({
      status: loose,
      resetsAt: loose,
      overageStatus: loose,
      isUsingOverage: loose,
      rateLimitType: loose,
      utilization: loose,
      unifiedWindows: loose,
    })
    .optional(),
  response: z
    .object({
      request_id: loose,
      response: z
        .object({
          models: loose,
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

// shortcut: unverified, no Console login was ever captured. This is the name the CLI is believed to
// give a key that `claude auth login` stored. Replace it with a capture.
const consoleKeySource = "/login managed key";

type Credential = { firstParty: boolean; plan: boolean; apiKeySource: unknown; token: unknown };

// The one check for the run gate and the startup probe. A login the lane doesn't use is never
// switched to: the bot pauses until the owner logs the CLI in the lane's way.
function credentialPause(lane: EngineLane, credential: Credential) {
  const { plan, apiKeySource, token } = credential;
  if (!plan && !apiKeySource && (token === undefined || token === "none")) {
    return authPause();
  }
  return resolvedLane(credential) === lane ? undefined : "credential_source";
}

function resolvedLane({ firstParty, plan, apiKeySource, token }: Credential) {
  if (!firstParty) {
    return undefined;
  }
  if (apiKeySource) {
    return apiKeySource === consoleKeySource && !plan ? "api_key" : undefined;
  }
  return plan && (token ?? "claude.ai") === "claude.ai" ? "subscription" : undefined;
}

// The CLI's version is never checked. A CLI that doesn't report its login here can't have its lane
// checked, so the turn goes ahead and a failed login still surfaces from the result.
function gateRejection(frame: Frame, lane: EngineLane) {
  const account = frame.response?.response?.account;
  if (!account) {
    return undefined;
  }
  return credentialPause(lane, {
    firstParty: account.apiProvider === "firstParty",
    plan: Boolean(account.subscriptionType),
    apiKeySource: account.apiKeySource,
    token: account.tokenSource,
  });
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

type Attempt = {
  command: readonly string[];
  clock: AwakeClock;
  args: string[];
  cwd: string;
  prompt: string;
  lane: EngineLane;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onToolStart: (tool: ToolStart) => void;
  onToolEnd: (id: string, failed: boolean) => void;
  onThinking: (state: ThinkingState) => void;
  onRateLimit: (updates: WindowUpdate[]) => void;
  onDelivered: () => void;
};

function runProcess({
  command,
  clock,
  args,
  cwd,
  prompt,
  lane,
  signal,
  onDelta,
  onToolStart,
  onToolEnd,
  onThinking,
  onRateLimit,
  onDelivered,
}: Attempt) {
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
    const timers = new Set<() => void>();
    let gate: "pending" | "open" | PauseReason = "pending";
    let spawnFailed = false;
    let sessionMissing = false;
    let apiRetries = 0;
    let stdout = "";
    let stderr = "";
    let stopping = false;
    let settled = false;
    let thinking = false;
    let thinkingBlock: unknown;

    const after = (ms: number, work: () => void) => {
      const timer = setTimeout(work, ms);
      timers.add(() => clearTimeout(timer));
    };

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
      for (const cancel of timers) {
        cancel();
      }
      signal.removeEventListener("abort", stop);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(outcome());
    }

    function openGate(frame: Frame) {
      const rejection = gateRejection(frame, lane);
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

    function setThinking(active: boolean) {
      if (thinking !== active) {
        thinking = active;
        onThinking({ active, text: "" });
      }
    }

    function onStreamEvent({ event }: Frame) {
      const delta = event?.delta;
      const block = event?.content_block;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        setThinking(false);
        onDelta(delta.text);
      } else if (delta?.type === "thinking_delta" && delta.thinking) {
        // Empty on every capture so far: the CLI asks for updates, not the thought itself.
        onThinking({ active: true, text: String(delta.thinking) });
      }
      if (event?.type === "content_block_start" && block?.type === "thinking") {
        thinkingBlock = event.index;
        setThinking(true);
      } else if (event?.type === "content_block_stop" && event.index === thinkingBlock) {
        setThinking(false);
      } else if (
        event?.type === "content_block_start" &&
        block?.type === "tool_use" &&
        typeof block.name === "string"
      ) {
        setThinking(false);
        const id = typeof block.id === "string" ? block.id : NodeCrypto.randomUUID();
        onToolStart({ id, name: block.name, detail: null });
      }
    }

    function onLine(line: string) {
      const frame = line.trim() ? parseFrame(line) : undefined;
      if (!frame || settled) {
        return;
      }
      seen.apiStatus = frame.api_error_status ?? seen.apiStatus;
      seen.rateLimit = frame.rate_limit_info ?? seen.rateLimit;
      if (frame.rate_limit_info) {
        onRateLimit(claudeRateLimitEventToUpdate(frame.rate_limit_info));
      }
      if (frame.type === "control_response") {
        const ended = stopping || seen.result !== undefined;
        if (gate === "pending" && !ended && frame.response?.request_id === "init-1") {
          openGate(frame);
        }
      } else if (frame.type === "stream_event") {
        onStreamEvent(frame);
      } else if (frame.type === "assistant") {
        seen.assistantError = frame.error ?? seen.assistantError;
        for (const { type, id, name, input } of frame.message?.content ?? []) {
          if (type === "tool_use" && typeof id === "string" && typeof name === "string") {
            onToolStart({ id, name, detail: toolDetail(name, input, cwd) });
          }
        }
      } else if (frame.type === "user") {
        for (const { type, tool_use_id: id, is_error: failed } of frame.message?.content ?? []) {
          if (type === "tool_result" && typeof id === "string") {
            onToolEnd(id, failed === true);
          }
        }
      } else if (frame.type === "system" && frame.subtype === "thinking_tokens") {
        setThinking(true);
      } else if (frame.type === "system" && frame.subtype === "api_retry") {
        apiRetries += 1;
        if (apiRetries >= maxApiRetries) {
          stop();
        }
      } else if (frame.type === "result") {
        setThinking(false);
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

    timers.add(
      awakeTimeout(clock, gateTimeoutMs, () => {
        if (gate === "pending") {
          gate = authPause();
          child.stdin.end();
          stop();
        }
      }).cancel,
    );
    signal.addEventListener("abort", stop, { once: true });
    child.stdin.write(initializeLine);
  });
}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

// A bare username can resolve to the computer account when the hostname matches it, and
// Git Bash can shadow `whoami`, hence the SID and the absolute path.
async function currentUserSid() {
  const whoami = NodePath.join(
    process.env.SystemRoot ?? String.raw`C:\Windows`,
    "System32",
    "whoami.exe",
  );
  const { stdout } = await execFile(whoami, ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
  const sid = /"(S-1-[\d-]+)"\s*$/.exec(stdout)?.[1];
  if (!sid) {
    throw new Error("whoami did not report a SID");
  }
  return sid;
}

// Created empty and tightened before the content goes in, so the token never sits in a looser file.
export async function writeMcpConfig(path: string, url: string, token: string) {
  await NodeFS.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  await (await NodeFS.open(path, "wx", 0o600)).close();
  if (process.platform === "win32") {
    const grant = `*${await currentUserSid()}:F`;
    // icacls copies a file's inherited entries in as explicit ones on its first edit, so
    // `/inheritance:r` alone leaves them. Each listed principal is removed by name instead.
    const { stdout } = await execFile("icacls", [path], { windowsHide: true });
    const listed = stdout
      .replace(path, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes(":("))
      .map((line) => line.slice(0, line.indexOf(":(")));
    const remove = listed.length > 0 ? ["/remove:g", ...listed] : [];
    await execFile("icacls", [path, "/inheritance:r", ...remove, "/grant:r", grant], {
      windowsHide: true,
    });
  }
  const bee = {
    type: "http",
    timeout: mcpTimeoutMs,
    url,
    headers: { Authorization: `Bearer ${token}` },
  };
  await NodeFS.writeFile(path, JSON.stringify({ mcpServers: { bee } }));
}

const isFolder = (path: string) =>
  NodeFS.stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );

type Options = { command: readonly string[]; dataDir: string; clock?: AwakeClock | undefined };

export function createClaudeRunTurn({
  command,
  dataDir,
  clock = createAwakeClock(),
}: Options): RunTurn {
  return async ({
    prompt,
    sessionId,
    resume,
    launch,
    signal,
    onDelta,
    onToolStart,
    onToolEnd,
    onThinking,
    onRateLimit,
    onDelivered,
    onSteerable,
    permissions,
  }) => {
    const { projectPath } = launch;
    if (projectPath && !(await isFolder(projectPath))) {
      return { kind: "folder_missing" };
    }
    const cwd = workingFolder(dataDir, launch.botId, projectPath);
    const privateFolder = workspacePath(dataDir, launch.botId);
    const personaPath = NodePath.join(NodePath.dirname(privateFolder), "persona.md");
    await NodeFS.mkdir(privateFolder, { recursive: true });
    await NodeFS.writeFile(personaPath, personaText(launch));

    const name = `${NodeCrypto.randomBytes(16).toString("hex")}.json`;
    const configPath = NodePath.join(dataDir, "runtime", name);
    const openTools = new Set<string>();
    const attempt = (asResume: boolean, text: string, stop: AbortSignal, delivered: () => void) =>
      runProcess({
        command,
        clock,
        args: turnArgs(personaPath, sessionId, asResume, launch, configPath),
        cwd,
        prompt: text,
        lane: launch.lane,
        signal: stop,
        onDelta,
        onToolStart: (tool) => {
          openTools.add(tool.id);
          onToolStart(tool);
        },
        onToolEnd: (id, failed) => {
          openTools.delete(id);
          onToolEnd(id, failed);
        },
        onThinking,
        onRateLimit,
        onDelivered: delivered,
      });

    // `-p` takes no input mid-turn, so a steer stops the attempt and resumes the session with the
    // new input. A reply that already finished stands, and the steer is refused. So is one that
    // lands mid-tool: the resume could run the tool again.
    let live: AbortController | undefined;
    let steered: { text: string; taken: (ok: boolean) => void } | undefined;
    const steer: Steer = (text) =>
      new Promise((taken) => {
        if (!live || steered || live.signal.aborted || openTools.size > 0) {
          taken(false);
          return;
        }
        steered = { text, taken };
        live.abort();
      });

    if (signal.aborted) {
      return { kind: "failed" };
    }
    try {
      await writeMcpConfig(configPath, permissions.url, permissions.token);
      let input = prompt;
      let asResume = resume;
      let delivered = onDelivered;
      let taking: ((ok: boolean) => void) | undefined;
      for (;;) {
        const controller = new AbortController();
        const forward = () => controller.abort();
        signal.addEventListener("abort", forward, { once: true });
        const onAttemptDelivered = () => {
          delivered();
          live = controller;
          onSteerable?.(steer);
        };
        const first = await attempt(asResume, input, controller.signal, onAttemptDelivered);
        const outcome =
          first === "in_use" && !controller.signal.aborted
            ? await attempt(true, input, controller.signal, onAttemptDelivered)
            : first;
        signal.removeEventListener("abort", forward);
        live = undefined;
        taking?.(false);
        const next = steered;
        steered = undefined;
        const result: TurnOutcome = outcome === "in_use" ? { kind: "failed" } : outcome;
        if (!next || signal.aborted || result.kind === "completed") {
          next?.taken(false);
          return result;
        }
        asResume = true;
        // A tool that started after the stop was sent never ended.
        if (openTools.size > 0) {
          for (const id of openTools) {
            onToolEnd(id, true, true);
          }
          openTools.clear();
          next.taken(false);
          input = cutOffNote;
          taking = undefined;
          delivered = () => {};
          continue;
        }
        input = `${steerNote}\n\n${next.text}`;
        taking = next.taken;
        delivered = () => next.taken(true);
      }
    } finally {
      // Never fails the turn: the token dies with the run, and the next boot wipes the directory.
      await NodeFS.rm(configPath, { force: true }).catch(() => {});
    }
  };
}

const usageArgs = [
  "-p",
  "--output-format",
  "stream-json",
  "--input-format",
  "stream-json",
  "--verbose",
  "--setting-sources",
  settingSources,
  "--strict-mcp-config",
  "--tools",
  "",
];

const summaryTimeoutMs = 60_000;

// No tools, settings or session: the personality is only text to describe.
const summaryArgs = [
  "-p",
  "--output-format",
  "stream-json",
  "--input-format",
  "stream-json",
  "--verbose",
  "--model",
  "haiku",
  "--setting-sources",
  settingSources,
  "--strict-mcp-config",
  "--tools",
  "",
  "--no-session-persistence",
  "--system-prompt",
  summaryInstructions,
];

const ignore = () => {};

// Runs behind a turn's gate, so it never spends a login the account's lane doesn't use.
export function createClaudeSummarize({
  command,
  dataDir,
  clock = createAwakeClock(),
  lane,
}: Options & { lane: () => EngineLane }): Summarize {
  return async (bot, signal) => {
    if (signal.aborted) {
      return undefined;
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    const timeout = awakeTimeout(clock, summaryTimeoutMs, stop);
    try {
      const outcome = await runProcess({
        command,
        clock,
        args: summaryArgs,
        cwd: dataDir,
        prompt: summaryPrompt(bot),
        lane: lane(),
        signal: controller.signal,
        onDelta: ignore,
        onToolStart: ignore,
        onToolEnd: ignore,
        onThinking: ignore,
        onRateLimit: ignore,
        onDelivered: ignore,
      });
      return outcome !== "in_use" && outcome.kind === "completed"
        ? cleanSummary(outcome.text)
        : undefined;
    } finally {
      timeout.cancel();
      signal.removeEventListener("abort", stop);
    }
  };
}

const UsageFrame = z.object({
  type: z.literal("control_response"),
  response: z.object({
    request_id: z.literal("usage-1"),
    subtype: z.literal("success"),
    response: UsageReply,
  }),
});

function parseUsageFrame(line: string) {
  try {
    return UsageFrame.safeParse(JSON.parse(line)).data;
  } catch {
    return undefined;
  }
}

// Undocumented, so it runs behind ruling R29's guards. The CLI makes the call under its own login:
// this asks it and nothing else, and it never sends a user message, so no session is opened.
export function probeUsage(
  command: readonly string[],
  cwd: string,
  onModels?: (models: EngineModel[]) => void,
) {
  return new Promise<UsageProbe>((resolve) => {
    const [file = "", ...prefix] = command;
    const child = NodeChildProcess.spawn(file, [...prefix, ...usageArgs], {
      cwd,
      env: childEnv(),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let result: UsageProbe | undefined;
    let grace: NodeJS.Timeout | undefined;

    function settle() {
      clearTimeout(timeout);
      clearTimeout(grace);
      resolve(result ?? unavailableProbe("probeFailed"));
    }

    // Resolves only once the process is gone: until then it can still refresh the login, and the
    // supervisor holds the account's next turn for as long as this is pending.
    function finish(reply: UsageProbe) {
      if (result) {
        return;
      }
      result = reply;
      clearTimeout(timeout);
      child.stdin.end();
      grace = setTimeout(() => {
        if (child.pid !== undefined) {
          killTree(child.pid);
        }
        // Exit settles this. The timer only bounds a kill that silently failed.
        grace = setTimeout(settle, stopGraceMs);
      }, closeGraceMs);
    }

    const timeout = setTimeout(() => finish(unavailableProbe("probeFailed")), usageTimeoutMs);

    function onLine(line: string) {
      const frame = line.trim() ? parseFrame(line) : undefined;
      if (frame?.type !== "control_response") {
        return;
      }
      if (frame.response?.request_id === "init-1") {
        if (gateRejection(frame, "subscription")) {
          finish(unavailableProbe("unsupported"));
        } else {
          const models = modelsFromInitialize(frame.response.response?.models);
          if (models) {
            onModels?.(models);
          }
          child.stdin.write(usageLine);
        }
      } else if (frame.response?.request_id === "usage-1") {
        const reply = parseUsageFrame(line)?.response.response;
        finish(reply ? claudeUsageResponseToLimits(reply) : unavailableProbe("probeFailed"));
      }
    }

    child.once("error", settle);
    child.once("exit", settle);
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (stdout + chunk).split("\n");
      stdout = lines.pop() ?? "";
      lines.forEach(onLine);
    });
    child.stdin.write(initializeLine);
  });
}

const AuthStatus = z.object({
  loggedIn: loose,
  authMethod: loose,
  apiProvider: loose,
  apiKeySource: loose,
  email: loose,
});

// A logged-out CLI exits non-zero but still prints the JSON. Undefined when this CLI version has no
// `auth status`, or answers in a shape it doesn't know.
async function readAuthStatus(run: (...args: string[]) => Promise<{ stdout: string }>) {
  const stdout = await run("auth", "status", "--json").then(
    (result) => result.stdout,
    (error: { stdout?: unknown }) => String(error.stdout ?? ""),
  );
  try {
    const auth = AuthStatus.safeParse(JSON.parse(stdout)).data;
    return auth?.loggedIn === undefined ? undefined : auth;
  } catch {
    return undefined;
  }
}

// Holds the owner's org, so nothing from either command may be logged or stored. The email goes
// only to the owner's screen.
export async function probeEngine(
  command: readonly string[],
  cwd: string,
  lane: EngineLane,
): Promise<EngineStatus> {
  const [file = "", ...prefix] = command;
  const run = (...args: string[]) =>
    execFile(file, [...prefix, ...args], {
      cwd,
      env: childEnv(),
      timeout: gateTimeoutMs,
      windowsHide: true,
    });
  const unchecked = { version: null, auth: "unknown", email: null } as const;
  let version: string | null;
  try {
    version = cliVersion((await run("--version")).stdout);
  } catch (error) {
    return spawnMissing(error)
      ? { ...unchecked, cliFound: false, pauseReason: "cli_missing" }
      : { ...unchecked, cliFound: true, pauseReason: "cli_failed" };
  }
  const auth = await readAuthStatus(run);
  if (!auth) {
    return { ...unchecked, cliFound: true, version, pauseReason: null };
  }
  const pauseReason =
    credentialPause(lane, {
      firstParty: auth.apiProvider === "firstParty",
      plan: auth.authMethod === "claude.ai",
      apiKeySource: auth.apiKeySource,
      token: auth.loggedIn === false ? "none" : auth.authMethod,
    }) ?? null;
  const signedIn = pauseReason === null || pauseReason === "credential_source";
  return {
    cliFound: true,
    version,
    auth: signedIn ? "authenticated" : "unauthenticated",
    email: signedIn && typeof auth.email === "string" ? auth.email : null,
    pauseReason,
  };
}
