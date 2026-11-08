import type { AuditEntry, AuditInitiator, AuditPage as Page } from "@beebot/contracts";
import { PanelLeft, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { type ConnectionState, fetchAudit } from "../serverConnection";
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
};

const time = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function watchedLabel(attended: boolean | null) {
  if (attended === null) {
    return "";
  }
  return attended ? "Watched" : "Nobody watching";
}

function AuditScope() {
  return (
    <details className="rounded-row bg-raised px-3 py-2 text-small text-ink-secondary">
      <summary className="cursor-pointer text-ink">What this log records</summary>
      <div className="mt-2 flex flex-col gap-2">
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

function Row({ entry, botName }: { entry: AuditEntry; botName: (id: string | null) => string }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-edge py-2 text-small">
      <span className="truncate text-ink">
        {statusLabels[entry.status] ?? entry.status}
        {entry.tool && <span className="text-ink-secondary"> · {entry.tool}</span>}
        {entry.reason && <span className="text-ink-faint"> · {entry.reason}</span>}
      </span>
      <time className="text-label text-ink-faint" dateTime={entry.createdAt}>
        {time.format(new Date(entry.createdAt))}
      </time>
      <span className="truncate text-label text-ink-secondary">
        {[
          botName(entry.botId),
          entry.initiator && `started by ${initiatorLabels[entry.initiator]}`,
          watchedLabel(entry.attended),
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
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

  const botName = (id: string | null) =>
    id === null ? "Bee Bot" : (bots.find((bot) => bot.id === id)?.name ?? "Removed bot");

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Audit">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-edge px-3">
        <button
          type="button"
          aria-label="Open bot list"
          className="button !px-2 md:hidden"
          onClick={onOpenDrawer}
        >
          <PanelLeft {...iconProps} />
        </button>
        <h2 className="text-name font-medium">Audit</h2>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Refresh"
          className="button !px-2"
          disabled={loading}
          onClick={() => setRevision(revision + 1)}
        >
          <RefreshCw {...iconProps} className={loading ? "animate-spin" : undefined} />
        </button>
      </header>
      <div className="scroller min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-4 px-4 py-6">
          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label="Bot"
              className="field text-small text-ink"
              value={botId}
              onChange={(event) => setBotId(event.target.value)}
            >
              <option value="">All bots</option>
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-small text-ink-secondary">
              <input
                type="checkbox"
                checked={unattended}
                onChange={(event) => setUnattended(event.target.checked)}
              />
              Only when nobody was watching
            </label>
          </div>
          <AuditScope />
          {page && page.brokenRowId !== null && (
            <p role="alert" className="text-small text-ink">
              Row {page.brokenRowId} doesn't follow from the row before it: the log was changed
              outside Bee Bot from there on.
            </p>
          )}
          {page && page.brokenRowId === null && (
            <p className="text-label text-ink-faint">Chain intact.</p>
          )}
          {!loading && !page && (
            <p className="text-small text-ink-secondary">The audit log couldn't be loaded.</p>
          )}
          {page && page.entries.length === 0 && (
            <p className="text-small text-ink-secondary">Nothing recorded here yet.</p>
          )}
          {page && page.entries.length > 0 && (
            <ul aria-busy={loading} className={loading ? "opacity-60" : undefined}>
              {page.entries.map((entry) => (
                <Row key={entry.id} entry={entry} botName={botName} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
