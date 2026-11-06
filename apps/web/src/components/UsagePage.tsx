import type {
  UsageLimits,
  UsageRow,
  UsageSummary,
  UsageTokens,
  UsageWindow,
} from "@beebot/contracts";
import {
  Gauge,
  type LucideIcon,
  PanelLeft,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { createElement, Fragment, useEffect, useState } from "react";

import {
  cacheHitRate,
  formatCount,
  formatPercent,
  formatTokens,
  formatUsd,
  limitsNotice,
  seriesLabel,
  totalTokens,
  usageRowValue,
} from "../labels";
import { type ConnectionState, fetchUsage, refreshLimits } from "../serverConnection";
import {
  formatResetsIn,
  type LimitPace,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
} from "../usageLimits";
import { iconProps } from "./ui";

type Metric = "tokens" | "cost";
type View = "limits" | "usage";

const periods = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const paceLabels: Record<LimitPace, { label: string; icon: LucideIcon }> = {
  ahead: { label: "Ahead of pace: spending faster than the window elapses", icon: TrendingUp },
  on: { label: "On pace with the window", icon: Gauge },
  under: { label: "Under pace: headroom left for the rest of the window", icon: TrendingDown },
};

const inkMix = (percent: number) =>
  `color-mix(in oklab, var(--color-ink) ${percent}%, var(--color-background))`;

function Toggle<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex rounded-row bg-raised p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className="rounded-field px-2.5 py-1 text-label font-medium text-ink-secondary transition-colors hover:text-ink aria-pressed:bg-card aria-pressed:text-ink aria-pressed:shadow-composer forced-colors:aria-pressed:outline-2"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function PaceIcon({ pace }: { pace: LimitPace }) {
  const { label, icon } = paceLabels[pace];
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex text-ink-secondary">
      {createElement(icon, { ...iconProps, size: 14 })}
    </span>
  );
}

function WindowBar({ window, now }: { window: UsageWindow; now: number }) {
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsIn = formatResetsIn(window, now);
  if (remaining === null) {
    return <span className="text-label text-ink-faint">Not reported yet</span>;
  }
  const summary = `${window.label}: ${remaining}% left, ${window.usedPercent}% used${
    timeLeft === null ? "" : `, ${timeLeft}% of the window left`
  }${resetsIn ? `, ${resetsIn}` : ""}`;
  return (
    <div role="img" aria-label={summary} title={summary} className="relative h-6">
      <div className="absolute inset-x-0 inset-y-1.5 rounded-full bg-raised" />
      {remaining > 0 && (
        <div
          className="absolute inset-y-1.5 left-0 rounded-full bg-honey-fill forced-colors:bg-[CanvasText]"
          style={{ width: `${remaining}%` }}
        />
      )}
      {timeLeft !== null && (
        <span
          aria-hidden
          className="absolute inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-ink"
          style={{ left: `clamp(3px, ${timeLeft}%, calc(100% - 3px))` }}
        />
      )}
    </div>
  );
}

export function LimitWindows({ windows, now }: { windows: UsageWindow[]; now: number }) {
  return (
    <div className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] items-center gap-x-4 gap-y-1 sm:grid-cols-[11rem_minmax(0,1fr)_8rem]">
      {windows.map((window) => {
        const pace = paceOf(window, now);
        const remaining = remainingPercent(window);
        return (
          <Fragment key={window.id}>
            <span className="flex min-w-0 items-center gap-2 text-label">
              <span className="truncate text-ink-secondary">{window.label}</span>
              {remaining !== null && (
                <span className="ms-auto shrink-0 font-medium tabular-nums">{remaining}% left</span>
              )}
            </span>
            <WindowBar window={window} now={now} />
            <span className="col-span-2 flex items-center gap-2 text-label whitespace-nowrap text-ink-secondary tabular-nums sm:col-span-1">
              {pace && <PaceIcon pace={pace} />}
              <span className="ms-auto">{formatResetsIn(window, now) ?? ""}</span>
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

function LimitsView({
  limits,
  now,
  refreshing,
}: {
  limits: UsageLimits | undefined;
  now: number;
  refreshing: boolean;
}) {
  const notice = limits ? limitsNotice(limits) : undefined;
  return (
    <section aria-label="Limits" className="flex flex-col gap-4">
      {!limits && refreshing && <LimitSkeleton />}
      {!limits && !refreshing && (
        <p className="text-small text-ink-secondary">Limits haven't been checked yet.</p>
      )}
      {notice && <p className="text-small text-ink-secondary">{notice}</p>}
      {limits && !notice && <LimitWindows windows={limits.windows} now={now} />}
      <p className="text-label text-ink-faint">
        {limits?.checkedAt
          ? `Last checked ${new Date(limits.checkedAt).toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
            })}.`
          : "Not checked yet."}{" "}
        Your Claude Code reports these. Bee Bot checks when you open this page, when you refresh and
        after a turn, at most once a minute.
      </p>
    </section>
  );
}

const skeletonBar = "animate-pulse rounded-field bg-raised";

function LimitSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <div className={`h-3 w-full ${skeletonBar}`} />
      <div className={`h-3 w-full ${skeletonBar}`} />
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div role="status" aria-label="Reading transcripts" className="flex flex-col gap-6">
      <div className={`h-9 w-40 ${skeletonBar}`} />
      <div className={`h-2 w-full ${skeletonBar}`} />
      <div className={`h-40 w-full ${skeletonBar}`} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-label text-ink-secondary">{label}</span>
      <span className="text-title font-medium tabular-nums">{value}</span>
    </div>
  );
}

function ShareBar({ tokens }: { tokens: UsageTokens }) {
  const segments = [
    { label: "Input", value: tokens.input, color: inkMix(60) },
    { label: "Cache read", value: tokens.cacheRead, color: inkMix(30) },
    { label: "Cache write", value: tokens.cacheWrite, color: inkMix(76) },
    { label: "Output", value: tokens.output, color: inkMix(100) },
  ].filter(({ value }) => value > 0);
  const total = segments.reduce((sum, { value }) => sum + value, 0);
  if (total <= 0) {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <h3 className="text-name font-medium">Token types</h3>
      <div
        role="img"
        aria-label={`Token types: ${segments
          .map(({ label, value }) => `${label} ${formatTokens(value)}`)
          .join(", ")}`}
        className="flex h-2 gap-0.5"
      >
        {segments.map(({ label, value, color }) => (
          <div
            key={label}
            title={`${label} · ${formatTokens(value)} · ${formatPercent(value / total)}`}
            className="h-full min-w-1 rounded-xs first:rounded-l-full last:rounded-r-full"
            style={{ flex: `${value} 1 0`, backgroundColor: color }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-label">
        {segments.map(({ label, value, color }) => (
          <span key={label} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-xs" style={{ backgroundColor: color }} />
            <span className="text-ink-secondary">{label}</span>
            <span className="tabular-nums">{formatTokens(value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function formatMetric(row: UsageRow, metric: Metric) {
  if (metric === "tokens") {
    return formatTokens(totalTokens(row));
  }
  return row.unpricedTokens > 0 && row.costUsd === 0 ? "No estimate" : formatUsd(row.costUsd);
}

type Series = Extract<UsageSummary, { status: "ok" }>["series"];

function UsageChart({ series, metric }: { series: Series; metric: Metric }) {
  const peak = Math.max(...series.map((row) => usageRowValue(row, metric)), 0);
  if (peak <= 0) {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-name font-medium">
        {metric === "tokens" ? "Tokens over time" : "API-equivalent estimate over time"}
      </h3>
      <div className="flex h-40 items-end gap-0.5 border-b border-edge">
        {series.map((row) => {
          const value = usageRowValue(row, metric);
          const label = `${seriesLabel(row.start)} · ${formatMetric(row, metric)}`;
          return (
            // The whole column is the hit target: a short bar would be hard to reach.
            <div
              key={row.start}
              title={label}
              className="flex h-full min-w-0 flex-1 items-end hover:bg-hover"
            >
              {value > 0 && (
                <div
                  className="w-full rounded-t-[4px] bg-honey-fill forced-colors:bg-[CanvasText]"
                  style={{ height: `${Math.max((value / peak) * 100, 1)}%` }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-label text-ink-faint tabular-nums">
        <span>{seriesLabel(series[0]?.start ?? "")}</span>
        <span>Peak {metric === "tokens" ? formatTokens(peak) : formatUsd(peak)}</span>
        <span>{seriesLabel(series.at(-1)?.start ?? "")}</span>
      </div>
    </div>
  );
}

function Breakdown({
  title,
  rows,
  metric,
  showCache = false,
}: {
  title: string;
  rows: Array<{ key: string; label: string; row: UsageRow }>;
  metric: Metric;
  showCache?: boolean;
}) {
  const peak = Math.max(...rows.map(({ row }) => usageRowValue(row, metric)), 0);
  if (rows.length === 0) {
    return null;
  }
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2">
      <h3 className="text-name font-medium">{title}</h3>
      <ul className="flex flex-col">
        {rows.map(({ key, label, row }) => {
          const rate = cacheHitRate(row);
          return (
            <li key={key} className="flex min-h-7 items-center gap-3 text-small">
              <span className="w-40 min-w-0 shrink-0 truncate" title={label}>
                {label}
              </span>
              <span aria-hidden className="h-1 min-w-0 flex-1 rounded-full bg-raised">
                {peak > 0 && (
                  <span
                    className="block h-full rounded-full bg-honey-fill forced-colors:bg-[CanvasText]"
                    style={{ width: `${(usageRowValue(row, metric) / peak) * 100}%` }}
                  />
                )}
              </span>
              {showCache && (
                <span className="w-24 shrink-0 text-right text-label text-ink-secondary tabular-nums">
                  {rate === null ? "" : `${formatPercent(rate, 0)} cached`}
                </span>
              )}
              <span className="w-20 shrink-0 text-right font-medium tabular-nums">
                {formatMetric(row, metric)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CoverageNotice({ summary }: { summary: Extract<UsageSummary, { status: "ok" }> }) {
  const { totals, unreadableFiles, skippedLines, oldestAt } = summary;
  const unpriced = totals.unpricedTokens / Math.max(totalTokens(totals), 1);
  return (
    <div className="flex flex-col gap-1 border-t border-edge pt-3 text-label text-ink-faint">
      <span>
        History covers this computer only. Claude Code deletes old transcripts, about 30 days by
        default
        {oldestAt
          ? `, and the oldest one here is from ${new Date(oldestAt).toLocaleDateString()}`
          : ""}
        .
      </span>
      <span>
        The API-equivalent estimate is what these tokens would cost at list prices. It is not what
        you pay on a subscription.
        {unpriced > 0 ? ` It leaves out ${formatPercent(unpriced)} of tokens with no price.` : ""}
      </span>
      {(unreadableFiles > 0 || skippedLines > 0) && (
        <span>
          Skipped {formatCount(skippedLines)} bad lines and {formatCount(unreadableFiles)}{" "}
          unreadable files.
        </span>
      )}
    </div>
  );
}

function HistoryView({
  summary,
  metric,
  botName,
}: {
  summary: Extract<UsageSummary, { status: "ok" }>;
  metric: Metric;
  botName: (botId: string | null) => string;
}) {
  const { totals } = summary;
  const byValue = (a: { row: UsageRow }, b: { row: UsageRow }) =>
    usageRowValue(b.row, metric) - usageRowValue(a.row, metric);
  const rate = cacheHitRate(totals);
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-[36px] leading-10 font-semibold tabular-nums">
            {metric === "tokens" ? formatTokens(totalTokens(totals)) : formatUsd(totals.costUsd)}
          </span>
          <span className="text-label text-ink-secondary">
            {formatCount(totals.sessions)} {totals.sessions === 1 ? "session" : "sessions"}
            {metric === "cost" && " · API-equivalent estimate"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Tokens" value={formatTokens(totalTokens(totals))} />
          <Stat label="API-equivalent estimate" value={formatUsd(totals.costUsd)} />
          <Stat label="Output" value={formatTokens(totals.output)} />
          <Stat label="Cache hit rate" value={rate === null ? "None" : formatPercent(rate, 0)} />
        </div>
      </section>
      <ShareBar tokens={totals} />
      <UsageChart series={summary.series} metric={metric} />
      <Breakdown
        title="By model"
        metric={metric}
        showCache
        rows={summary.models
          .map(({ model, ...row }) => ({ key: model, label: model, row }))
          .toSorted(byValue)}
      />
      <Breakdown
        title="By bot"
        metric={metric}
        rows={summary.bots
          .map(({ botId, ...row }) => ({ key: botId ?? "outside", label: botName(botId), row }))
          .toSorted(byValue)}
      />
      <Breakdown
        title="By time"
        metric={metric}
        rows={summary.series
          .filter((row) => totalTokens(row) > 0)
          .map(({ start, ...row }) => ({ key: start, label: seriesLabel(start), row }))
          .toReversed()}
      />
      <CoverageNotice summary={summary} />
    </div>
  );
}

export function UsagePage({
  connection,
  onOpenDrawer,
}: {
  connection: ConnectionState;
  onOpenDrawer: () => void;
}) {
  const { chat } = connection;
  const limits = chat.usageLimits.find(({ accountId }) => accountId === "claude");
  const [view, setView] = useState<View>("limits");
  const [days, setDays] = useState<number>(30);
  const [metric, setMetric] = useState<Metric>("tokens");
  const [history, setHistory] = useState<{ key: string; summary: UsageSummary }>();
  const [refreshing, setRefreshing] = useState(true);
  const [refreshNote, setRefreshNote] = useState<string>();
  const [now, setNow] = useState(() => Date.now());
  const [revision, setRevision] = useState(0);
  const historyKey = `${days}:${revision}`;
  const summary = history?.summary;
  const loading = history?.key !== historyKey;

  function refresh() {
    setRefreshing(true);
    void refreshLimits().then((note) => {
      setRefreshNote(note);
      setRefreshing(false);
      setNow(Date.now());
    });
  }

  // Opening the page is one of the three triggers for a limit check.
  useEffect(() => {
    void refreshLimits().then(() => {
      setRefreshing(false);
      setNow(Date.now());
    });
  }, []);

  useEffect(() => {
    let current = true;
    void fetchUsage(days).then((next) => {
      if (current) {
        setHistory({ key: historyKey, summary: next });
      }
    });
    return () => {
      current = false;
    };
  }, [days, historyKey]);

  const botName = (botId: string | null) =>
    botId === null
      ? "Outside Bee"
      : (chat.bots.find(({ id }) => id === botId)?.name ?? "Removed bot");
  const busy = view === "limits" ? refreshing : loading;

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Usage">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-edge px-3">
        <button
          type="button"
          aria-label="Open bot list"
          className="button !px-2 md:hidden"
          onClick={onOpenDrawer}
        >
          <PanelLeft {...iconProps} />
        </button>
        <h2 className="text-name font-medium">Usage</h2>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Refresh"
          className="button !px-2"
          disabled={busy}
          onClick={() => {
            setNow(Date.now());
            if (view === "limits") {
              refresh();
            } else {
              setRevision(revision + 1);
            }
          }}
        >
          <RefreshCw {...iconProps} className={busy ? "animate-spin" : undefined} />
        </button>
      </header>
      <div className="scroller min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-6 px-4 py-6">
          <div className="flex flex-wrap items-center gap-2">
            <Toggle
              label="View"
              value={view}
              options={[
                { value: "limits", label: "Limits" },
                { value: "usage", label: "Usage" },
              ]}
              onChange={setView}
            />
            {view === "usage" && (
              <>
                <span className="flex-1" />
                <Toggle
                  label="Period"
                  value={days}
                  options={periods.map(({ days: value, label }) => ({ value, label }))}
                  onChange={setDays}
                />
                <Toggle
                  label="Metric"
                  value={metric}
                  options={[
                    { value: "tokens", label: "Tokens" },
                    { value: "cost", label: "Estimate" },
                  ]}
                  onChange={setMetric}
                />
              </>
            )}
          </div>
          <p role="status" className="text-label text-ink-faint empty:hidden">
            {view === "limits" ? refreshNote : ""}
          </p>
          {view === "limits" && <LimitsView limits={limits} now={now} refreshing={refreshing} />}
          {view === "usage" && loading && !summary && <UsageSkeleton />}
          {view === "usage" && summary?.status === "unavailable" && (
            <p className="text-small text-ink-secondary">
              No Claude Code history was found on this computer.
            </p>
          )}
          {view === "usage" && summary?.status === "ok" && (
            <div aria-busy={loading} className={loading ? "opacity-60" : undefined}>
              <HistoryView summary={summary} metric={metric} botName={botName} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
