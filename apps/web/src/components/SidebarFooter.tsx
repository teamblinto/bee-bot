import {
  CircleCheck,
  CircleX,
  Download,
  LoaderCircle,
  Moon,
  RefreshCw,
  Sun,
  SunMoon,
} from "lucide-react";
import { useState } from "react";

import { useDesktopUpdate } from "../desktop";
import { connectionLines, engineFix } from "../labels";
import { readTheme, saveTheme, type Theme } from "../preferences";
import { type ConnectionState, sendCommand } from "../serverConnection";
import { remainingPercent } from "../usageLimits";
import { Tooltip } from "./Tooltip";
import { iconProps } from "./ui";

function statusLine({ status, engine }: ConnectionState) {
  if (status === "connecting") {
    return { Icon: LoaderCircle, text: connectionLines.connecting, error: false };
  }
  const problem =
    status === "connected" ? engine && engineFix(engine)?.label : connectionLines[status];
  if (problem) {
    return { Icon: CircleX, text: problem, error: true };
  }
  return { Icon: CircleCheck, text: engine ? "Claude ready" : "Connected", error: false };
}

const themes = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: SunMoon },
] as const;

function ThemeSwitch() {
  const [theme, setTheme] = useState(readTheme);
  function choose(next: Theme) {
    saveTheme(next);
    setTheme(next);
  }
  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex gap-0.5 self-start rounded-field bg-raised p-0.5"
    >
      {themes.map(({ value, label, Icon }) => (
        <Tooltip key={value} label={label}>
          <button
            type="button"
            aria-label={label}
            aria-pressed={theme === value}
            className="flex size-6 items-center justify-center rounded-xs border border-transparent text-ink-secondary transition-colors hover:text-ink aria-pressed:border-edge-subtle aria-pressed:bg-card aria-pressed:text-ink"
            onClick={() => choose(value)}
          >
            <Icon {...iconProps} />
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

function UpdateLine() {
  const update = useDesktopUpdate();
  if (update?.status === "downloading") {
    return (
      <p className="flex items-center gap-2 text-caption text-ink-secondary">
        <Download {...iconProps} size={12} className="shrink-0" />
        Downloading update · {Math.round(update.percent)}%
      </p>
    );
  }
  if (update?.status === "ready") {
    return (
      <button
        type="button"
        className="flex items-center gap-2 self-start rounded-xs text-caption text-ink-secondary transition-colors hover:text-ink"
        onClick={() => void window.beeDesktop?.updates?.install()}
      >
        <RefreshCw {...iconProps} size={12} className="shrink-0 text-brand-icon" />
        Update ready · Restart
      </button>
    );
  }
  return null;
}

function PlanMeter({ connection, onUsage }: { connection: ConnectionState; onUsage: () => void }) {
  const week = connection.chat.usageLimits
    .find(({ accountId }) => accountId === "claude")
    ?.windows.find(({ kind }) => kind === "weekly");
  const remaining = week && remainingPercent(week);
  if (remaining === undefined || remaining === null) {
    return null;
  }
  const used = 100 - remaining;
  const atLimit = used === 100;
  return (
    <button
      type="button"
      className={`flex w-full flex-col gap-1 rounded-xs text-left text-caption ${atLimit ? "text-danger" : "text-ink-secondary"}`}
      onClick={onUsage}
    >
      {atLimit ? "Plan · limit reached this week" : `Plan · ${used}% of this week`}
      <span className="h-1 w-full overflow-hidden rounded-full bg-raised">
        <span
          className={`block h-full rounded-full forced-colors:bg-[CanvasText] ${atLimit ? "bg-danger-status" : "bg-brand-fill"}`}
          style={{ width: `${used}%` }}
        />
      </span>
    </button>
  );
}

export function SidebarFooter({
  connection,
  onUsage,
}: {
  connection: ConnectionState;
  onUsage: () => void;
}) {
  const status = statusLine(connection);
  return (
    <div className="flex shrink-0 flex-col gap-3 border-t border-edge-subtle px-2 pt-3">
      <p
        role="status"
        data-status={connection.status}
        className={`flex items-center gap-2 text-caption ${status.error ? "text-danger" : "text-ink-secondary"}`}
      >
        <status.Icon
          {...iconProps}
          size={12}
          className={`shrink-0 ${
            status.error
              ? "text-danger-status"
              : status.Icon === LoaderCircle
                ? "motion-safe:animate-spin"
                : "text-success-status"
          }`}
        />
        {status.text}
      </p>
      <UpdateLine />
      <PlanMeter connection={connection} onUsage={onUsage} />
      <label className="flex cursor-pointer items-center justify-between gap-2 text-caption text-ink-secondary">
        Share usage data
        <input
          type="checkbox"
          role="switch"
          className="relative h-[18px] w-8 shrink-0 cursor-pointer appearance-none rounded-full bg-edge-strong transition-colors before:absolute before:top-0.5 before:left-0.5 before:size-3.5 before:rounded-full before:bg-card before:transition-transform checked:bg-brand-fill checked:before:translate-x-3.5"
          checked={connection.chat.usageData === true}
          onChange={(event) =>
            void sendCommand({ type: "set-usage-data", on: event.target.checked })
          }
        />
      </label>
      <ThemeSwitch />
    </div>
  );
}
