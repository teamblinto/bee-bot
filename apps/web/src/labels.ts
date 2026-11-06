import {
  type Approval,
  type ApprovalChange,
  type ApprovalTool,
  type Bot,
  type EngineAccount,
  type EngineStatus,
  type MemoryItem,
  memoryRequest,
  type MemoryType,
  type Run,
  type RunReason,
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
export function engineFix(engine: EngineStatus) {
  if (!engine.cliFound) {
    return {
      label: "Claude Code isn't installed",
      text: "Install Claude Code from a terminal, then check again.",
      // The only install command confirmed so far.
      command: navigator.userAgent.includes("Windows")
        ? "irm https://claude.ai/install.ps1 | iex"
        : undefined,
    };
  }
  if (!engine.versionOk) {
    return {
      label: "This Claude Code version is untested",
      text: `Bee Bot is tested with version ${engine.testedVersion}. Install it from a terminal, then check again.`,
      command: `claude install ${engine.testedVersion}`,
    };
  }
  if (engine.pauseReason === "config_dir") {
    return {
      label: "Claude looks logged out",
      text: "CLAUDE_CONFIG_DIR is set and Bee Bot ignores it. Log in to the default config from a terminal, then check again.",
      command: "claude auth login",
    };
  }
  if (!engine.loggedIn || engine.pauseReason === "auth_failed") {
    return {
      label: "Claude isn't logged in",
      text: "Log in from your own terminal, then check again. Bee Bot never sees your credentials.",
      command: "claude auth login",
    };
  }
  return undefined;
}

export const testedCodexVersion = "0.167.0";

// config_dir is Claude's alone.
const codexPauseLines: Partial<Record<NonNullable<Bot["pauseReason"]>, string>> = {
  auth_failed:
    "Codex login couldn't be verified. Run codex login in your own terminal, then Resume.",
  cli_missing: "Codex CLI wasn't found. Install it, then Resume.",
  cli_version: `This Codex version is untested. Install version ${testedCodexVersion}, then Resume.`,
};

export function pauseLine(
  reason: NonNullable<Bot["pauseReason"]>,
  accountId: string,
  engine?: EngineStatus,
) {
  const version = engine ? `version ${engine.testedVersion}` : "the tested version";
  const lines = {
    owner: "Paused. Resume to send messages.",
    auth_failed: "Claude login couldn't be verified. Run claude auth login, then Resume.",
    cli_missing: "Claude Code wasn't found. Install it, then Resume.",
    cli_version: `This Claude Code version is untested. Install ${version}, then Resume.`,
    config_dir:
      "CLAUDE_CONFIG_DIR is set and Bee Bot ignores it, so Claude looks logged out. Run claude auth login, then Resume.",
  };
  return (accountId === "codex" ? codexPauseLines[reason] : undefined) ?? lines[reason];
}

const reasonLines: Record<RunReason, string> = {
  unattended: "Refused. No client was connected when this was sent.",
  bot_paused: "Refused. This bot is paused. Resume it, then send again.",
  daily_cap: "Refused. This bot reached its daily run cap.",
  engine_failed: "The engine couldn't finish this turn. Send again to retry.",
  limited: "Limited. This retries when the limit clears, unless stopped.",
  auth_failed: "This bot's login couldn't be verified, so it was paused.",
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
]);

export function toolRowLabel({ name, detail, status }: Omit<LiveTool, "id">) {
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
export function liveStatusLine(thinking: boolean, tools: LiveTool[], replying: boolean) {
  const last = tools.at(-1);
  if (last?.status === "failed") {
    return `${toolRowLabel(last)} failed`;
  }
  if (last?.status === "running") {
    return toolRowLabel(last);
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
    return { title: "Wants to remember this", lines: [{ label: "Memory", text: item.text }] };
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
