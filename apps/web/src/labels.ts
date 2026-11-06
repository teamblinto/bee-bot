import type {
  Approval,
  ApprovalTool,
  Bot,
  EngineAccount,
  EngineStatus,
  Run,
  RunReason,
} from "@beebot/contracts";

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// The card is the only control on a command, so nothing in it may render invisibly or reorder text.
export const visibleDetail = (detail: string) =>
  detail.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    (char) => `[U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}]`,
  );

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

export function pauseLine(reason: NonNullable<Bot["pauseReason"]>, engine?: EngineStatus) {
  const version = engine ? `version ${engine.testedVersion}` : "the tested version";
  const lines = {
    owner: "Paused. Resume to send messages.",
    auth_failed: "Claude login couldn't be verified. Run claude auth login, then Resume.",
    cli_missing: "Claude Code wasn't found. Install it, then Resume.",
    cli_version: `This Claude Code version is untested. Install ${version}, then Resume.`,
    config_dir:
      "CLAUDE_CONFIG_DIR is set and Bee Bot ignores it, so Claude looks logged out. Run claude auth login, then Resume.",
  };
  return lines[reason];
}

const reasonLines: Record<RunReason, string> = {
  unattended: "Refused. No client was connected when this was sent.",
  bot_paused: "Refused. This bot is paused. Resume it, then send again.",
  daily_cap: "Refused. This bot reached its daily run cap.",
  engine_failed: "The engine couldn't finish this turn. Send again to retry.",
  limited: "Limited. This retries when the limit clears, unless stopped.",
  auth_failed: "Claude couldn't be verified, so this bot was paused.",
  timeout: "This turn ran past its time limit. Send again to retry.",
  stopped: "Stopped.",
  server_restarted: "Interrupted. The server restarted during this turn. Nothing was repeated.",
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

export const doneLine = (count: number) => `Done · ${count} ${count === 1 ? "tool" : "tools"}`;
