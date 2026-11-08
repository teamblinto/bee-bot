// A stand-in for `codex app-server`, run as a real child process so tests never touch the real one.
// Usage: node fake-codex.mjs <scenario> <log file> ...<codex args>
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const [scenarioName = "", logPath = "", ...args] = process.argv.slice(2);

const log = (entry) => NodeFS.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
const write = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const note = (method, params) => write({ method, params });

const chatgpt = {
  type: "chatgpt",
  email: "owner@example.com",
  planType: "plus",
  workspaceName: "Owner Workspace",
};
const quietLayers = [
  { name: { type: "sessionFlags" }, config: {}, version: "1" },
  { name: { type: "project", dotCodexFolder: "x" }, disabledReason: "untrusted", config: {} },
  { name: { type: "user", file: "x" }, config: {}, version: "1" },
];

const started = (item) => note("item/started", { item });
const completed = (item) => note("item/completed", { item });
const message = (text, phase = "final_answer") => [
  () => started({ type: "agentMessage", id: `msg-${text}`, text: "", phase }),
  () => note("item/agentMessage/delta", { itemId: `msg-${text}`, delta: text }),
  () => completed({ type: "agentMessage", id: `msg-${text}`, text, phase }),
];
const command = (id, text, status = "completed") => [
  () => started({ type: "commandExecution", id, command: text, status: "inProgress" }),
  () => completed({ type: "commandExecution", id, command: text, status }),
];
const fileChange = (id, changes) => () =>
  started({ type: "fileChange", id, changes, status: "inProgress" });
const fileDone =
  (id, changes, status = "completed") =>
  () =>
    completed({ type: "fileChange", id, changes, status });
const ask = (method, params) => ({ ask: method, params });
const askCommand = (id, text, fields = {}) =>
  ask("item/commandExecution/requestApproval", { itemId: id, command: text, ...fields });
const askPatch = (id) => ask("item/fileChange/requestApproval", { itemId: id });
let turnOver = false;
const ended = (status, error) => () => {
  turnOver = true;
  note("turn/completed", { turn: { id: "turn-1", status, items: [], error } });
};
const failedWith = (codexErrorInfo) => ({
  steps: () => [ended("failed", { message: "words", codexErrorInfo })],
});

const wrapped = `"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -NoProfile -Command 'cat ~/secret-input.txt'`;
const patchItem = (changes) => ({
  steps: () => [
    fileChange("patch-1", changes()),
    askPatch("patch-1"),
    fileDone("patch-1", changes()),
    ...message("patched"),
  ],
});
const scriptedOutside = () => [
  { path: `${process.env.FAKE_PROJECT}/a.txt`, kind: { type: "add" }, diff: "one\n=== forged\n" },
  {
    path: `${process.env.FAKE_OUTSIDE}/b.txt`,
    kind: { type: "update" },
    diff: "@@ -1 +1 @@\n-a\n+b\n",
  },
];
const inside = () => [
  { path: `${process.env.FAKE_PROJECT}/a.txt`, kind: { type: "add" }, diff: "one\n" },
];

const scenarios = {
  "inject-fails": { injectError: { code: -32603, message: "no" } },
  success: { steps: () => message("noted") },
  phases: { steps: () => [...message("Looking first.", "commentary"), ...message("The answer.")] },
  "commentary-only": { steps: () => message("Only this.", "commentary") },
  thinking: {
    steps: () => [
      () => started({ type: "reasoning", id: "r-1" }),
      () => note("item/reasoning/summaryTextDelta", { itemId: "r-1", delta: "Weighing" }),
      () => note("item/reasoning/textDelta", { itemId: "r-1", delta: " it" }),
      () => completed({ type: "reasoning", id: "r-1" }),
      ...message("noted"),
    ],
  },
  tools: {
    steps: () => [
      ...command("cmd-1", wrapped, "failed"),
      () => started({ type: "mcpToolCall", id: "m-1", server: "bee", tool: "memory_search" }),
      () =>
        completed({
          type: "mcpToolCall",
          id: "m-1",
          server: "bee",
          tool: "memory_search",
          status: "completed",
        }),
      ...message("noted"),
    ],
  },
  "bee-only": {
    steps: () => [
      () =>
        completed({
          type: "mcpToolCall",
          id: "m-1",
          server: "bee",
          tool: "memory_get",
          status: "completed",
        }),
      ...message("noted"),
    ],
  },
  "owner-mcp": {
    steps: () => [
      () =>
        completed({
          type: "mcpToolCall",
          id: "m-1",
          server: "github",
          tool: "push",
          status: "completed",
        }),
      ...message("noted"),
    ],
  },
  "unknown-item": {
    steps: () => [
      () => started({ type: "webSearch", id: "w-1", query: "secret-query" }),
      () => completed({ type: "webSearch", id: "w-1", query: "secret-query" }),
      ...message("noted"),
    ],
  },
  "silent-items": {
    steps: () => [
      () => completed({ type: "userMessage", id: "u-1" }),
      () => completed({ type: "plan", id: "p-1", text: "a plan" }),
      () => completed({ type: "contextCompaction", id: "c-1" }),
      ...message("noted"),
    ],
  },
  "completion-only-item": {
    steps: () => [() => completed({ type: "somethingNew", id: "n-1" }), ...message("noted")],
  },
  "no-id-item": { steps: () => [() => started({ type: "somethingNew" }), ...message("noted")] },
  approve: {
    steps: () => [
      () =>
        started({ type: "commandExecution", id: "cmd-1", command: wrapped, status: "inProgress" }),
      askCommand("cmd-1", wrapped),
      () =>
        completed({ type: "commandExecution", id: "cmd-1", command: wrapped, status: "completed" }),
      ...message("ran"),
    ],
  },
  "network-kind": {
    steps: () => [askCommand("cmd-1", "curl example.com", { kind: "network" }), ...message("done")],
  },
  "network-context": {
    steps: () => [
      askCommand("cmd-1", "curl example.com", { networkApprovalContext: { host: "x" } }),
      ...message("done"),
    ],
  },
  "no-command": { steps: () => [askCommand("cmd-1", null), ...message("done")] },
  "patch-inside": patchItem(inside),
  "patch-outside": patchItem(scriptedOutside),
  "patch-move": patchItem(() => [
    {
      path: `${process.env.FAKE_PROJECT}/old.txt`,
      kind: { type: "update", move_path: `${process.env.FAKE_OUTSIDE}/new.txt` },
      diff: "@@ -1 +1 @@\n-a\n+b\n",
    },
  ]),
  "patch-refused": patchItem(() => [
    ...inside(),
    { path: `${process.env.FAKE_HOME}/.ssh/id_rsa`, kind: { type: "delete" }, diff: "key\n" },
  ]),
  "patch-updated": {
    steps: () => [
      () => started({ type: "fileChange", id: "patch-1", changes: [], status: "inProgress" }),
      () => note("item/fileChange/patchUpdated", { itemId: "patch-1", changes: inside() }),
      askPatch("patch-1"),
      fileDone("patch-1", inside()),
      ...message("patched"),
    ],
  },
  "patch-unknown": { steps: () => [askPatch("never-started"), ...message("done")] },
  "patch-empty": {
    steps: () => [fileChange("patch-1", []), askPatch("patch-1"), ...message("done")],
  },
  "patch-newline": {
    steps: () => [
      fileChange("patch-1", [{ path: "a\n=== b", kind: { type: "add" }, diff: "x\n" }]),
      askPatch("patch-1"),
      ...message("done"),
    ],
  },
  "patch-shape": {
    steps: () => [
      fileChange("patch-1", [{ path: "a", kind: "add" }]),
      askPatch("patch-1"),
      ...message("done"),
    ],
  },
  refused: {
    steps: () => [
      ask("item/permissions/requestApproval", { itemId: "x" }),
      ask("item/tool/requestUserInput", { itemId: "x" }),
      ask("mcpServer/elicitation/request", { serverName: "bee" }),
      ask("item/tool/call", { tool: "x" }),
      ask("account/chatgptAuthTokens/refresh", {}),
      ask("applyPatchApproval", {}),
      ask("something/brandNew", {}),
      ...message("survived"),
    ],
  },
  "limit-usage": failedWith("usageLimitExceeded"),
  "limit-rate": failedWith("rateLimitExceeded"),
  "limit-429": failedWith({ httpConnectionFailed: { httpStatusCode: 429 } }),
  "limit-reset": {
    steps: () => [
      () =>
        note("account/rateLimits/updated", {
          rateLimits: {
            primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 600 },
            secondary: { usedPercent: 7, resetsAt: Math.floor(Date.now() / 1000) + 90_000 },
          },
        }),
      ended("failed", { message: "words", codexErrorInfo: "usageLimitExceeded" }),
    ],
  },
  "auth-unauthorized": failedWith("unauthorized"),
  "auth-401": failedWith({ responseStreamConnectionFailed: { httpStatusCode: 401 } }),
  "failed-other": failedWith("serverOverloaded"),
  "failed-text": {
    steps: () => [ended("failed", { message: "usageLimitExceeded unauthorized" })],
  },
  interrupted: { steps: () => [ended("interrupted")] },
  "exit-mid-turn": {
    steps: () => [
      () => note("error", { error: { codexErrorInfo: "usageLimitExceeded" }, willRetry: false }),
      () => process.exit(1),
    ],
  },
  "retry-then-success": {
    steps: () => [
      () => note("error", { error: { codexErrorInfo: "usageLimitExceeded" }, willRetry: true }),
      ...message("noted"),
    ],
  },
  "exit-silently": { steps: () => [() => process.exit(1)] },
  hang: { steps: () => [...message("partial"), "hang"], honoursInterrupt: true },
  // Waits for a turn/steer, then answers the steered text in the same turn.
  steer: { steps: () => [...message("partial"), "await-steer"] },
  "ignores-interrupt": { steps: () => [...message("partial"), "hang"] },
  "linger-after-stdin": { steps: () => message("noted"), ignoresStdinEnd: true },
  "gate-version": { userAgent: "bee/9.9.9 (Windows; x86_64)", steps: () => message("noted") },
  "gate-no-version": { userAgent: "garbled", steps: () => message("noted") },
  "gate-logged-out": { account: null, steps: () => message("noted") },
  // An older CLI that has no `account/read`.
  "gate-no-account-read": {
    accountError: { code: -32_601, message: "method not found" },
    steps: () => message("noted"),
  },
  // The key is planted: the real reply carries none, but nothing Bee keeps may hold it if one did.
  "gate-api-key": {
    account: { type: "apiKey", apiKey: "sk-planted-key-that-must-not-leak" },
    steps: () => message("noted"),
  },
  "gate-bedrock": { account: { type: "amazonBedrock" }, steps: () => message("noted") },
  "gate-silent": { silent: true },
  "project-active": {
    layers: [{ name: { type: "project", dotCodexFolder: "x" }, config: {}, version: "1" }],
    steps: () => message("noted"),
  },
  "config-shape": { layers: "nope", steps: () => message("noted") },
  "dotted-server": { servers: { "my.server": {} }, steps: () => message("noted") },
  "thread-fails": { threadError: { code: -32_603, message: "nope" } },
  "turn-rejected": { turnError: { code: -32_600, message: "nope" } },
  "lost-thread": {
    resumeError: { code: -32_600, message: "no rollout found for thread id x" },
    steps: () => message("noted"),
  },
  "resume-other-error": {
    resumeError: { code: -32_603, message: "nope" },
    steps: () => message("noted"),
  },
  "model-list-empty": { models: [] },
};

const scenario = scenarios[scenarioName] ?? {};

const models = [
  {
    id: "gpt-6.1-sol",
    displayName: "GPT-6.1-Sol",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }],
  },
  {
    id: "gpt-hidden",
    displayName: "Hidden",
    hidden: true,
    supportedReasoningEfforts: [{ reasoningEffort: "low" }],
  },
];

const replies = {
  initialize: () => ({
    result: {
      userAgent: scenario.userAgent ?? "bee/0.167.0 (Windows 10.0; x86_64) xterm (bee; 1)",
      codexHome: "x",
      platformFamily: "windows",
      platformOs: "windows",
    },
  }),
  "account/read": () =>
    scenario.accountError
      ? { error: scenario.accountError }
      : {
          result: {
            account: scenario.account === undefined ? chatgpt : scenario.account,
            requiresOpenaiAuth: true,
          },
        },
  "model/list": () => ({ result: { data: scenario.models ?? models, nextCursor: null } }),
  "thread/inject_items": () =>
    scenario.injectError ? { error: scenario.injectError } : { result: {} },
  "skills/list": () => ({
    result: {
      data: [
        { cwd: "x", errors: [], skills: [{ name: "repo-skill" }] },
        { cwd: "y", errors: [], skills: [{ name: "owner-skill" }] },
      ],
    },
  }),
  "config/read": () => ({
    result: {
      config: { mcp_servers: { bee: {}, owner_server: {}, ...scenario.servers } },
      layers: scenario.layers ?? quietLayers,
    },
  }),
  "thread/start": () =>
    scenario.threadError
      ? { error: scenario.threadError }
      : { result: { thread: { id: "thread-from-codex" } } },
  "thread/resume": (params) =>
    (scenario.resumeError ?? scenario.threadError)
      ? { error: scenario.resumeError ?? scenario.threadError }
      : { result: { thread: { id: params.threadId } } },
};

const answers = new Map();
let awaitSteer;
let nextAsk = 1000;

function askServer(method, params) {
  const id = nextAsk++;
  return new Promise((resolve) => {
    answers.set(id, ({ result, error }) => {
      log({ answered: method, result, error });
      resolve();
    });
    write({ id, method, params });
  });
}

async function runTurn() {
  note("turn/started", { turn: { id: "turn-1", status: "inProgress", items: [] } });
  for (const step of scenario.steps?.() ?? []) {
    if (step === "hang") {
      return;
    }
    if (step === "await-steer") {
      const text = await new Promise((resolve) => {
        awaitSteer = resolve;
      });
      message(`heard ${text}`).forEach((emit) => emit());
      continue;
    }
    if (typeof step === "function") {
      step();
    } else {
      await askServer(step.ask, step.params);
    }
  }
  if (!turnOver) {
    ended("completed")();
  }
}

log({ pid: process.pid, args, cwd: process.cwd(), env: Object.keys(process.env) });
log({ token: process.env.BEE_MCP_TOKEN });

setInterval(() => {}, 1000);
if (!scenario.ignoresStdinEnd) {
  process.stdin.on("end", () => process.exit(0));
}
NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params, result, error } = JSON.parse(line);
  if (method === undefined) {
    answers.get(id)?.({ result, error });
    return;
  }
  log({ rpc: method, params });
  if (scenario.silent || id === undefined) {
    return;
  }
  if (method === "turn/start") {
    if (scenario.turnError) {
      write({ id, error: scenario.turnError });
      return;
    }
    write({ id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
    void runTurn();
  } else if (method === "turn/steer") {
    if (turnOver || params.expectedTurnId !== "turn-1") {
      write({ id, error: { code: -32_600, message: "no active turn" } });
      return;
    }
    write({ id, result: { turnId: "turn-1" } });
    awaitSteer?.(params.input.map(({ text }) => text).join(""));
  } else if (method === "turn/interrupt") {
    write({ id, result: {} });
    if (scenario.honoursInterrupt) {
      ended("interrupted")();
    }
  } else {
    write({ id, ...replies[method]?.(params) });
  }
});
