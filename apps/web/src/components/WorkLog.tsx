import {
  BookMarked,
  ChevronDown,
  ChevronRight,
  CircleX,
  Eye,
  LoaderCircle,
  type LucideIcon,
  MessageCircle,
  Search,
  SquarePen,
  Terminal,
  Wrench,
} from "lucide-react";
import type { Connector } from "@beebot/contracts";
import { createElement, type ReactNode, useState } from "react";

import { liveThoughtLine, toolRowLabel, visibleDetail } from "../labels";
import type { LiveTool } from "../serverConnection";
import { tickElapsed } from "../tick";
import { observeVisibleAnimation } from "../visibleAnimation";
import { iconProps } from "./ui";

const toolIcons = new Map<string, LucideIcon>([
  ["Bash", Terminal],
  ["Read", Eye],
  ["Write", SquarePen],
  ["Edit", SquarePen],
  ["Patch", SquarePen],
  ["Glob", Search],
  ["Grep", Search],
]);

const toolIcon = (name: string) =>
  toolIcons.get(name) ?? (name.startsWith("mcp__bee__memory") ? BookMarked : Wrench);

function Elapsed({ startedAt }: { startedAt: string }) {
  return (
    <span ref={tickElapsed(startedAt)} role="timer" aria-live="off" className="tabular-nums" />
  );
}

function ToolRow({
  tool,
  live,
  connectors,
}: {
  tool: LiveTool;
  live: boolean;
  connectors: readonly Connector[];
}) {
  const running = live && tool.status === "running";
  const failed = tool.status === "failed";
  const icon = running ? LoaderCircle : failed ? CircleX : toolIcon(tool.name);
  return (
    <li
      ref={running ? observeVisibleAnimation : undefined}
      className="flex min-h-[30px] min-w-0 items-center gap-2 text-body-s"
    >
      {createElement(icon, {
        ...iconProps,
        className: `shrink-0 ${
          running
            ? "text-success-status motion-safe:animate-spin"
            : failed
              ? "text-danger-status"
              : "text-ink-secondary"
        }`,
      })}
      <span className={`min-w-0 truncate ${running ? "live-tool-shine" : ""}`}>
        {visibleDetail(toolRowLabel(tool, connectors))}
      </span>
      {failed && <span className="sr-only">Failed</span>}
    </li>
  );
}

// The live label is a clock, so it takes a node, and a turn with no tools yet has nothing to fold.
export function WorkGroup({
  label,
  tools,
  live = false,
  connectors = [],
}: {
  label: ReactNode;
  tools: LiveTool[];
  live?: boolean;
  // Names a connector tool by its app.
  connectors?: readonly Connector[];
}) {
  const [open, setOpen] = useState(live);
  const failures = tools.filter(({ status }) => status === "failed").length;
  const Toggle = live ? LoaderCircle : open ? ChevronDown : ChevronRight;
  return (
    <section aria-label="Activity" className="flex min-w-0 flex-col">
      {tools.length === 0 ? (
        <p className="flex min-h-7 items-center gap-2 text-body-s text-ink-secondary">
          {live && (
            <LoaderCircle
              {...iconProps}
              className="shrink-0 text-success-status motion-safe:animate-spin"
            />
          )}
          {label}
        </p>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          className="flex min-h-7 w-fit max-w-full items-center gap-2 rounded-field text-left text-body-s text-ink-secondary transition-colors hover:text-ink"
          onClick={() => setOpen(!open)}
        >
          <Toggle
            {...iconProps}
            className={`shrink-0 ${live ? "text-success-status motion-safe:animate-spin" : ""}`}
          />
          <span className="truncate">
            {label}
            {failures > 0 && <span className="text-danger"> · {failures} failed</span>}
          </span>
        </button>
      )}
      {open && tools.length > 0 && (
        <ul className="flex max-h-72 min-w-0 flex-col overflow-y-auto pl-6">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} live={live} connectors={connectors} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function WorkingLabel({ startedAt }: { startedAt: string }) {
  return (
    <>
      Working for <Elapsed startedAt={startedAt} />
    </>
  );
}

function ThinkingLine() {
  return (
    <span className="flex min-h-7 items-center gap-2 text-body-s">
      <MessageCircle {...iconProps} className="shrink-0" />
      Thinking
    </span>
  );
}

// Text only when the engine sent some. On the CLI's default display there never is any.
export function ThinkingRow({ text }: { text: string }) {
  const line = liveThoughtLine(text);
  if (line) {
    return (
      <p className="flex items-start gap-2 py-1 text-body-s text-ink-secondary">
        <MessageCircle {...iconProps} className="mt-0.5 shrink-0" />
        <span className="line-clamp-4 min-w-0 wrap-anywhere">{visibleDetail(line)}</span>
      </p>
    );
  }
  return (
    <div
      ref={observeVisibleAnimation}
      className="relative w-fit max-w-full overflow-hidden text-ink-secondary"
    >
      <ThinkingLine />
      <span aria-hidden className="live-activity-focus pointer-events-none absolute inset-y-0">
        <span className="live-activity-focus-counter block">
          <span className="live-activity-focus-aligned block text-ink">
            <ThinkingLine />
          </span>
        </span>
      </span>
    </div>
  );
}
