import {
  BookMarked,
  Brain,
  ChevronRight,
  Eye,
  type LucideIcon,
  Search,
  SquarePen,
  Terminal,
  Wrench,
  X,
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
  return (
    <li
      ref={running ? observeVisibleAnimation : undefined}
      className={`flex min-h-6 w-fit max-w-full min-w-0 items-center gap-1.5 rounded-field px-1 text-small ${
        failed ? "bg-danger-surface text-danger" : "text-ink-secondary"
      }`}
    >
      {createElement(toolIcon(tool.name), { ...iconProps, className: "shrink-0 opacity-70" })}
      <span className={`min-w-0 truncate ${running ? "live-tool-shine" : ""}`}>
        {visibleDetail(toolRowLabel(tool, connectors))}
      </span>
      {failed && (
        <>
          <X {...iconProps} size={12} className="shrink-0" />
          <span className="sr-only">Failed</span>
        </>
      )}
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
  return (
    <section aria-label="Activity" className="-mx-1 flex min-w-0 flex-col gap-1">
      {tools.length === 0 ? (
        <p className="px-1 text-small leading-6 text-ink-secondary">{label}</p>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          className="group flex min-h-6 w-fit max-w-full items-center gap-1 rounded-field px-1 text-left text-small text-ink-secondary transition-colors hover:text-ink"
          onClick={() => setOpen(!open)}
        >
          <span className="truncate">{label}</span>
          {failures > 0 && (
            <span className="shrink-0 text-danger">
              {" · "}
              {failures} failed
            </span>
          )}
          <ChevronRight
            {...iconProps}
            size={14}
            className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          />
        </button>
      )}
      {open && tools.length > 0 && (
        <ul className="flex max-h-72 min-w-0 flex-col overflow-y-auto">
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
    <span className="flex min-h-6 items-center gap-1.5 px-1 text-small">
      <Brain {...iconProps} className="shrink-0" />
      Thinking
    </span>
  );
}

// Text only when the engine sent some. On the CLI's default display there never is any.
export function ThinkingRow({ text }: { text: string }) {
  const line = liveThoughtLine(text);
  if (line) {
    return (
      <p className="flex items-start gap-1.5 px-1 text-small text-ink-secondary">
        <Brain {...iconProps} className="mt-0.5 shrink-0 opacity-70" />
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
