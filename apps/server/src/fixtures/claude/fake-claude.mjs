// A stand-in for the CLI, run as a real child process so tests never touch the real one.
// Usage: node fake-claude.mjs <scenario> <log file> ...<claude args>
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

const [scenarioName = "", logPath = "", ...args] = process.argv.slice(2);

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
  "gate-api-key": {
    init: () => withAccount({ ...subscriber, apiKeySource: "ANTHROPIC_API_KEY" }),
    frames: () => replay("success.ndjson"),
  },
  "gate-token": {
    init: () => withAccount({ ...subscriber, tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }),
    frames: () => replay("success.ndjson"),
  },
  "gate-logged-out": {
    init: () => fixture("logged-out.ndjson")[0],
    frames: () => replay("success.ndjson"),
  },
  "noisy-success": { frames: () => replay("success.ndjson"), noise: true },
  "no-final-newline": { frames: () => replay("success.ndjson"), noNewline: true },
  "gate-silent": { init: () => undefined, hang: true },
  "gate-version": {
    version: "9.9.9",
    init: () => withAccount(subscriber, "9.9.9"),
    frames: () => replay("success.ndjson"),
  },
  "in-use": {
    frames: () => replay("success.ndjson"),
    onStart: () => (args.includes("--session-id") ? "in_use" : undefined),
  },
  "always-in-use": { onStart: () => "in_use" },
  "no-conversation": { onStart: () => "no_conversation" },
  "logged-out-status": { auth: { loggedIn: false }, authExit: 1 },
  "api-key-status": { auth: { ...loggedIn, apiKeySource: "ANTHROPIC_API_KEY" } },
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
  log({ mcpConfig: NodeFS.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8") });
}

if (args[0] === "--version") {
  console.log(`${scenario.version ?? "2.1.318"} (Claude Code)`);
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(JSON.stringify(scenario.auth ?? loggedIn));
  process.exit(scenario.authExit ?? 0);
}

const early = scenario.onStart?.();
if (early === "in_use") {
  console.error("Error: Session ID 00000000-0000-4000-8000-000000000001 is already in use.");
  process.exit(1);
}
if (early === "no_conversation") {
  send(fixture("resume-unknown.ndjson"), 1);
} else {
  NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.type === "control_request") {
      log({ control: frame.request.subtype });
      const reply =
        frame.request.subtype === "get_usage"
          ? scenario.usage?.()
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
