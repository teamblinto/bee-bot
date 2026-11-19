// A stand-in for the CLI, run as a real child process so tests never touch the real one.
// Usage: node fake-claude.mjs <scenario> <log file> ...<claude args>
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const [scenarioName = "", logPath = "", ...args] = process.argv.slice(2);

// Test inputs come in a file beside the log: Bee Bot passes the CLI only a fixed set of variables.
const fakeInput = (() => {
  try {
    return JSON.parse(NodeFS.readFileSync(`${logPath}.input.json`, "utf8"));
  } catch {
    return {};
  }
})();

const fixture = (name) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const log = (entry) => NodeFS.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
const passingInit = fixture("success.ndjson")[0];
const replay = (name) => fixture(name).slice(1);
const resultFrame = (fields) => ({ type: "result", subtype: "success", is_error: true, ...fields });
const rateLimit = (fields) => ({ type: "rate_limit_event", rate_limit_info: fields });

function withAccount(account, version = passingInit.response.response.claude_code_version) {
  const response = { ...passingInit.response.response, account, claude_code_version: version };
  return { ...passingInit, response: { ...passingInit.response, response } };
}

const usageReply = fixture("usage.ndjson")[0];
const withUsage = (response) => ({
  type: "control_response",
  response: { subtype: "success", request_id: "usage-1", response },
});

const subscriber = passingInit.response.response.account;
// Unverified: no Console login was captured. Mirrors `consoleKeySource` in claude.ts.
const consoleKey = { apiProvider: "firstParty", apiKeySource: "/login managed key" };
const loggedIn = {
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "owner@example.com",
  orgName: "Owner Org",
};
const toolStart = (name, id = `toolu_${name}`) => ({
  type: "stream_event",
  event: { type: "content_block_start", content_block: { type: "tool_use", id, name, input: {} } },
});
const toolCall = (name, id, input) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const toolResult = (id, fields = {}) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, ...fields }] },
});
const thoughtBlock = (thinking) => [
  {
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
  },
  { type: "system", subtype: "thinking_tokens", estimated_tokens: 50 },
  {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } },
  },
  { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
];

// Limit and retry frames are synthetic: no real one was ever captured.
const scenarios = {
  success: { frames: () => replay("success.ndjson") },
  thinking: { frames: () => replay("thinking.ndjson") },
  "tool-use": { frames: () => [toolStart("Bash"), toolStart("Read"), ...replay("success.ndjson")] },
  "tool-detail": {
    frames: () => [
      toolStart("Bash", "toolu_1"),
      toolCall("Bash", "toolu_1", { command: "cat ~/secret-input.txt" }),
      toolResult("toolu_1", { content: "denied", is_error: true }),
      toolStart("Read", "toolu_2"),
      toolCall("Read", "toolu_2", { file_path: "notes.md" }),
      toolResult("toolu_2", { content: "the file's secret body" }),
      ...replay("success.ndjson"),
    ],
  },
  // The shape of a PreToolUse hook's deny is a guess: only the waiting message in it matters.
  "waiting-hook": {
    frames: () => [
      toolStart("Bash", "toolu_1"),
      toolCall("Bash", "toolu_1", { command: "deploy" }),
      toolResult("toolu_1", {
        content: [
          {
            type: "text",
            text: "PreToolUse:Bash hook blocked: waiting: 0b5c2f4e-8d1a-4c3b-9e7f-1a2b3c4d5e6f. The owner has to answer first. End your turn now: you will be resumed with the outcome.",
          },
        ],
        is_error: true,
      }),
      ...replay("success.ndjson"),
    ],
  },
  "rate-unified": {
    frames: () => [
      rateLimit({
        status: "allowed",
        resetsAt: 1793947200,
        rateLimitType: "five_hour",
        unifiedWindows: {
          five_hour: { utilization: 0.43, resetsAt: 1793947200, status: "allowed" },
          seven_day: { utilization: 0.71, resetsAt: 1794124800, status: "allowed" },
        },
      }),
      ...replay("success.ndjson").filter(({ type }) => type !== "rate_limit_event"),
    ],
  },
  usage: { usage: () => usageReply },
  "usage-shape": {
    usage: () => withUsage({ rate_limits_available: true, rate_limits: { five_hour: "soon" } }),
  },
  "usage-error": {
    usage: () => ({
      type: "control_response",
      response: { subtype: "error", request_id: "usage-1", error: "nope" },
    }),
  },
  "usage-none": { usage: () => withUsage({ rate_limits_available: false, rate_limits: null }) },
  "usage-silent": { usage: () => undefined, hang: true },
  "thought-text": { frames: () => [...thoughtBlock("Weighing it"), ...replay("success.ndjson")] },
  "login-lost": { frames: () => fixture("logged-out.ndjson").slice(1), exit: 1 },
  "status-401": { frames: () => [resultFrame({ api_error_status: 401 })], exit: 1 },
  "unknown-error": { frames: () => [resultFrame({ result: "Something new" })], exit: 1 },
  "no-result": { frames: () => [], exit: 1 },
  "limit-event": {
    frames: () => [
      rateLimit({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 600 }),
      resultFrame({ result: "limit" }),
    ],
    exit: 1,
  },
  "limit-overage": {
    frames: () => [
      rateLimit({
        status: "rejected",
        resetsAt: 1,
        overageStatus: "allowed",
        isUsingOverage: true,
      }),
      ...replay("success.ndjson").filter(({ type }) => type !== "rate_limit_event"),
    ],
  },
  "limit-api-error": {
    frames: () => [resultFrame({ api_error: "usage_limit_reached" })],
    exit: 1,
  },
  "limit-assistant": {
    frames: () => [{ type: "assistant", error: "rate_limit" }, resultFrame({})],
    exit: 1,
  },
  "limit-429": { frames: () => [resultFrame({ api_error_status: 429 })], exit: 1 },
  "api-retry": {
    frames: () => Array.from({ length: 8 }, () => ({ type: "system", subtype: "api_retry" })),
    hang: true,
  },
  hang: {
    frames: () => replay("success.ndjson").filter(({ type }) => type === "stream_event"),
    hang: true,
  },
  linger: { frames: () => replay("success.ndjson"), hang: true },
  // The first turn hangs until it is killed for a steer, and the resumed one answers.
  steer: args.includes("--resume")
    ? { frames: () => replay("success.ndjson") }
    : {
        frames: () => replay("success.ndjson").filter(({ type }) => type === "stream_event"),
        hang: true,
      },
  "tool-hang": { frames: () => [toolStart("Bash")], hang: true },
  "gate-api-key": {
    init: () => withAccount({ ...subscriber, apiKeySource: "ANTHROPIC_API_KEY" }),
    frames: () => replay("success.ndjson"),
  },
  // A box on the API lane: the key is the proxy's placeholder in ANTHROPIC_API_KEY.
  "gate-proxy-key": {
    init: () => withAccount({ apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }),
    frames: () => replay("success.ndjson"),
  },
  "gate-token": {
    init: () => withAccount({ ...subscriber, tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }),
    frames: () => replay("success.ndjson"),
  },
  "gate-console": { init: () => withAccount(consoleKey), frames: () => replay("success.ndjson") },
  "gate-logged-out": {
    init: () => fixture("logged-out.ndjson")[0],
    frames: () => replay("success.ndjson"),
  },
  "noisy-success": { frames: () => replay("success.ndjson"), noise: true },
  "no-final-newline": { frames: () => replay("success.ndjson"), noNewline: true },
  // The test sets the account fields a credential source would show in the init reply.
  "gate-account": {
    init: () => withAccount({ ...subscriber, ...JSON.parse(fakeInput.FAKE_CLAUDE_ACCOUNT) }),
    frames: () => replay("success.ndjson"),
  },
  "repo-loader": { loadsRepo: true, frames: () => replay("success.ndjson") },
  "gate-silent": { init: () => undefined, hang: true },
  "gate-version": {
    version: "9.9.9",
    init: () => withAccount(subscriber, "9.9.9"),
    frames: () => replay("success.ndjson"),
  },
  // An older CLI: no login in the `initialize` reply, and no `auth status`.
  "gate-no-account": {
    version: "1.0.0",
    init: () => withAccount(undefined, "1.0.0"),
    auth: "error: unknown command 'auth'",
    authExit: 1,
    frames: () => replay("success.ndjson"),
  },
  "in-use": {
    frames: () => replay("success.ndjson"),
    onStart: () => (args.includes("--session-id") ? "in_use" : undefined),
  },
  "always-in-use": { onStart: () => "in_use" },
  // What a real 2.1.322 prints for a flag it doesn't know, before it reads any input.
  "unknown-flag": { onStart: () => "unknown_flag" },
  "no-conversation": { onStart: () => "no_conversation" },
  "logged-out-status": { auth: { loggedIn: false }, authExit: 1 },
  "api-key-status": { auth: { ...loggedIn, apiKeySource: "ANTHROPIC_API_KEY" } },
  "console-status": { auth: { ...loggedIn, authMethod: "console", ...consoleKey } },
  broken: { broken: true },
};

const scenario = scenarios[scenarioName] ?? {};

function send(frames, code) {
  if (scenario.noise) {
    console.error("listen EADDRINUSE: address already in use. No conversation found in cache.");
  }
  const text = frames.map((frame) => `${JSON.stringify(frame)}\n`).join("");
  process.stdout.write(scenario.noNewline ? text.trimEnd() : text, () => {
    if (scenario.hang) {
      setInterval(() => {}, 1000);
    } else {
      process.exit(code ?? 0);
    }
  });
}

log({ pid: process.pid, args, cwd: process.cwd(), env: Object.keys(process.env) });
if (args.includes("--mcp-config")) {
  const config = args[args.indexOf("--mcp-config") + 1];
  log({ mcpConfig: config.startsWith("{") ? config : NodeFS.readFileSync(config, "utf8") });
}

if (args[0] === "--version") {
  if (scenario.broken) {
    console.error("Error: something inside the CLI broke");
    process.exit(1);
  }
  console.log(`${scenario.version ?? "2.1.318"} (Claude Code)`);
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(
    typeof scenario.auth === "string" ? scenario.auth : JSON.stringify(scenario.auth ?? loggedIn),
  );
  process.exit(scenario.authExit ?? 0);
}

// What the docs say non-bare `-p` loads from a folder it never asks to trust: hooks, the `env`
// block and `apiKeyHelper` from project and local settings, and `.mcp.json` servers. A model of
// the CLI, not the CLI: only spike S1 proves the real one honours these flags.
function loadRepo() {
  const flag = args.indexOf("--setting-sources");
  const sources = flag === -1 ? ["user", "project", "local"] : args[flag + 1].split(",");
  const files = { project: "settings.json", local: "settings.local.json" };
  for (const source of sources.filter((name) => name in files)) {
    const path = NodePath.join(process.cwd(), ".claude", files[source]);
    const settings = NodeFS.existsSync(path) ? JSON.parse(NodeFS.readFileSync(path, "utf8")) : {};
    Object.assign(process.env, settings.env);
    for (const { hooks = [] } of settings.hooks?.SessionStart ?? []) {
      hooks.forEach(({ command }) => NodeChildProcess.execSync(command));
    }
    if (settings.apiKeyHelper) {
      NodeChildProcess.execSync(settings.apiKeyHelper);
    }
  }
  const mcpPath = NodePath.join(process.cwd(), ".mcp.json");
  if (!args.includes("--strict-mcp-config") && NodeFS.existsSync(mcpPath)) {
    const { mcpServers = {} } = JSON.parse(NodeFS.readFileSync(mcpPath, "utf8"));
    for (const { command, args: serverArgs = [] } of Object.values(mcpServers)) {
      NodeChildProcess.execFileSync(command, serverArgs);
    }
  }
  log({ loadedEnv: Object.keys(process.env) });
}

if (scenario.loadsRepo) {
  loadRepo();
}

const early = scenario.onStart?.();
if (early === "in_use") {
  console.error("Error: Session ID 00000000-0000-4000-8000-000000000001 is already in use.");
  process.exit(1);
}
if (early === "unknown_flag") {
  console.error("error: unknown option '--system-prompt-snapshot'");
  process.exit(1);
}
if (early === "no_conversation") {
  send(fixture("resume-unknown.ndjson"), 1);
} else {
  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.type === "control_request") {
      log({ control: frame.request.subtype });
      // A logged-in CLI answers `get_usage`. Left silent, the probe holds the account for its timeout.
      const reply =
        frame.request.subtype === "get_usage"
          ? "usage" in scenario
            ? scenario.usage()
            : usageReply
          : scenario.init
            ? scenario.init()
            : passingInit;
      if (reply) {
        process.stdout.write(`${JSON.stringify(reply)}\n`);
      }
    } else if (frame.type === "user") {
      log({ prompt: frame.message.content[0].text });
      send(scenario.frames?.() ?? [], scenario.exit);
    }
  });
  if (scenario.hang) {
    setInterval(() => {}, 1000);
  }
}
