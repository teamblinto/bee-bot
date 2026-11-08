import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import {
  Effort,
  type EngineLane,
  type EngineModel,
  type EngineStatus,
  type PauseReason,
} from "@beebot/contracts";
import { z } from "zod";

import { patchFileHeader } from "./approvals.ts";
import {
  type BotLaunch,
  killTree,
  personaText,
  type RunTurn,
  toolDetail,
  type TurnOutcome,
  workingFolder,
  workspacePath,
} from "./engine.ts";

export const testedCodexVersion = "0.167.0";

const gateTimeoutMs = 30_000;
const stopGraceMs = 5000;
const closeGraceMs = 1000;
const defaultLimitMs = 5 * 60_000;
const invalidRequestCode = -32_600;

const tokenVariable = "BEE_MCP_TOKEN";
// Exact names, so `approve` stays off the model's tool list. A new one must be added on purpose.
const memoryTools = ["memory_search", "memory_get", "memory_propose", "memory_forget"];

// Measured on 0.167.0, and version-gated for that reason. `unified_exec_tty` stops stdin smuggling
// into an approved shell. `code_mode_host` must stay on: disabling it breaks all execution.
const lockedArgs = [
  "notify=[]",
  'web_search="disabled"',
  "project_doc_max_bytes=0",
  "skills.bundled.enabled=false",
  'model_provider="openai"',
].flatMap((setting) => ["-c", setting]);
const disabledFeatures = [
  "hooks",
  "plugins",
  "apps",
  "multi_agent",
  "memories",
  "remote_plugin",
  "image_generation",
  "goals",
  "tool_suggest",
  "computer_use",
  "browser_use",
  "in_app_browser",
  "unified_exec_tty",
].flatMap((feature) => ["--disable", feature]);

function ancestors(path: string): string[] {
  const parent = NodePath.dirname(path);
  return parent === path ? [path] : [path, ...ancestors(parent)];
}

// A trusted parent repo beats an untrusted cwd, so every ancestor is listed. On win32 a key that
// isn't lowercase is silently ignored. `projects={}` would merge and do nothing.
function projectsArg(cwd: string) {
  const keys = ancestors(cwd).map((path) =>
    JSON.stringify(process.platform === "win32" ? path.toLowerCase() : path),
  );
  return `projects={${keys.map((key) => `${key}={trust_level="untrusted"}`).join(",")}}`;
}

// What `forced_login_method` takes, and what `account/read` reports, for each lane.
const loginMethods = {
  subscription: { forced: "chatgpt", account: "chatgpt" },
  api_key: { forced: "api", account: "apiKey" },
} satisfies Record<EngineLane, { forced: string; account: string }>;

const launchArgs = (cwd: string, lane: EngineLane) => [
  "app-server",
  "-c",
  projectsArg(cwd),
  ...lockedArgs,
  "-c",
  `forced_login_method="${loginMethods[lane].forced}"`,
  ...disabledFeatures,
];

const beeArgs = (url: string) =>
  [
    `mcp_servers.bee.url=${JSON.stringify(url)}`,
    `mcp_servers.bee.bearer_token_env_var="${tokenVariable}"`,
    `mcp_servers.bee.enabled_tools=${JSON.stringify(memoryTools)}`,
    // Otherwise every memory call raises an elicitation, which is refused like any other.
    'mcp_servers.bee.default_tools_approval_mode="approve"',
    `shell_environment_policy.exclude=["${tokenVariable}"]`,
  ].flatMap((setting) => ["-c", setting]);

// `CODEX_HOME` stays: it is where the owner's login lives, on either lane.
const clearedEnv =
  /^(?!CODEX_HOME$)(OPENAI_|CODEX_|AWS_|GOOGLE_|GCP_|AZURE_|ANTHROPIC_|CLAUDE|T3CODE|ELECTRON_RUN_AS_NODE$)/i;

export function childEnv(parent: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(Object.entries(parent).filter(([name]) => !clearedEnv.test(name)));
}

// Used until `model/list` answers.
export const staticCodexModels: EngineModel[] = [
  { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: Effort.options },
  { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: Effort.options },
  { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: Effort.options },
];

const ModelList = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      displayName: z.string().min(1),
      hidden: z.boolean(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
    }),
  ),
});

function modelsFromList(reply: unknown): EngineModel[] | undefined {
  const listed = ModelList.safeParse(reply)
    .data?.data.filter(({ hidden }) => !hidden)
    .map(({ id, displayName, supportedReasoningEfforts }) => ({
      id,
      label: displayName,
      efforts: supportedReasoningEfforts.flatMap(
        ({ reasoningEffort }) => Effort.safeParse(reasoningEffort).data ?? [],
      ),
    }));
  return listed?.length ? listed : undefined;
}

const windowsShell = String.raw`"?(?:c:\\+windows\\+system32\\+windowspowershell\\+v1\.0\\+powershell\.exe|c:\\+program files\\+powershell\\+\d+\\+pwsh\.exe|powershell(?:\.exe)?|pwsh(?:\.exe)?)"?`;
const shellWrappers = [
  new RegExp(String.raw`^${windowsShell}(?: -NoProfile)? -Command (.+)$`, "is"),
  /^(?:(?:\/usr)?\/bin\/)?(?:bash|zsh|sh) -lc (.+)$/s,
];

// Named paths only: the model can pick a shell, and `C:\evil\powershell.exe -Command 'ls'` must not
// show up on a card as `ls`. Any doubt leaves the raw string, which is still the truth.
export function unwrapShell(command: string) {
  const payload = shellWrappers.flatMap((wrapper) => wrapper.exec(command)?.[1] ?? [])[0];
  if (payload === undefined) {
    return command;
  }
  if (/^'[^']*'$/.test(payload)) {
    return payload.slice(1, -1);
  }
  if (/^"(?:[^"\\]|\\.)*"$/s.test(payload)) {
    return payload.slice(1, -1).replace(/\\(.)/gs, (pair, next) => (next === '"' ? '"' : pair));
  }
  return command;
}

const loose = z.unknown().optional();

const Change = z.object({
  path: z.string(),
  kind: z.object({ type: z.string(), move_path: z.string().nullish() }),
  diff: z.string(),
});
type Change = z.infer<typeof Change>;

// A changed shape reads as "unknown changes", and those are declined.
const Changes = z.array(Change).optional().catch(undefined);

// Carries the full tool input. Only `toolDetail` and the approval gate may read it.
const Item = z.object({
  type: loose,
  id: loose,
  status: loose,
  command: loose,
  changes: Changes,
  server: loose,
  tool: loose,
  text: z.string().optional().catch(undefined),
  phase: loose,
});
type Item = z.infer<typeof Item>;

const Window = z.object({ usedPercent: loose, resetsAt: loose }).nullish().catch(undefined);
const TurnError = z.object({ codexErrorInfo: loose }).nullish().catch(undefined);

// `.catch`: a shape change in one field must never cost the frame, or an item its taint.
const Params = z.object({
  delta: loose,
  itemId: loose,
  kind: loose,
  command: loose,
  networkApprovalContext: loose,
  willRetry: loose,
  changes: Changes,
  item: Item.optional().catch({}),
  error: TurnError,
  turn: z.object({ id: loose, status: loose, error: TurnError }).optional().catch(undefined),
  rateLimits: z.object({ primary: Window, secondary: Window }).optional().catch(undefined),
});
type Params = z.infer<typeof Params>;

const Frame = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: loose,
  result: loose,
  error: z.object({ code: loose }).optional().catch({}),
});
type Frame = z.infer<typeof Frame>;

// Frames can quote the prompt, so a bad line is dropped without a trace. A missing reply fails.
function parseFrame(line: string) {
  try {
    return Frame.safeParse(JSON.parse(line)).data;
  } catch {
    return undefined;
  }
}

type Answer = { result: unknown } | { error: { code: number; message: string } };

// A request left unanswered hangs the turn, so everything gets a refusal.
function refusal(method: string): Answer {
  if (method === "mcpServer/elicitation/request") {
    return { result: { action: "decline" } };
  }
  if (method === "item/tool/requestUserInput") {
    return { result: { answers: {} } };
  }
  return { error: { code: -32_601, message: "Not supported" } };
}

type Launch = {
  command: readonly string[];
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onNotification?: (method: string, params: Params) => void;
  onRequest: (method: string, params: Params) => Answer | Promise<Answer>;
};

function startAppServer({ command, args, cwd, env, onNotification, onRequest }: Launch) {
  const [file = "", ...prefix] = command;
  const child = NodeChildProcess.spawn(file, [...prefix, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    // Its own group, so a POSIX stop reaches the whole tree.
    detached: process.platform !== "win32",
  });

  const pending = new Map<number, (frame: Frame | undefined) => void>();
  const timers = new Set<NodeJS.Timeout>();
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
  let nextId = 1;
  let stdout = "";
  let spawnFailed = false;
  let killed = false;
  let open = true;

  const send = (frame: Record<string, unknown>) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);

  function after(ms: number, work: () => void) {
    if (!open) {
      return undefined;
    }
    const timer = setTimeout(work, ms);
    timers.add(timer);
    return timer;
  }

  function close() {
    if (!open) {
      return;
    }
    open = false;
    for (const timer of timers) {
      clearTimeout(timer);
    }
    for (const settle of pending.values()) {
      settle(undefined);
    }
    pending.clear();
    child.stdout.destroy();
    markClosed();
  }

  function kill() {
    if (killed || !open) {
      return;
    }
    killed = true;
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      killTree(child.pid);
    }
    // A stop must settle the turn even if the kill silently failed.
    after(stopGraceMs, close);
  }

  function onLine(line: string) {
    const frame = line.trim() ? parseFrame(line) : undefined;
    if (!frame || !open) {
      return;
    }
    const { id, method } = frame;
    if (method === undefined) {
      const settle = typeof id === "number" ? pending.get(id) : undefined;
      if (typeof id === "number") {
        pending.delete(id);
      }
      settle?.(frame);
      return;
    }
    const params = Params.safeParse(frame.params).data ?? Params.parse({});
    if (id === undefined) {
      onNotification?.(method, params);
    } else {
      void Promise.resolve(onRequest(method, params)).then((answer) => send({ id, ...answer }));
    }
  }

  child.once("error", () => {
    if (child.pid === undefined) {
      spawnFailed = true;
      close();
    }
  });
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const lines = (stdout + chunk).split("\n");
    stdout = lines.pop() ?? "";
    lines.forEach(onLine);
  });
  // A detached grandchild can hold the pipes open forever, so `close` alone can't be awaited.
  child.once("exit", () => after(closeGraceMs, close));
  child.once("close", close);

  return {
    after,
    kill,
    closed,
    spawnFailed: () => spawnFailed,
    notify: (method: string) => send({ method }),
    // Undefined once the process is gone: it never rejects and never outlives it.
    request: (method: string, params: unknown) =>
      new Promise<Frame | undefined>((resolve) => {
        if (!open) {
          resolve(undefined);
          return;
        }
        const id = nextId++;
        pending.set(id, resolve);
        send({ id, method, params });
      }),
    shutdown: () => {
      child.stdin.end();
      after(closeGraceMs, kill);
      return closed;
    },
  };
}
type AppServer = ReturnType<typeof startAppServer>;

const Initialized = z.object({ userAgent: z.string() });
const Account = z.object({ account: z.object({ type: loose }).nullish() });

// The reply also holds the owner's email, which stops here: nothing else may read it. Any other
// login pauses the bot: the lane is never switched.
function accountPause(reply: unknown, lane: EngineLane): PauseReason | null {
  const type = Account.safeParse(reply).data?.account?.type;
  if (type === loginMethods[lane].account) {
    return null;
  }
  return type ? "credential_source" : "auth_failed";
}

// Null means open. Undefined means no answer came, and what that means is the caller's call.
async function passGate(
  server: AppServer,
  lane: EngineLane,
): Promise<PauseReason | null | undefined> {
  const initialized = await server.request("initialize", {
    clientInfo: { name: "bee", version: "1" },
    capabilities: { experimentalApi: true },
  });
  if (!initialized) {
    return undefined;
  }
  server.notify("initialized");
  // `bee/0.167.0 (Windows ...)`: the app-server's only report of its own version.
  const userAgent = Initialized.safeParse(initialized.result).data?.userAgent;
  if (userAgent?.split(/[/\s]/)[1] !== testedCodexVersion) {
    return "cli_version";
  }
  const account = await server.request("account/read", {});
  if (!account) {
    return undefined;
  }
  return accountPause(account.result, lane);
}

const SkillList = z.object({
  data: z.array(z.object({ skills: z.array(z.object({ name: z.string() })) })),
});
const ConfigRead = z.object({
  config: z.object({ mcp_servers: z.record(z.string(), z.unknown()).nullish() }),
  layers: z.array(z.object({ name: z.object({ type: loose }), disabledReason: loose })),
});

// Dotted keys: a `skills` or `mcp_servers` table here would replace the whole table, which drops
// bee and turns the bundled skills back on. Undefined means the isolation can't be vouched for.
function threadConfig(skills: unknown, config: unknown) {
  const skillNames = SkillList.safeParse(skills)
    .data?.data.flatMap((entry) => entry.skills)
    .map(({ name }) => ({ name, enabled: false }));
  const read = ConfigRead.safeParse(config).data;
  if (!skillNames || !read) {
    return undefined;
  }
  const projectActive = read.layers.some(
    ({ name, disabledReason }) => name.type === "project" && !disabledReason,
  );
  const servers = Object.keys(read.config.mcp_servers ?? {}).filter((name) => name !== "bee");
  if (projectActive || servers.some((name) => !/^[\w-]+$/.test(name))) {
    return undefined;
  }
  return {
    "skills.config": skillNames,
    ...Object.fromEntries(servers.map((name) => [`mcp_servers.${name}.enabled`, false])),
  };
}

const Thread = z.object({ thread: z.object({ id: z.string().min(1) }) });
const StartedTurn = z.object({ turn: z.object({ id: z.string() }) });

const patchPaths = (changes: Change[]) =>
  changes.flatMap(({ path, kind }) => (kind.move_path ? [path, kind.move_path] : [path]));

// Every line gets a leading mark, so a file's content can't forge a file header.
function patchLines({ kind, diff }: Change) {
  const lines = diff.replace(/\n$/, "").split("\n");
  if (kind.type === "add") {
    return lines.map((line) => `+${line}`);
  }
  if (kind.type === "delete") {
    return lines.map((line) => `-${line}`);
  }
  return kind.type === "update"
    ? lines.map((line) => (/^[-+ @\\]/.test(line) || !line ? line : ` ${line}`))
    : undefined;
}

// Undefined when the patch can't be shown, so it can't be approved.
function patchInput(changes: Change[] | undefined) {
  if (!changes?.length || patchPaths(changes).some((path) => /[\r\n]/.test(path))) {
    return undefined;
  }
  const sections = changes.map((change) => {
    const moved = change.kind.move_path ? ` -> ${change.kind.move_path}` : "";
    const lines = patchLines(change);
    return lines && [`${patchFileHeader}${change.path}${moved}`, ...lines];
  });
  return sections.every((section) => section !== undefined)
    ? { paths: patchPaths(changes), diff: sections.flat().join("\n") }
    : undefined;
}

// Everything else, known or not, counts as a tool, so an item Bee has never seen taints the scope.
const silentItems = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "contextCompaction",
]);

function toolName({ type, server, tool }: Item) {
  if (type === "commandExecution") {
    return "Bash";
  }
  if (type === "fileChange") {
    return "Patch";
  }
  if (type === "mcpToolCall") {
    return `mcp__${String(server)}__${String(tool)}`;
  }
  if (typeof type !== "string") {
    return "unknown";
  }
  return silentItems.has(type) ? undefined : type;
}

const patchDetail = (changes: Change[], cwd: string) =>
  toolDetail("Patch", { file_path: patchPaths(changes).join(", ") }, cwd);

function itemDetail({ type, command, changes }: Item, cwd: string) {
  if (type === "commandExecution" && typeof command === "string") {
    return toolDetail("Bash", { command: unwrapShell(command) }, cwd);
  }
  return type === "fileChange" && changes ? patchDetail(changes, cwd) : null;
}

const HttpError = z.object({ httpStatusCode: z.number().nullish() });

function httpStatus(info: unknown) {
  return typeof info === "object" && info !== null
    ? HttpError.safeParse(Object.values(info)[0]).data?.httpStatusCode
    : undefined;
}

// shortcut: no real limit was ever captured, so this reading of the account's windows is a guess
// from the schema. Check it against a capture the first time a real limit happens.
function retryAfterMs(limits: Params["rateLimits"]) {
  const resets = [limits?.primary, limits?.secondary].flatMap((window) =>
    typeof window?.resetsAt === "number" && Number(window.usedPercent) >= 100
      ? [window.resetsAt * 1000]
      : [],
  );
  return resets.length > 0 ? Math.max(...resets) - Date.now() : defaultLimitMs;
}

function replyText(replies: Item[]) {
  const answers = replies.filter(({ phase }) => phase !== "commentary");
  return (answers.length > 0 ? answers : replies).map(({ text = "" }) => text).join("\n\n");
}

type Seen = {
  ended: Params["turn"];
  lastError: unknown;
  limits: Params["rateLimits"];
  replies: Item[];
};

// Never branches on error text, which is free to change and can quote the prompt.
function mapTurn({ ended, lastError, limits, replies }: Seen): TurnOutcome {
  if (ended?.status === "completed") {
    return { kind: "completed", text: replyText(replies) };
  }
  const info = ended?.error?.codexErrorInfo ?? lastError;
  const status = httpStatus(info);
  if (info === "unauthorized" || status === 401) {
    return { kind: "auth_failed", pauseReason: "auth_failed" };
  }
  if (info === "usageLimitExceeded" || info === "rateLimitExceeded" || status === 429) {
    return { kind: "limited", retryAfterMs: retryAfterMs(limits) };
  }
  return { kind: "failed" };
}

const isFolder = (path: string) =>
  NodeFS.stat(path).then(
    (stats) => stats.isDirectory(),
    () => false,
  );

// `thread/resume` ignores `developerInstructions`, so a change has to be injected. Injected items
// persist with the thread, so only a change is sent, or the context would grow every turn.
const updatedInstructions = (persona: string) => ({
  type: "message",
  role: "developer",
  content: [
    {
      type: "input_text",
      text: `Your instructions were updated and replace all earlier ones:\n\n${persona}`,
    },
  ],
});

function threadParams(launch: BotLaunch, cwd: string) {
  return {
    cwd,
    model: launch.model,
    // The only policy that asks. Never a bypass, even on Full access: Bee answers the cards itself.
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: launch.mode === "plan" ? "read-only" : "workspace-write",
    developerInstructions: personaText(launch),
  };
}

type Options = { command: readonly string[]; dataDir: string };

export function createCodexRunTurn({ command, dataDir }: Options): RunTurn {
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
    permissions,
    onDelivered,
    approve,
    onSessionId,
    onSteerable,
  }) => {
    const { projectPath } = launch;
    if (projectPath && !(await isFolder(projectPath))) {
      return { kind: "folder_missing" };
    }
    const privateFolder = workspacePath(dataDir, launch.botId);
    await NodeFS.mkdir(privateFolder, { recursive: true });
    const personaPath = NodePath.join(NodePath.dirname(privateFolder), "persona.md");
    const persona = personaText(launch);
    if (signal.aborted) {
      return { kind: "failed" };
    }
    const cwd = await NodeFS.realpath(workingFolder(dataDir, launch.botId, projectPath));

    const seen: Seen = { ended: undefined, lastError: undefined, limits: undefined, replies: [] };
    const changes = new Map<string, Change[]>();
    const { promise: turnEnded, resolve: markEnded } = Promise.withResolvers<void>();
    let threadId: string | undefined;
    let turnId: string | undefined;
    let thinking = false;

    function setThinking(active: boolean) {
      if (thinking !== active) {
        thinking = active;
        onThinking({ active, text: "" });
      }
    }

    function reportTool(item: Item, id: string) {
      const name = toolName(item);
      if (name) {
        setThinking(false);
        onToolStart({ id, name, detail: itemDetail(item, cwd) });
      }
    }

    function onItem(method: string, item: Item) {
      const id = typeof item.id === "string" ? item.id : NodeCrypto.randomUUID();
      if (item.changes) {
        changes.set(id, item.changes);
      }
      if (item.type === "reasoning") {
        setThinking(method === "item/started");
        return;
      }
      // Also on completion: an item that never reported its start must still taint.
      reportTool(item, id);
      if (method === "item/completed") {
        changes.delete(id);
        if (item.type === "agentMessage") {
          seen.replies.push(item);
        } else if (toolName(item)) {
          onToolEnd(id, item.status !== undefined && item.status !== "completed");
        }
      }
    }

    function onNotification(method: string, params: Params) {
      const { delta, item } = params;
      if (method === "item/agentMessage/delta" && typeof delta === "string") {
        setThinking(false);
        onDelta(delta);
      } else if (
        (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") &&
        typeof delta === "string"
      ) {
        thinking = true;
        onThinking({ active: true, text: delta });
      } else if ((method === "item/started" || method === "item/completed") && item) {
        onItem(method, item);
      } else if (
        method === "item/fileChange/patchUpdated" &&
        typeof params.itemId === "string" &&
        params.changes
      ) {
        changes.set(params.itemId, params.changes);
        const detail = patchDetail(params.changes, cwd);
        onToolStart({ id: params.itemId, name: "Patch", detail });
      } else if (method === "turn/started" && typeof params.turn?.id === "string") {
        turnId = params.turn.id;
      } else if (method === "turn/completed") {
        setThinking(false);
        seen.ended = params.turn;
        markEnded();
      } else if (method === "error" && params.willRetry === false) {
        seen.lastError = params.error?.codexErrorInfo;
      } else if (method === "account/rateLimits/updated") {
        seen.limits = params.rateLimits ?? seen.limits;
      }
    }

    const decline: Answer = { result: { decision: "decline" } };

    async function decide(tool: "Bash" | "Patch", input: Record<string, unknown>): Promise<Answer> {
      try {
        const { behavior } = await approve(tool, input);
        return behavior === "allow" ? { result: { decision: "accept" } } : decline;
      } catch {
        return decline;
      }
    }

    function onRequest(method: string, params: Params) {
      if (method === "item/commandExecution/requestApproval") {
        const { kind = "command", command: asked, networkApprovalContext } = params;
        return kind === "command" && !networkApprovalContext && typeof asked === "string"
          ? decide("Bash", { command: unwrapShell(asked) })
          : decline;
      }
      if (method === "item/fileChange/requestApproval") {
        const input = typeof params.itemId === "string" && patchInput(changes.get(params.itemId));
        return input ? decide("Patch", input) : decline;
      }
      return refusal(method);
    }

    const server = startAppServer({
      command,
      args: [...launchArgs(cwd, launch.lane), ...beeArgs(permissions.url)],
      cwd,
      env: { ...childEnv(), [tokenVariable]: permissions.token },
      onNotification,
      onRequest,
    });

    const stop = () => {
      if (threadId && turnId) {
        void server.request("turn/interrupt", { threadId, turnId });
        server.after(stopGraceMs, server.kill);
      } else {
        server.kill();
      }
    };

    async function drive(): Promise<TurnOutcome> {
      const gate = await passGate(server, launch.lane);
      if (gate === undefined) {
        if (server.spawnFailed()) {
          return { kind: "auth_failed", pauseReason: "cli_missing" };
        }
        return signal.aborted
          ? { kind: "failed" }
          : { kind: "auth_failed", pauseReason: "auth_failed" };
      }
      if (gate) {
        return { kind: "auth_failed", pauseReason: gate };
      }
      const skills = await server.request("skills/list", { cwds: [cwd], forceReload: true });
      const read = await server.request("config/read", { cwd, includeLayers: true });
      const config = threadConfig(skills?.result, read?.result);
      if (!config) {
        return { kind: "failed" };
      }
      const opened = await server.request(resume ? "thread/resume" : "thread/start", {
        ...(resume && { threadId: sessionId }),
        ...threadParams(launch, cwd),
        config,
      });
      // The only code a thread with no rollout gets. The message is not a stable contract.
      if (resume && opened?.error?.code === invalidRequestCode) {
        return { kind: "session_lost" };
      }
      threadId = Thread.safeParse(opened?.result).data?.thread.id;
      if (!threadId) {
        return { kind: "failed" };
      }
      if (resume && (await NodeFS.readFile(personaPath, "utf8").catch(() => "")) !== persona) {
        const items = [updatedInstructions(persona)];
        const injected = await server.request("thread/inject_items", { threadId, items });
        if (!injected || injected.error) {
          return { kind: "failed" };
        }
      }
      await NodeFS.writeFile(personaPath, persona);
      try {
        onSessionId?.(threadId);
      } catch {
        return { kind: "failed" };
      }
      if (signal.aborted) {
        return { kind: "failed" };
      }
      const started = await server.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        ...(launch.effort && { effort: launch.effort }),
      });
      const turn = StartedTurn.safeParse(started?.result).data?.turn;
      if (!turn) {
        return { kind: "failed" };
      }
      turnId = turn.id;
      clearTimeout(gateTimer);
      onDelivered();
      const expectedTurnId = turnId;
      onSteerable?.(async (text) => {
        if (seen.ended || signal.aborted) {
          return false;
        }
        const steered = await server.request("turn/steer", {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
          expectedTurnId,
        });
        return steered !== undefined && !steered.error;
      });
      await Promise.race([turnEnded, server.closed]);
      return mapTurn(seen);
    }

    const gateTimer = server.after(gateTimeoutMs, server.kill);
    signal.addEventListener("abort", stop, { once: true });
    try {
      return await drive();
    } finally {
      signal.removeEventListener("abort", stop);
      await server.shutdown();
    }
  };
}

// Holds the owner's email, so nothing from the account reply may be logged or stored.
export async function probeCodex(
  command: readonly string[],
  cwd: string,
  lane: EngineLane,
  onModels?: (models: EngineModel[]) => void,
): Promise<EngineStatus> {
  const status = (pauseReason: PauseReason | null, cliFound = true, versionOk = true) => ({
    cliFound,
    versionOk,
    loggedIn: pauseReason === null,
    pauseReason,
    testedVersion: testedCodexVersion,
  });
  const server = startAppServer({
    command,
    args: launchArgs(await NodeFS.realpath(cwd), lane),
    cwd,
    env: childEnv(),
    onRequest: refusal,
  });
  server.after(gateTimeoutMs, server.kill);
  try {
    const gate = await passGate(server, lane);
    if (gate === undefined) {
      return server.spawnFailed() ? status("cli_missing", false, false) : status("auth_failed");
    }
    if (gate === "cli_version") {
      return status(gate, true, false);
    }
    if (gate) {
      return status(gate);
    }
    const models = modelsFromList((await server.request("model/list", {}))?.result);
    if (models) {
      onModels?.(models);
    }
    return status(null);
  } finally {
    await server.shutdown();
  }
}
