import type { AuditEntry, AuditInitiator, AuditPage as Page, Bot } from "@beebot/contracts";
import {
  ChevronDown,
  Circle,
  CircleCheck,
  CircleX,
  Clock,
  EyeOff,
  Hand,
  Link,
  type LucideIcon,
  PanelLeft,
  Pencil,
  RefreshCw,
} from "lucide-react";
import { createElement, useEffect, useState } from "react";

import { type ConnectionState, fetchAudit } from "../serverConnection";
import { Avatar } from "./Avatar";
import { iconProps } from "./ui";

const initiatorLabels: Record<AuditInitiator, string> = {
  human: "You",
  routine: "Routine",
  bot: "Another bot",
  system: "Bee Bot",
};

const statusLabels: Record<string, string> = {
  allow: "Allowed",
  deny: "Refused",
  approve: "Needs approval",
  hand_off: "Owner only",
  profile_set: "Profile set",
  boundary_set: "Box changed",
  control_set: "Computer control changed",
};

const statusIcons: Record<string, { icon: LucideIcon; className: string }> = {
  allow: { icon: CircleCheck, className: "text-success-status" },
  deny: { icon: CircleX, className: "text-danger-status" },
  approve: { icon: Clock, className: "text-waiting-status" },
  hand_off: { icon: Hand, className: "text-ink-secondary" },
};

function StatusIcon({ status }: { status: string }) {
  const { icon, className } =
    statusIcons[status] ??
    (status.endsWith("_set")
      ? { icon: Pencil, className: "text-ink-secondary" }
      : { icon: Circle, className: "text-icon-muted" });
  return createElement(icon, { ...iconProps, className: `shrink-0 ${className}` });
}

const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function AuditScope() {
  return (
    <details className="group text-body-s">
      <summary className="button button-sm w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        What this log records
        <ChevronDown {...iconProps} className="transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 flex flex-col gap-2 rounded-card bg-sidebar p-4 text-ink-secondary">
        <p>
          Recorded: each run starting and ending, each approval, and every call a bot makes through
          Bee Bot's tools (messages, delegation, memory, routines, the browser) with what Bee Bot's
          policy decided. A call's input is kept only as a fingerprint.
        </p>
        <p>
          Not recorded: what the engine does with its own shell and file tools unless it asks
          permission first, the engine's own network traffic, what bots write in their replies,
          credentials, and anything you type while you control a bot's browser.
        </p>
        <p>
          Each row carries a hash of the one before it, so a row changed or removed in the middle
          shows below. Removing the newest rows does not show.
        </p>
      </div>
    </details>
  );
}

function Row({ entry, bot }: { entry: AuditEntry; bot: (id: string | null) => Bot | undefined }) {
  const found = bot(entry.botId);
  const name = entry.botId === null ? "Bee Bot" : (found?.name ?? "Removed bot");
  return (
    <li className="flex items-start gap-3 border-b border-edge-subtle py-3">
      <span className="mt-0.5">
        <StatusIcon status={entry.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2 text-body-s">
          {found && <Avatar seed={found.avatarSeed} className="size-5" />}
          <span className="shrink-0 font-medium">{name}</span>
          <span className="truncate">
            · {statusLabels[entry.status] ?? entry.status}
            {entry.tool && <span className="text-ink-secondary"> · {entry.tool}</span>}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-1 text-caption text-ink-secondary">
          {[
            entry.initiator && `Started by ${initiatorLabels[entry.initiator]}`,
            entry.attended === true && "Watched",
          ]
            .filter(Boolean)
            .join(" · ")}
          {entry.attended === false && (
            <span className="inline-flex items-center gap-1">
              {entry.initiator && "· "}
              <EyeOff {...iconProps} size={12} />
              Nobody watching
            </span>
          )}
          {entry.reason && <span className="w-full wrap-anywhere">{entry.reason}</span>}
        </span>
      </span>
      <time
        className="shrink-0 text-right text-caption text-ink-secondary tabular-nums"
        dateTime={entry.createdAt}
      >
        {time.format(new Date(entry.createdAt))}
      </time>
    </li>
  );
}

export function AuditPage({
  connection,
  onOpenDrawer,
}: {
  connection: ConnectionState;
  onOpenDrawer: () => void;
}) {
  const { bots } = connection.chat;
  const [botId, setBotId] = useState("");
  const [unattended, setUnattended] = useState(false);
  const [revision, setRevision] = useState(0);
  const key = `${botId}:${unattended}:${revision}`;
  const [loaded, setLoaded] = useState<{ key: string; page: Page | undefined }>();
  const loading = loaded?.key !== key;
  const page = loaded?.page;

  useEffect(() => {
    let current = true;
    void fetchAudit({ botId, unattended }).then((next) => {
      if (current) {
        setLoaded({ key, page: next });
      }
    });
    return () => {
      current = false;
    };
  }, [botId, unattended, key]);

  const bot = (id: string | null) => bots.find((candidate) => candidate.id === id);

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Audit">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge-subtle px-3 md:px-6">
        <button
          type="button"
          aria-label="Open bot list"
          className="button button-icon md:hidden"
          onClick={onOpenDrawer}
        >
          <PanelLeft {...iconProps} />
        </button>
        <h2 className="text-title-s font-semibold">Audit</h2>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Refresh"
          className="button button-icon"
          disabled={loading}
          onClick={() => setRevision(revision + 1)}
        >
          <RefreshCw {...iconProps} className={loading ? "animate-spin" : undefined} />
        </button>
      </header>
      <div className="scroller min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[840px] flex-col gap-4 px-4 pt-6 pb-10">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex w-full flex-col gap-2 sm:w-56">
              <span className="field-label">Bot</span>
              <select
                className="field text-ink"
                value={botId}
                onChange={(event) => setBotId(event.target.value)}
              >
                <option value="">All bots</option>
                {bots.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex h-9 items-center gap-2 text-body-s">
              <input
                type="checkbox"
                className="size-4 accent-brand-fill"
                checked={unattended}
                onChange={(event) => setUnattended(event.target.checked)}
              />
              Only when nobody was watching
            </label>
          </div>
          {page && page.brokenRowId !== null && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-card border border-danger-edge bg-danger-surface px-3 py-3 text-body-s"
            >
              <CircleX {...iconProps} className="mt-0.5 shrink-0 text-danger-status" />
              <span>
                <span className="font-medium text-danger">Chain broken</span> Row {page.brokenRowId}{" "}
                doesn't follow from the row before it: the log was changed outside Bee Bot from
                there on.
              </span>
            </p>
          )}
          {page && page.brokenRowId === null && (
            <p className="flex items-center gap-2 rounded-card border border-edge-subtle bg-sidebar px-3 py-3 text-body-s">
              <Link {...iconProps} className="shrink-0 text-ink-secondary" />
              <span>
                <span className="font-medium">Chain intact</span> No record has been changed.
              </span>
            </p>
          )}
          <AuditScope />
          {loading && !page && (
            <div role="status" aria-label="Loading the log" className="flex flex-col">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="flex gap-3 border-b border-edge-subtle py-3">
                  <div className="size-4 animate-pulse rounded-full bg-raised" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <div className="h-4 w-2/3 animate-pulse rounded-xs bg-raised" />
                    <div className="h-3 w-1/3 animate-pulse rounded-xs bg-raised" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {!loading && !page && (
            <p className="py-10 text-center text-body-s text-ink-secondary">
              The audit log couldn't be loaded.
            </p>
          )}
          {page && page.entries.length === 0 && (
            <p className="py-10 text-center text-body-s text-ink-secondary">
              Nothing recorded here yet.
            </p>
          )}
          {page && page.entries.length > 0 && (
            <ul aria-busy={loading} className={loading ? "opacity-60" : undefined}>
              {page.entries.map((entry) => (
                <Row key={entry.id} entry={entry} bot={bot} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
