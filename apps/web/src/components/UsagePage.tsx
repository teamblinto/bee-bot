import type {
  UsageLimits,
  UsageRow,
  UsageSummary,
  UsageTokens,
  UsageWindow,
} from "@beebot/contracts";
import { PanelLeft, RefreshCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

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
import { Avatar } from "./Avatar";
import { BoxesPanel } from "./BoxesPanel";
import { ConnectorsPanel } from "./ConnectorsPanel";
import { TeamPanel } from "./TeamPanel";
import { Tooltip } from "./Tooltip";
import { VaultPanel } from "./VaultPanel";

type Metric = "tokens" | "cost";
type View = "limits" | "usage" | "keys" | "team";

const periods = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

const views: ReadonlyArray<{ value: View; label: string }> = [
  { value: "limits", label: "Limits" },
  { value: "usage", label: "Usage" },
  { value: "keys", label: "Keys and boxes" },
  { value: "team", label: "Team" },
];

const paceLabels: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

const badgeClass =
  "inline-flex h-[22px] items-center rounded-xs bg-raised px-2 text-label font-medium text-ink";

function Tabs({ value, onChange }: { value: View; onChange: (value: View) => void }) {
  return (
    <div role="tablist" aria-label="View" className="flex gap-1 border-b border-edge-subtle">
      {views.map((view) => (
        <button
          key={view.value}
          type="button"
          role="tab"
          aria-selected={view.value === value}
          className="group flex h-9 flex-col rounded-xs text-body-s font-medium text-ink-secondary transition-colors hover:text-ink aria-selected:text-ink"
          onClick={() => onChange(view.value)}
        >
          <span className="flex flex-1 items-center px-3 whitespace-nowrap">{view.label}</span>
          <span className="h-0.5 w-full group-aria-selected:bg-brand-fill forced-colors:group-aria-selected:bg-[CanvasText]" />
        </button>
      ))}
    </div>
  );
}

function Segmented<T extends string | number>({
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
    <div role="group" aria-label={label} className="flex rounded-field bg-raised p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className="h-7 rounded-xs px-3 text-label whitespace-nowrap text-ink-secondary transition-colors hover:text-ink aria-pressed:bg-card aria-pressed:font-medium aria-pressed:text-ink aria-pressed:shadow-composer forced-colors:aria-pressed:outline-2"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const checkedTime = (at: string) =>
  new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function Meter({
  window,
  now,
  checkedAt,
}: {
  window: UsageWindow;
  now: number;
  checkedAt: string | null;
}) {
  const remaining = remainingPercent(window);
  const used = remaining === null ? null : 100 - remaining;
  const timeLeft = paceRemainingPercent(window, now);
  const pace = paceOf(window, now);
  const resetsIn = formatResetsIn(window, now);
  const atLimit = used === 100;
  const summary =
    remaining === null
      ? `${window.label}: not reported yet`
      : `${window.label}: ${remaining}% left, ${used}% used${
          timeLeft === null ? "" : `, ${timeLeft}% of the window left`
        }${resetsIn ? `, ${resetsIn}` : ""}`;
  const status =
    used === null ? "Not reported yet" : atLimit ? "Limit reached" : pace && paceLabels[pace];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2 text-body-s">
        <span className="min-w-0 flex-1 font-medium">{window.label}</span>
        <span className={`shrink-0 tabular-nums ${atLimit ? "text-danger" : ""}`}>
          {used === null ? "—" : `${used}%`}
        </span>
      </div>
      <div
        role="img"
        aria-label={summary}
        title={summary}
        className="relative h-2 rounded-full bg-raised"
      >
        {used !== null && used > 0 && (
          <div
            className={`absolute inset-y-0 left-0 rounded-full forced-colors:bg-[CanvasText] ${atLimit ? "bg-danger-status" : "bg-brand-fill"}`}
            style={{ width: `${used}%` }}
          />
        )}
        {used !== null && timeLeft !== null && (
          <span
            aria-hidden
            className="absolute top-1/2 h-3.5 w-[3.6px] -translate-x-1/2 -translate-y-1/2 bg-ink"
            style={{ left: `clamp(2px, ${100 - timeLeft}%, calc(100% - 2px))` }}
          />
        )}
      </div>
      <span
        className={`flex items-center gap-1 text-caption tabular-nums ${atLimit ? "text-danger" : "text-ink-secondary"}`}
      >
        {pace === "ahead" && !atLimit && <TriangleAlert {...iconProps} size={12} />}
        {[status, resetsIn].filter(Boolean).join(" · ")}
      </span>
      <span className="text-caption text-ink-secondary">
        From your Claude plan{checkedAt ? ` · checked ${checkedTime(checkedAt)}` : ""}
      </span>
    </div>
  );
}

export function LimitWindows({
  windows,
  now,
  checkedAt = null,
}: {
  windows: UsageWindow[];
  now: number;
  checkedAt?: string | null;
}) {
  return (
    <div className="flex flex-col gap-6">
      {windows.map((window) => (
        <Meter key={window.id} window={window} now={now} checkedAt={checkedAt} />
      ))}
    </div>
  );
}

function LimitsView({
  limits,
  now,
  refreshing,
  onCheck,
}: {
  limits: UsageLimits | undefined;
  now: number;
  refreshing: boolean;
  onCheck: () => void;
}) {
  const notice = limits ? limitsNotice(limits) : undefined;
  return (
    <section aria-label="Limits" className="flex flex-col gap-6">
      {!limits && refreshing && <LimitSkeleton />}
      {!limits && !refreshing && (
        <div className="flex flex-col gap-2">
          <div className="h-2 rounded-full bg-raised" />
          <span className="flex items-center gap-4 text-caption text-ink-secondary">
            Not checked yet
            <button type="button" className="button button-sm" onClick={onCheck}>
              Check now
            </button>
          </span>
        </div>
      )}
      {notice && <p className="text-body-s text-ink-secondary">{notice}</p>}
      {limits && !notice && (
        <LimitWindows windows={limits.windows} now={now} checkedAt={limits.checkedAt} />
      )}
      <p className="text-caption text-ink-secondary">
        Bee Bot checks when you open this page, when you refresh, and after a turn, at most once a
        minute.
      </p>
    </section>
  );
}

const skeletonBar = "animate-pulse rounded-field bg-raised";

function LimitSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      {[0, 1].map((key) => (
        <div key={key} className="flex flex-col gap-2">
          <div className={`h-5 w-40 ${skeletonBar}`} />
          <div className={`h-2 w-full ${skeletonBar}`} />
          <div className={`h-4 w-48 ${skeletonBar}`} />
        </div>
      ))}
    </div>
  );
}

function UsageSkeleton() {
  return (
    <div role="status" aria-label="Reading transcripts" className="flex flex-col gap-8">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[0, 1, 2, 3].map((key) => (
          <div key={key} className={`h-[72px] ${skeletonBar}`} />
        ))}
      </div>
      <div className={`h-32 w-full ${skeletonBar}`} />
      <div className={`h-48 w-full ${skeletonBar}`} />
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
  badge,
}: {
  label: string;
  value: string;
  detail: string;
  badge?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate text-caption text-ink-secondary">{label}</span>
      <span className="flex items-center gap-2 py-1">
        <span className="text-heading font-semibold tabular-nums">{value}</span>
        {badge && <span className={badgeClass}>{badge}</span>}
      </span>
      <span className="truncate text-caption text-ink-secondary">{detail}</span>
    </div>
  );
}

type Bar = { key: string; name: string; icon?: ReactNode; value: number; text: string };

function BarList({ title, bars }: { title: string; bars: Bar[] }) {
  const peak = Math.max(...bars.map(({ value }) => value), 0);
  if (bars.length === 0) {
    return null;
  }
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2">
      <h3 className="text-body-s font-medium">{title}</h3>
      <ul className="flex flex-col">
        {bars.map(({ key, name, icon, value, text }) => (
          <li key={key} className="flex h-10 items-center gap-4 text-body-s">
            <span className="flex w-36 min-w-0 shrink-0 items-center gap-2" title={name}>
              {icon}
              <span className="truncate">{name}</span>
            </span>
            <span aria-hidden className="h-2 min-w-0 flex-1">
              {peak > 0 && value > 0 && (
                <span
                  className="block h-full min-w-2 rounded-full bg-brand-fill forced-colors:bg-[CanvasText]"
                  style={{ width: `${(value / peak) * 100}%` }}
                />
              )}
            </span>
            <span className="shrink-0 text-right text-caption text-ink-secondary tabular-nums">
              {text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TokenTypes({ tokens }: { tokens: UsageTokens }) {
  const types = [
    { name: "Input", value: tokens.input },
    { name: "Cache read", value: tokens.cacheRead },
    { name: "Cache write", value: tokens.cacheWrite },
    { name: "Output", value: tokens.output },
  ].filter(({ value }) => value > 0);
  const total = types.reduce((sum, { value }) => sum + value, 0);
  if (total <= 0) {
    return null;
  }
  return (
    <BarList
      title="Token types"
      bars={types
        .map(({ name, value }) => ({
          key: name,
          name,
          value,
          text: `${formatTokens(value)} · ${formatPercent(value / total, 0)}`,
        }))
        .toSorted((a, b) => b.value - a.value)}
    />
  );
}

function formatMetric(row: UsageRow, metric: Metric) {
  if (metric === "tokens") {
    return formatTokens(totalTokens(row));
  }
  return row.unpricedTokens > 0 && row.costUsd === 0 ? "No estimate" : formatUsd(row.costUsd);
}

function breakdown(
  rows: Array<{
    key: string;
    name: string;
    icon?: ReactNode;
    row: UsageRow;
    extra?: string | undefined;
  }>,
  metric: Metric,
): Bar[] {
  const total = rows.reduce((sum, { row }) => sum + usageRowValue(row, metric), 0);
  return rows.map(({ row, extra, ...rest }) => {
    const value = usageRowValue(row, metric);
    return {
      ...rest,
      value,
      text: [
        extra,
        formatMetric(row, metric),
        total > 0 ? formatPercent(value / total, 0) : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

type Series = Extract<UsageSummary, { status: "ok" }>["series"];

function UsageChart({ series, metric }: { series: Series; metric: Metric }) {
  const peak = Math.max(...series.map((row) => usageRowValue(row, metric)), 0);
  if (peak <= 0) {
    return null;
  }
  const format = metric === "tokens" ? formatTokens : formatUsd;
  const labelEach = series.length <= 14;
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h3 className="text-body-s font-medium">
        {metric === "tokens" ? "Tokens over time" : "API-equivalent estimate over time"}
      </h3>
      <div className="flex flex-col gap-2 pl-12">
        <div className="relative flex h-48 items-end gap-1 border-b border-edge">
          {[0, 50].map((top) => (
            <span
              key={top}
              aria-hidden
              className="absolute inset-x-0 border-t border-edge-subtle"
              style={{ top: `${top}%` }}
            />
          ))}
          {[
            { top: 0, value: peak },
            { top: 50, value: peak / 2 },
            { top: 100, value: 0 },
          ].map(({ top, value }) => (
            <span
              key={top}
              aria-hidden
              className="absolute -left-12 -translate-y-1/2 text-caption text-ink-secondary tabular-nums"
              style={{ top: `${top}%` }}
            >
              {value === 0 ? "0" : format(value)}
            </span>
          ))}
          {series.map((row) => {
            const value = usageRowValue(row, metric);
            return (
              // The whole column is the hit target: a short bar would be hard to reach.
              <Tooltip
                key={row.start}
                label={`${seriesLabel(row.start)} · ${formatMetric(row, metric)}`}
                className="relative flex h-full min-w-0 flex-1 items-end justify-center rounded-t-xs hover:bg-hover"
              >
                {value > 0 && (
                  <span
                    className="w-full max-w-10 rounded-t-xs bg-brand-fill forced-colors:bg-[CanvasText]"
                    style={{ height: `${Math.max((value / peak) * 100, 1)}%` }}
                  />
                )}
              </Tooltip>
            );
          })}
        </div>
        <div className="flex gap-1 text-caption text-ink-secondary tabular-nums">
          {labelEach ? (
            series.map((row) => (
              <span key={row.start} className="min-w-0 flex-1 truncate text-center">
                {seriesLabel(row.start)}
              </span>
            ))
          ) : (
            <>
              <span>{seriesLabel(series[0]?.start ?? "")}</span>
              <span className="flex-1" />
              <span>{seriesLabel(series.at(-1)?.start ?? "")}</span>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function CoverageNotice({ summary }: { summary: Extract<UsageSummary, { status: "ok" }> }) {
  const { totals, unreadableFiles, skippedLines, oldestAt } = summary;
  const unpriced = totals.unpricedTokens / Math.max(totalTokens(totals), 1);
  return (
    <div className="flex flex-col gap-1 border-t border-edge-subtle pt-4 text-caption text-ink-secondary">
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
  period,
  bot,
}: {
  summary: Extract<UsageSummary, { status: "ok" }>;
  metric: Metric;
  period: string;
  bot: (botId: string | null) => { name: string; avatarSeed?: number };
}) {
  const { totals } = summary;
  const byValue = (a: Bar, b: Bar) => b.value - a.value;
  const rate = cacheHitRate(totals);
  return (
    <div className="flex flex-col gap-8">
      <section aria-label="Totals" className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-4">
        <Stat
          label={`Tokens · ${period}`}
          value={formatTokens(totalTokens(totals))}
          detail={`${formatCount(totals.sessions)} ${totals.sessions === 1 ? "session" : "sessions"}`}
        />
        <Stat
          label={`Cost · ${period}`}
          value={formatUsd(totals.costUsd)}
          badge="Estimate"
          detail="API-equivalent estimate"
        />
        <Stat label="Output" value={formatTokens(totals.output)} detail="Tokens the bots wrote" />
        <Stat
          label="Cache hit rate"
          value={rate === null ? "None" : formatPercent(rate, 0)}
          detail="Read from cache, so cheaper"
        />
      </section>
      <TokenTypes tokens={totals} />
      <UsageChart series={summary.series} metric={metric} />
      <BarList
        title="By bot"
        bars={breakdown(
          summary.bots.map(({ botId, ...row }) => {
            const { name, avatarSeed } = bot(botId);
            return {
              key: botId ?? "outside",
              name,
              icon:
                avatarSeed === undefined ? undefined : (
                  <Avatar seed={avatarSeed} className="size-5" />
                ),
              row,
            };
          }),
          metric,
        ).toSorted(byValue)}
      />
      <BarList
        title="By model"
        bars={breakdown(
          summary.models.map(({ model, ...row }) => {
            const cached = cacheHitRate(row);
            return {
              key: model,
              name: model,
              row,
              extra: cached === null ? undefined : `${formatPercent(cached, 0)} cached`,
            };
          }),
          metric,
        ).toSorted(byValue)}
      />
      <BarList
        title="By time"
        bars={breakdown(
          summary.series
            .filter((row) => totalTokens(row) > 0)
            .map(({ start, ...row }) => ({ key: start, name: seriesLabel(start), row }))
            .toReversed(),
          metric,
        )}
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

  function bot(botId: string | null) {
    if (botId === null) {
      return { name: "Outside Bee Bot" };
    }
    const found = chat.bots.find(({ id }) => id === botId);
    return found ? { name: found.name, avatarSeed: found.avatarSeed } : { name: "Removed bot" };
  }
  const busy = view === "usage" ? loading : refreshing;

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Usage">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge-subtle px-3 md:px-6">
        <button
          type="button"
          aria-label="Open bot list"
          className="button button-icon md:hidden"
          onClick={onOpenDrawer}
        >
          <PanelLeft {...iconProps} />
        </button>
        <h2 className="text-title-s font-semibold">Usage</h2>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="Refresh"
          className="button button-icon"
          disabled={busy}
          onClick={() => {
            setNow(Date.now());
            if (view === "usage") {
              setRevision(revision + 1);
            } else {
              refresh();
            }
          }}
        >
          <RefreshCw {...iconProps} className={busy ? "animate-spin" : undefined} />
        </button>
      </header>
      <div className="scroller min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[calc(var(--container-transcript)+2rem)] flex-col gap-6 px-4 pt-6 pb-10">
          <Tabs value={view} onChange={setView} />
          {view === "usage" && (
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                label="Period"
                value={days}
                options={periods.map(({ days: value, label }) => ({ value, label }))}
                onChange={setDays}
              />
              <span className="flex-1" />
              <Segmented
                label="Metric"
                value={metric}
                options={[
                  { value: "tokens", label: "Tokens" },
                  { value: "cost", label: "Estimate" },
                ]}
                onChange={setMetric}
              />
            </div>
          )}
          <p role="status" className="text-caption text-ink-secondary empty:hidden">
            {view === "limits" ? refreshNote : ""}
          </p>
          {view === "limits" && (
            <LimitsView limits={limits} now={now} refreshing={refreshing} onCheck={refresh} />
          )}
          {view === "keys" && (
            <div className="flex flex-col gap-10">
              <VaultPanel chat={chat} />
              <BoxesPanel />
              <ConnectorsPanel chat={chat} />
            </div>
          )}
          {view === "team" && <TeamPanel chat={chat} />}
          {view === "usage" && loading && !summary && <UsageSkeleton />}
          {view === "usage" && summary?.status === "unavailable" && (
            <p className="py-10 text-center text-body-s text-ink-secondary">
              No Claude Code history was found on this computer.
            </p>
          )}
          {view === "usage" && summary?.status === "ok" && (
            <div aria-busy={loading} className={loading ? "opacity-60" : undefined}>
              <HistoryView
                summary={summary}
                metric={metric}
                period={days === 1 ? "past 24h" : `last ${days} days`}
                bot={bot}
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
