import {
  type Approval,
  type Connector,
  connectorToolPrefix,
  connectorUsable,
  type ApprovalChange,
  type ApprovalTool,
  type Bot,
  type EngineAccount,
  type EngineLane,
  type EngineStatus,
  type HostPlatform,
  type MemoryItem,
  memoryRequest,
  type MemoryType,
  type Routine,
  type RoutineFiring,
  type Run,
  type RunReason,
  setupCommand,
  type UsageLimits,
  type UsageRow,
} from "@beebot/contracts";

import type { LiveTool } from "./serverConnection";

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// The card is the only control on a command, so nothing in it may render invisibly or reorder text.
export const visibleDetail = (detail: string) =>
  detail.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    (char) => `[U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}]`,
  );

// Empty text has no lines: an edit that only removes must not show a blank added line.
export const changeLines = (prefix: "- " | "+ ", text: string) =>
  text &&
  text
    .split(/\r?\n/)
    .map((line) => prefix + visibleDetail(line))
    .join("\n");

export function changeNote({ action, replaceAll }: ApprovalChange) {
  if (action === "edit") {
    return replaceAll ? "Replaces every match" : undefined;
  }
  const notes = {
    create: "New file",
    replace: "Replaces an existing file",
    write: "Creates or replaces this file",
    patch: undefined,
  };
  return notes[action];
}

export const codexRulesWarning =
  "Commands you've pre-approved in Codex's own rules (~/.codex/rules) run without a card.";

// Bee never takes the key: the owner logs the vendor CLI in, and Bee checks it matches.
export const laneLabels = {
  claude: { subscription: "Claude subscription", api_key: "API key (Console login)" },
  codex: { subscription: "ChatGPT plan", api_key: "API key" },
} satisfies Record<string, Record<EngineLane, string>>;

export const hiddenCharsLine = (count: number) =>
  `${formatCount(count)} more ${count === 1 ? "character" : "characters"} not shown. Allowing applies the whole change.`;

export function shortTime(iso: string) {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? clock(iso)
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export const connectionLines = {
  unconfigured: "Open Bee Bot from the desktop app.",
  connecting: "Connecting…",
  disconnected: "Can't reach the Bee Bot server. Retrying…",
  incompatible: "This app and its server don't match. Update Bee Bot.",
};

// Only the first failing item: each check depends on the one before it.
export function engineFix(engine: EngineStatus, host?: HostPlatform) {
  if (!engine.cliFound) {
    return {
      label: "Claude Code isn't installed",
      text: "Install Claude Code from a terminal, then check again.",
      command: host && setupCommand(host, "claude-install"),
    };
  }
  if (engine.pauseReason === "cli_failed") {
    return {
      label: "Claude Code didn't start",
      text: "Bee Bot found Claude Code, but it didn't answer. Run it from a terminal to see what's wrong, then check again.",
      command: "claude --version",
    };
  }
  if (engine.pauseReason === "config_dir") {
    return {
      label: "Claude looks logged out",
      text: "CLAUDE_CONFIG_DIR is set and Bee Bot ignores it. Log in to the default config from a terminal, then check again.",
      command: "claude auth login",
    };
  }
  if (engine.pauseReason === "credential_source") {
    return {
      label: "Claude is logged in a different way",
      text: "Claude Code is logged in with another method than this account's login setting. Log in with the matching one from a terminal, then check again.",
      command: "claude auth login",
    };
  }
  if (engine.auth === "unauthenticated" || engine.pauseReason === "auth_failed") {
    return {
      label: "Claude isn't logged in",
      text: "Log in from your own terminal, then check again. Bee Bot never sees your credentials.",
      command: "claude auth login",
    };
  }
  return undefined;
}

// config_dir is Claude's alone.
const codexPauseLines: Partial<Record<NonNullable<Bot["pauseReason"]>, string>> = {
  auth_failed:
    "Codex login couldn't be verified. Run codex login in your own terminal, then Resume.",
  cli_missing: "Codex CLI wasn't found. Install it, then Resume.",
  cli_failed:
    "Codex was found but didn't start. Run codex from a terminal to see what's wrong, then Resume.",
};

const credentialLines = {
  claude: {
    subscription:
      "Claude Code is logged in with something other than your Claude subscription. Run claude auth login and sign in with your Claude account, then Resume.",
    api_key:
      "Claude Code isn't logged in with a Console API key. Run claude auth login and sign in with your Anthropic Console account, then Resume.",
  },
  codex: {
    subscription:
      "Codex is logged in with something other than ChatGPT. Run codex login and sign in with ChatGPT, then Resume.",
    api_key:
      "Codex isn't logged in with an API key. Run codex login --with-api-key in your own terminal, then Resume.",
  },
};

// A box keeps its own subscription login, which the Log in panel runs inside it. No terminal the
// owner has can reach it, and on a server install there is none at all.
export function boxLoginLine(
  reason: NonNullable<Bot["pauseReason"]>,
  accountId: string,
  lane: EngineLane = "subscription",
) {
  if (reason !== "auth_failed" || lane !== "subscription") {
    return undefined;
  }
  return `${accountId === "codex" ? "Codex" : "Claude"} isn't logged in for this bot. Log in, then Resume.`;
}

export function pauseLine(
  reason: NonNullable<Bot["pauseReason"]>,
  accountId: string,
  lane: EngineLane = "subscription",
) {
  if (reason === "credential_source") {
    return credentialLines[accountId === "codex" ? "codex" : "claude"][lane];
  }
  const lines = {
    owner: "Paused. Resume to send messages.",
    auth_failed: "Claude login couldn't be verified. Run claude auth login, then Resume.",
    cli_missing: "Claude Code wasn't found. Install it, then Resume.",
    // Only a pause from an older Bee Bot: versions no longer block.
    cli_version: "Paused by an old version check that no longer applies. Resume to continue.",
    cli_failed:
      "Claude Code was found but didn't start. Update it with claude update, then Resume.",
    config_dir:
      "CLAUDE_CONFIG_DIR is set and Bee Bot ignores it, so Claude looks logged out. Run claude auth login, then Resume.",
    browser_session:
      "A site in this bot's browser needs you. Open Browser from the bot menu and take control.",
    budget: "Paused at its daily spend cap. Raise the cap, or Resume for one more turn.",
  };
  return (accountId === "codex" ? codexPauseLines[reason] : undefined) ?? lines[reason];
}

const reasonLines: Record<RunReason, string> = {
  unattended:
    "Refused. Nobody was watching, and only a bot that runs in a box can work on its own.",
  box_unavailable:
    "Refused. Nobody was watching, and boxes weren't available. Check them on the Usage page.",
  automated_access:
    "Refused. Nobody was watching, and no API key is saved for this bot's engine on the Usage page.",
  bot_paused: "Refused. This bot is paused. Resume it, then send again.",
  daily_cap: "Refused. This bot reached its daily run cap.",
  box_limit:
    "Refused. Your other bots' boxes fill every slot you have. A box frees its slot after 15 idle minutes; send again then.",
  budget: "Refused. This month's API key budget is used up. Ask your admin to raise it.",
  credential_conflict:
    "Refused. Claude is set to your subscription, but an API key is also saved. Remove the key on the Usage page, or set Login to API key in Edit bot.",
  engine_failed: "The engine couldn't finish this turn. Send again to retry.",
  limited: "Limited. This retries when the limit clears, unless stopped.",
  // Every pause before a turn runs lands here, not only a login: the pause line names the cause.
  auth_failed: "This bot couldn't start, so it was paused.",
  timeout: "This turn ran past its time limit. Send again to retry.",
  stopped: "Stopped.",
  server_restarted: "Interrupted. The server restarted during this turn. Nothing was repeated.",
  folder_missing:
    "This bot's project folder is missing. Reconnect it or change it, then send again.",
};

const statusLines: Partial<Record<Run["status"], string>> = {
  Refused: "Refused.",
  Failed: "This turn failed. Send again to retry.",
  Cancelled: "Stopped.",
  Interrupted: "Interrupted.",
};

export function runLine(run: Run | undefined, account: EngineAccount | undefined) {
  const limited = account?.blockedUntil ? `Limited until ${clock(account.blockedUntil)}.` : "";
  if (!run || run.status === "Completed") {
    return limited;
  }
  if (run.reason === "limited") {
    return limited
      ? `${limited} This retries when it clears, unless stopped.`
      : reasonLines.limited;
  }
  return (run.reason ? reasonLines[run.reason] : statusLines[run.status]) ?? limited;
}

const approvalVerbs: Record<ApprovalTool, string> = {
  Bash: "run a command",
  Read: "read a file",
  Glob: "read a file",
  Grep: "read a file",
  Write: "edit a file",
  Edit: "edit a file",
  Patch: "edit files",
};

export const approvalTitle = (name: string, tool: ApprovalTool) =>
  `${name} wants to ${approvalVerbs[tool]}`;

export function answeredLine({ status, reason }: Approval) {
  if (status === "expired") {
    return "Expired";
  }
  const answer = status === "allowed" ? "Allowed" : "Denied";
  if (reason === "timeout") {
    return `${answer} · Timed out`;
  }
  return reason === "stopped" ? `${answer} · Stopped` : answer;
}

// Windows' "Copy as path" wraps the path in quotes.
export function projectPathValue(text: string) {
  return (
    text
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2")
      .trim() || null
  );
}

export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  return hours === 0
    ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
    : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function workedLine(workedMs: number | null, count: number) {
  const worked = workedMs === null ? "Worked" : `Worked for ${formatElapsed(workedMs)}`;
  return count === 0 ? worked : `${worked} · ${count} ${count === 1 ? "tool" : "tools"}`;
}

// The newest line is what the bot is on now.
export const liveThoughtLine = (text: string) => text.trim().split("\n").at(-1)?.trim() ?? "";

// A Map, because a tool name is whatever the engine reports and could be "constructor".
const toolVerbs = new Map([
  ["Bash", { running: "Running", done: "Ran", bare: "Ran a command" }],
  ["Read", { running: "Reading", done: "Read", bare: "Read a file" }],
  ["Write", { running: "Writing", done: "Wrote", bare: "Wrote a file" }],
  ["Edit", { running: "Editing", done: "Edited", bare: "Edited a file" }],
  ["Patch", { running: "Editing", done: "Edited", bare: "Edited files" }],
  ["Glob", { running: "Finding", done: "Found", bare: "Found files" }],
  ["Grep", { running: "Searching for", done: "Searched for", bare: "Searched files" }],
  ["mcp__bee__memory_search", { running: "Searching memory", done: "", bare: "Searched memory" }],
  ["mcp__bee__memory_get", { running: "Reading a memory", done: "", bare: "Read a memory" }],
  ["mcp__bee__memory_propose", { running: "Saving a memory", done: "", bare: "Saved a memory" }],
  [
    "mcp__bee__memory_forget",
    { running: "Forgetting a memory", done: "", bare: "Forgot a memory" },
  ],
  ["mcp__bee__computer_windows", { running: "Listing windows", done: "", bare: "Listed windows" }],
  ["mcp__bee__computer_open", { running: "Opening an app", done: "", bare: "Opened an app" }],
  [
    "mcp__bee__computer_look",
    { running: "Looking at a window", done: "", bare: "Looked at a window" },
  ],
  [
    "mcp__bee__computer_desktop",
    { running: "Looking at the screen", done: "", bare: "Looked at the screen" },
  ],
  ["mcp__bee__computer_window_click", { running: "Clicking", done: "", bare: "Clicked" }],
  ["mcp__bee__computer_window_type", { running: "Typing", done: "", bare: "Typed" }],
  ["mcp__bee__computer_window_key", { running: "Pressing keys", done: "", bare: "Pressed keys" }],
  ["mcp__bee__computer_window_scroll", { running: "Scrolling", done: "", bare: "Scrolled" }],
  ["mcp__bee__computer_window_drag", { running: "Dragging", done: "", bare: "Dragged" }],
  // A large catalog's two tools. The real tool's name is only in the input, which clients never see.
  [
    "mcp__connectors__connectors_search",
    { running: "Searching apps", done: "", bare: "Searched apps" },
  ],
  ["mcp__connectors__connectors_call", { running: "Using an app", done: "", bare: "Used an app" }],
]);

// The app a connector tool belongs to, by its slug, and the tool's own name.
function connectorTool(name: string, connectors: readonly Connector[]) {
  if (!name.startsWith(connectorToolPrefix)) {
    return undefined;
  }
  const exposed = name.slice(connectorToolPrefix.length);
  const connector = connectors.find(({ slug }) => exposed.startsWith(`${slug}_`));
  return connector
    ? { app: connector.name, tool: exposed.slice(connector.slug.length + 1) }
    : { app: exposed.split("_")[0] ?? exposed, tool: exposed.split("_").slice(1).join("_") };
}

export function connectorStatusLine(connector: Connector) {
  const statuses = {
    ok: "",
    needs_sign_in: "Needs a sign-in or a valid token.",
    needs_client: "Needs a client ID from the app's developer settings.",
    unreachable: "Can't be reached right now.",
    error: "Doesn't work.",
  };
  const status = statuses[connector.status];
  if (status) {
    return connector.lastError ? `${status} ${connector.lastError}` : status;
  }
  const tools =
    connector.reviewedHash === null
      ? `${connector.tools.length} tools, not reviewed yet.`
      : connectorUsable(connector)
        ? `${connector.tools.length} tools, reviewed.`
        : "Its tools changed since your review, so bots don't get them until you review again.";
  // A local server that stopped on its own starts again on the next call.
  return connector.lastError ? `${tools} It last stopped: ${connector.lastError}` : tools;
}

export function toolRowLabel(
  { name, detail, status }: Omit<LiveTool, "id">,
  connectors: readonly Connector[] = [],
) {
  const app = toolVerbs.has(name) ? undefined : connectorTool(name, connectors);
  if (app) {
    return `${status === "running" ? "Using" : "Used"} ${app.app}${app.tool ? ` · ${app.tool}` : ""}`;
  }
  const verbs = toolVerbs.get(name);
  if (!verbs) {
    return name;
  }
  if (status === "running") {
    return detail ? `${verbs.running} ${detail}` : `${verbs.running}…`;
  }
  return detail ? `${verbs.done} ${detail}` : verbs.bare;
}

// For screen readers, which get status changes, not every delta.
export function liveStatusLine(
  thinking: boolean,
  tools: LiveTool[],
  replying: boolean,
  connectors: readonly Connector[] = [],
) {
  const last = tools.at(-1);
  if (last?.status === "failed") {
    return `${toolRowLabel(last, connectors)} failed`;
  }
  if (last?.status === "running") {
    return toolRowLabel(last, connectors);
  }
  if (thinking) {
    return "Thinking";
  }
  return replying ? "Writing a reply" : "";
}

// Null when bars can be shown. The rows behind a failed check stay stored, but they are stale.
export function limitsNotice({ unavailable, windows }: UsageLimits) {
  if (unavailable?.message) {
    return unavailable.message;
  }
  if (unavailable?.reason === "unsupported") {
    return "This account has no subscription limits.";
  }
  if (unavailable?.reason === "probeFailed") {
    return "Could not read limits.";
  }
  return windows.length === 0 ? "No limits reported." : null;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const formatUsd = (value: number) => usd.format(value);
export const formatCount = (value: number) => integer.format(Math.round(value));

export const dailyLimitLine = ({
  dailyTokenCap,
  dailyUsdCap,
}: Pick<Bot, "dailyTokenCap" | "dailyUsdCap">) =>
  [
    dailyTokenCap !== null && `${formatCount(dailyTokenCap)} tokens`,
    dailyUsdCap !== null && formatUsd(dailyUsdCap),
  ]
    .filter(Boolean)
    .join(" · ");

function trimmed(value: number) {
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatTokens(value: number) {
  if (value >= 1e9) {
    return `${trimmed(value / 1e9)}B`;
  }
  if (value >= 1e6) {
    return `${trimmed(value / 1e6)}M`;
  }
  return value >= 1e3 ? `${trimmed(value / 1e3)}K` : formatCount(value);
}

export function formatPercent(share: number, digits = 1) {
  const percent = share * 100;
  const smallest = 10 ** -digits;
  return percent > 0 && percent < smallest
    ? `<${smallest.toFixed(digits)}%`
    : `${percent.toFixed(digits)}%`;
}

export const totalTokens = (row: UsageRow) =>
  row.input + row.cacheRead + row.cacheWrite + row.output;

export const usageRowValue = (row: UsageRow, metric: "tokens" | "cost") =>
  metric === "tokens" ? totalTokens(row) : row.costUsd;

// Null without input. Cache writes count as misses: that input was fully processed.
export function cacheHitRate(row: UsageRow) {
  const input = row.input + row.cacheRead + row.cacheWrite;
  return input === 0 ? null : row.cacheRead / input;
}

// A local day, or an ISO hour for the one-day window.
export function seriesLabel(start: string) {
  if (start.includes("T")) {
    return new Date(start).toLocaleTimeString([], { hour: "numeric" });
  }
  const [year = 0, month = 1, day = 1] = start.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString([], { month: "short", day: "numeric" });
}

export const routinesNotice =
  "A routine needs Bee Bot to be open and needs you to press Run. It never starts by itself.";

export const dayAndTime = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export const routineReadyLine = (name: string) => `${name} is ready to run`;

export const missedLine = (count: number) =>
  `${formatCount(count)} earlier ${count === 1 ? "run was" : "runs were"} missed`;

export function nextDueLine({ nextFireAt, staggerMs }: Routine) {
  if (!nextFireAt) {
    return "Turned off";
  }
  return `Next due ${dayAndTime(new Date(Date.parse(nextFireAt) + staggerMs).toISOString())}`;
}

export function heartbeatLine({ lastTickAt, lastAttemptAt }: Routine) {
  const checked = lastTickAt ? `Last checked ${dayAndTime(lastTickAt)}` : "Not checked yet";
  const started = lastAttemptAt ? `last started ${dayAndTime(lastAttemptAt)}` : "never started";
  return `${checked}, ${started}`;
}

export const routinePauseLines: Record<NonNullable<Routine["pausedReason"]>, string> = {
  owner_away: "Paused: you haven't used Bee Bot for a week. Send any message to resume.",
  setup_failed:
    "Turned off after 3 failed starts in a row. Check the bot's sign-in and folder, then turn it on.",
};

export const retryCardLine = "The last run failed. This is its one retry.";
export const catchUpLine = "Bee Bot wasn't open when this was due, so this is a catch-up.";

export const retryLine = (retryAt: string) =>
  `The last run failed. It can be retried once from ${dayAndTime(retryAt)}`;

const firingStatusLabels: Record<RoutineFiring["status"], string> = {
  ready: "Ready to run",
  ran: "Ran",
  skipped: "Skipped",
  missed: "Missed",
};

const firingReasonLines: Record<NonNullable<RoutineFiring["reason"]>, string> = {
  no_boundary: "nobody started it before the next run came due",
  asleep: "Bee Bot wasn't open within a day of it",
  bot_paused: "the bot was paused",
  disabled: "the routine was changed or turned off",
  too_late: "it was past its skip limit",
  owner_away: "you hadn't used Bee Bot for a week",
  catch_up: "catching up on a time Bee Bot missed",
};

export function firingLine({ status, reason, slot, missedBefore }: RoutineFiring) {
  const outcome = `Last: ${firingStatusLabels[status]} ${dayAndTime(slot)}`;
  const why = reason ? `, ${firingReasonLines[reason]}` : "";
  const missed = missedBefore > 0 ? `. ${missedLine(missedBefore)}` : "";
  return `${outcome}${why}${missed}`;
}

export const routineRefusalLines = {
  bot_paused: "This bot is paused. Resume it, then try again.",
  firing_closed: "This run is already closed.",
  invalid_cron: "That schedule isn't valid.",
  invalid_timezone: "This computer's time zone isn't recognized.",
  not_attended: "This run can only start from an open Bee Bot window.",
  schedule_too_frequent: "A routine can't run more often than every 15 minutes.",
  too_late: "This run was past its skip limit, so it was skipped.",
};

export const memoryNotice =
  "Memory is stored unencrypted on this computer. In Host mode, a shell command you approve can reach it.";

export const memoryTypeLabels: Record<MemoryType, string> = {
  user: "About you",
  feedback: "Feedback",
  project: "Project",
  reference: "Reference",
};

export const memoryLine = ({ type, source, created }: MemoryItem) =>
  `${memoryTypeLabels[type]} · ${source === "user" ? "You" : "Bot"} · ${shortTime(created)}`;

// What approving would do. `memories` is this bot's: a target that has left it changes the outcome.
export function memoryReview(item: MemoryItem, memories: MemoryItem[]) {
  const request = memoryRequest(item);
  if (!request) {
    const title =
      item.scope === "team" ? "Wants every bot to remember this" : "Wants to remember this";
    return { title, lines: [{ label: "Memory", text: item.text }] };
  }
  const target = memories.find(
    ({ id, status }) => id === request.targetId && status === "active",
  )?.text;
  if (request.kind === "supersede") {
    return target === undefined
      ? {
          title: "Wants to replace a memory that's already gone, so approving adds this as new",
          lines: [{ label: "Memory", text: item.text }],
        }
      : {
          title: "Wants to replace a memory",
          lines: [
            { label: "Replaces", text: target },
            { label: "With", text: item.text },
          ],
        };
  }
  const reason = { label: "Bot's reason", text: item.text };
  return target === undefined
    ? {
        title: "Wants to forget a memory that's already gone, so approving changes nothing",
        lines: [reason],
      }
    : {
        title: "Wants to forget a memory",
        lines: [{ label: "Forgets", text: target }, reason],
      };
}
