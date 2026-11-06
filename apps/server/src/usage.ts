import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { UsageRow, UsageSummary, UsageTokens, UsageWindow } from "@beebot/contracts";
import { z } from "zod";

import type { EventStore } from "./store.ts";

const hourMins = 60;
const sessionMins = 5 * hourMins;
const weekMins = 7 * 24 * hourMins;
const defaultRefreshGapMs = 60_000;

const namedWindows = new Map<string, Pick<UsageWindow, "kind" | "label" | "windowDurationMins">>([
  ["five_hour", { kind: "session", label: "Session", windowDurationMins: sessionMins }],
  ["seven_day", { kind: "weekly", label: "Weekly", windowDurationMins: weekMins }],
]);
const overageIncludedType = "seven_day_overage_included";

const clampPercent = (value: number) => Math.round(Math.min(100, Math.max(0, value)) * 100) / 100;

function isoOrNull(value: string | number | null | undefined) {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value ?? NaN);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const Money = z.object({ amount_minor: z.number(), currency: z.string(), exponent: z.number() });
const Window = z.object({ utilization: z.number().nullable(), resets_at: z.string().nullish() });

// An allowlist: zod drops everything not named, and a reply can name the owner's agents and plugins.
export const UsageReply = z.object({
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: Window.nullish(),
      seven_day: Window.nullish(),
      model_scoped: z.array(Window.extend({ display_name: z.string() })).nullish(),
      spend: z
        .object({ enabled: z.boolean(), used: Money.nullish(), limit: Money.nullish() })
        .nullish(),
      extra_usage: z
        .object({
          is_enabled: z.boolean(),
          monthly_limit: z.number().nullish(),
          used_credits: z.number().nullish(),
          utilization: z.number().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
type UsageReply = z.infer<typeof UsageReply>;

export type UsageProbe = Pick<import("@beebot/contracts").UsageLimits, "windows" | "unavailable">;

export const unavailableProbe = (
  reason: "unsupported" | "probeFailed",
  message: string | null = null,
): UsageProbe => ({ windows: [], unavailable: { reason, message } });

function namedWindow(id: string, usedPercent: number, resetsAt: string | null | undefined) {
  const named = namedWindows.get(id);
  return named
    ? {
        id,
        ...named,
        usedPercent: clampPercent(usedPercent),
        resetsAt: isoOrNull(resetsAt),
        status: null,
      }
    : undefined;
}

const scopedId = (name: string) => `seven_day_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

function percentOf(used: number | null | undefined, limit: number | null | undefined) {
  return typeof used === "number" && typeof limit === "number" && used >= 0 && limit > 0
    ? clampPercent((used / limit) * 100)
    : undefined;
}

function spendPercent(limits: NonNullable<UsageReply["rate_limits"]>) {
  const { spend, extra_usage: extra } = limits;
  const [used, limit] = [spend?.used, spend?.limit];
  // Minor units compare only at one currency and scale. `spend.percent` is rounded, so it isn't used.
  if (spend?.enabled && used?.currency === limit?.currency && used?.exponent === limit?.exponent) {
    const percent = percentOf(used?.amount_minor, limit?.amount_minor);
    if (percent !== undefined) {
      return percent;
    }
  }
  if (!extra?.is_enabled) {
    return undefined;
  }
  const percent = percentOf(extra.used_credits, extra.monthly_limit) ?? extra.utilization;
  return typeof percent === "number" ? clampPercent(percent) : undefined;
}

// `get_usage` percentages are already 0-100.
export function claudeUsageResponseToLimits(reply: UsageReply): UsageProbe {
  const limits = reply.rate_limits;
  if (!reply.rate_limits_available || !limits) {
    return unavailableProbe(reply.rate_limits_available ? "probeFailed" : "unsupported");
  }
  const windows: UsageWindow[] = [];
  for (const id of namedWindows.keys()) {
    const window = limits[id === "five_hour" ? "five_hour" : "seven_day"];
    const row =
      typeof window?.utilization === "number"
        ? namedWindow(id, window.utilization, window.resets_at)
        : undefined;
    if (row) {
      windows.push(row);
    }
  }
  for (const { display_name: name, utilization, resets_at: resetsAt } of limits.model_scoped ??
    []) {
    if (typeof utilization === "number") {
      windows.push({
        id: scopedId(name),
        kind: "weekly",
        label: `Weekly · ${name}`,
        windowDurationMins: weekMins,
        usedPercent: clampPercent(utilization),
        resetsAt: isoOrNull(resetsAt),
        status: null,
      });
    }
  }
  const spent = spendPercent(limits);
  if (spent !== undefined) {
    windows.push({
      id: "monthly_spend",
      kind: "monthly",
      label: "Monthly spend",
      windowDurationMins: null,
      usedPercent: spent,
      resetsAt: null,
      status: null,
    });
  }
  return { windows, unavailable: null };
}

export type WindowUpdate = {
  id: string;
  usedPercent: number | null;
  resetsAt: string | null;
  status: string | null;
};

const StreamWindow = z.object({
  utilization: z.number().nullish().catch(undefined),
  resetsAt: z.number().nullish().catch(undefined),
  status: z.string().nullish().catch(undefined),
});
const RateLimitInfo = StreamWindow.extend({
  rateLimitType: z.string().nullish().catch(undefined),
  unifiedWindows: z.record(z.string(), StreamWindow).nullish().catch(undefined),
});

// Stream utilization is 0-1. The top level often has none, and `unifiedWindows` then does.
export function claudeRateLimitEventToUpdate(info: unknown) {
  const parsed = RateLimitInfo.safeParse(info).data;
  if (!parsed) {
    return [];
  }
  const entries = [
    ...(parsed.rateLimitType ? [[parsed.rateLimitType, parsed] as const] : []),
    ...Object.entries(parsed.unifiedWindows ?? {}),
  ];
  const updates = new Map<string, WindowUpdate>();
  for (const [id, { utilization, resetsAt, status }] of entries) {
    const known = updates.get(id);
    updates.set(id, {
      id,
      usedPercent:
        typeof utilization === "number"
          ? clampPercent(utilization * 100)
          : (known?.usedPercent ?? null),
      resetsAt: isoOrNull(resetsAt) ?? known?.resetsAt ?? null,
      status: status ?? known?.status ?? null,
    });
  }
  return [...updates.values()];
}

// An update with no utilization keeps the known percentage and still moves status and reset time.
export function mergeWindows(current: UsageWindow[], updates: WindowUpdate[]) {
  const merged = [...current];
  for (const update of updates) {
    // The stream names this bucket by type, the probe by model: it lands on the model's row.
    const id =
      update.id === overageIncludedType
        ? current.find(({ id: known }) => known.startsWith("seven_day_"))?.id
        : update.id;
    const index = merged.findIndex((window) => window.id === id);
    const named = id ? namedWindows.get(id) : undefined;
    if (id && index >= 0) {
      const known = merged[index] as UsageWindow;
      merged[index] = {
        ...known,
        usedPercent: update.usedPercent ?? known.usedPercent,
        resetsAt: update.resetsAt ?? known.resetsAt,
        status: update.status ?? known.status,
      };
    } else if (id && named) {
      merged.push({ ...update, id, ...named });
    }
  }
  return merged;
}

type RefreshOptions = {
  store: Pick<EventStore, "accountRunning" | "saveUsage">;
  probe: (() => Promise<UsageProbe>) | undefined;
  onSettled: () => void;
  minGapMs?: number | undefined;
};

// Guards 3 and 4 of R29: never beside a turn on the account, at most once a minute, no polling.
export function createLimitRefresher({
  store,
  probe,
  onSettled,
  minGapMs = defaultRefreshGapMs,
}: RefreshOptions) {
  const lastStart = new Map<string, number>();
  const probing = new Set<string>();
  return {
    isProbing: (accountId: string) => probing.has(accountId),
    refresh: async (accountId: string) => {
      if (!probe || accountId !== "claude") {
        return "unavailable";
      }
      if (
        probing.has(accountId) ||
        Date.now() - (lastStart.get(accountId) ?? -Infinity) < minGapMs
      ) {
        return "throttled";
      }
      if (store.accountRunning(accountId)) {
        return "busy";
      }
      lastStart.set(accountId, Date.now());
      probing.add(accountId);
      try {
        store.saveUsage(accountId, await probe().catch(() => unavailableProbe("probeFailed")));
        return "refreshed";
      } finally {
        probing.delete(accountId);
        onSettled();
      }
    },
  };
}

// Current first-party list prices, per million tokens, as of 2026-10-06. Estimates only.
const rates = new Map<string, { input: number; output: number; cacheRead: number }>(
  (
    [
      ["claude-fable-5-1", 10, 50, 0.25],
      ["claude-fable-5", 10, 50, 1],
      ["claude-opus-5-5", 4, 20, 0.2],
      ["claude-opus-5", 5, 25, 0.5],
      ["claude-opus-4-8", 5, 25, 0.5],
      ["claude-opus-4-7", 5, 25, 0.5],
      ["claude-opus-4-6", 5, 25, 0.5],
      ["claude-sonnet-5-5", 2, 10, 0.2],
      ["claude-sonnet-5", 2, 10, 0.2],
      ["claude-sonnet-4-6", 3, 15, 0.3],
      ["claude-haiku-5-5", 0.1, 0.5, 0.01],
      ["claude-haiku-4-5", 1, 5, 0.1],
    ] as const
  ).map(([model, input, output, cacheRead]) => [model, { input, output, cacheRead }]),
);
const cacheWriteMultiple = 1.25;

// shortcut: every cache write is priced at the 5-minute rate and fast mode at the standard one, as
// the transcript fields kept here can't tell them apart. Keep more fields if estimates need it.
export function priceTokens(model: string, tokens: UsageTokens) {
  const key = model.replace(/\[.*$/, "").replace(/-\d{8}$/, "");
  const rate = rates.get(key);
  if (!rate) {
    return null;
  }
  const dollars =
    tokens.input * rate.input +
    tokens.cacheRead * rate.cacheRead +
    tokens.cacheWrite * rate.input * cacheWriteMultiple +
    tokens.output * rate.output;
  return dollars / 1_000_000;
}

export type UsageRecord = {
  timestampMs: number;
  model: string;
  sessionId: string;
  dedupeKey: string | null;
  tokens: UsageTokens;
};

const syntheticModel = "<synthetic>";
const tokenCount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const text = (value: unknown) => (typeof value === "string" ? value : "");

const record = (value: unknown) =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const tokensOf = (usage: Record<string, unknown>): UsageTokens => ({
  input: tokenCount(usage["input_tokens"]),
  cacheRead: tokenCount(usage["cache_read_input_tokens"]),
  cacheWrite: tokenCount(usage["cache_creation_input_tokens"]),
  output: tokenCount(usage["output_tokens"]),
});

// Reads only the named fields, so prompt and tool text never leaves this function.
export function parseTranscriptLine(line: string): UsageRecord[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  const entry = record(parsed);
  const message = record(entry?.["message"]);
  const usage = record(message?.["usage"]);
  const timestampMs = Date.parse(text(entry?.["timestamp"]));
  const model = text(message?.["model"]);
  if (
    entry?.["type"] !== "assistant" ||
    !usage ||
    Number.isNaN(timestampMs) ||
    !model ||
    model === syntheticModel
  ) {
    return [];
  }
  const [messageId, requestId] = [text(message?.["id"]), text(entry["requestId"])];
  const dedupeKey = messageId || requestId ? `${messageId}:${requestId}` : null;
  const sessionId = text(entry["sessionId"]);
  const records = [{ timestampMs, model, sessionId, dedupeKey, tokens: tokensOf(usage) }];
  // Top-level usage is the main model's alone. An advisor call runs on another model at its rates.
  const iterations = Array.isArray(usage["iterations"]) ? usage["iterations"] : [];
  for (const [index, raw] of iterations.entries()) {
    const advisor = record(raw);
    const advisorModel = text(advisor?.["model"]);
    if (
      advisor?.["type"] === "advisor_message" &&
      advisorModel &&
      advisorModel !== syntheticModel
    ) {
      records.push({
        timestampMs,
        model: advisorModel,
        sessionId,
        dedupeKey: dedupeKey && `${dedupeKey}:advisor:${index}`,
        tokens: tokensOf(advisor as Record<string, unknown>),
      });
    }
  }
  return records;
}

type ScannedFile = { records: UsageRecord[]; skipped: number };

async function scanFile(path: string): Promise<ScannedFile> {
  const records: UsageRecord[] = [];
  let skipped = 0;
  const stream = NodeFS.createReadStream(path, { encoding: "utf8" });
  for await (const line of NodeReadline.createInterface({ input: stream, crlfDelay: Infinity })) {
    if (line.includes('"usage"')) {
      const parsed = parseTranscriptLine(line);
      if (parsed) {
        records.push(...parsed);
      } else {
        skipped += 1;
      }
    }
  }
  return { records, skipped };
}

const emptyTokens = (): UsageTokens => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const emptyRow = (): UsageRow => ({ ...emptyTokens(), costUsd: 0, unpricedTokens: 0 });

function addTo(row: UsageRow, { tokens, model }: Pick<UsageRecord, "tokens" | "model">) {
  row.input += tokens.input;
  row.cacheRead += tokens.cacheRead;
  row.cacheWrite += tokens.cacheWrite;
  row.output += tokens.output;
  const cost = priceTokens(model, tokens);
  if (cost === null) {
    row.unpricedTokens += tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
  } else {
    row.costUsd += cost;
  }
}

const dayKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const hourMs = 3_600_000;

// Local days: the server and its one owner share a computer, so its clock is the owner's.
function timeBuckets(days: number, nowMs: number) {
  if (days === 1) {
    const end = Math.floor(nowMs / hourMs) * hourMs;
    const starts = Array.from({ length: 24 }, (_, i) => end - (23 - i) * hourMs);
    return {
      sinceMs: starts[0] as number,
      keys: starts.map((start) => new Date(start).toISOString()),
      keyOf: (ms: number) => new Date(Math.floor(ms / hourMs) * hourMs).toISOString(),
    };
  }
  const first = new Date(nowMs);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - (days - 1));
  const keys = Array.from({ length: days }, (_, i) => {
    const day = new Date(first);
    day.setDate(first.getDate() + i);
    return dayKey(day);
  });
  return { sinceMs: first.getTime(), keys, keyOf: (ms: number) => dayKey(new Date(ms)) };
}

type Source = { records: UsageRecord[]; botId: string | null };

export function aggregateUsage(sources: Source[], days: number, nowMs: number) {
  const { sinceMs, keys, keyOf } = timeBuckets(days, nowMs);
  const seen = new Set<string>();
  const sessions = new Set<string>();
  const totals = emptyRow();
  const models = new Map<string, UsageRow>();
  const bots = new Map<string | null, UsageRow>();
  const series = new Map(keys.map((key) => [key, emptyRow()]));
  let duplicatesDropped = 0;
  let oldestMs = Infinity;

  for (const { records, botId } of sources) {
    for (const entry of records) {
      if (entry.dedupeKey !== null) {
        if (seen.has(entry.dedupeKey)) {
          duplicatesDropped += 1;
          continue;
        }
        seen.add(entry.dedupeKey);
      }
      oldestMs = Math.min(oldestMs, entry.timestampMs);
      const bucket = series.get(keyOf(entry.timestampMs));
      if (entry.timestampMs < sinceMs || entry.timestampMs > nowMs || !bucket) {
        continue;
      }
      const modelRow = models.get(entry.model) ?? emptyRow();
      const botRow = bots.get(botId) ?? emptyRow();
      models.set(entry.model, modelRow);
      bots.set(botId, botRow);
      for (const row of [totals, modelRow, botRow, bucket]) {
        addTo(row, entry);
      }
      if (entry.sessionId) {
        sessions.add(entry.sessionId);
      }
    }
  }
  return {
    totals: { ...totals, sessions: sessions.size },
    models: [...models].map(([model, row]) => ({ model, ...row })),
    bots: [...bots].map(([botId, row]) => ({ botId, ...row })),
    series: [...series].map(([start, row]) => ({ start, ...row })),
    duplicatesDropped,
    oldestAt: Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null,
  };
}

// How Claude Code names a project's transcript folder after its working directory.
export const projectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

type Cached = ScannedFile & { mtimeMs: number; size: number };

export function createUsageHistory(projectsDir: string) {
  const cache = new Map<string, Cached>();

  async function listTranscripts() {
    const entries = await NodeFSP.readdir(projectsDir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => NodePath.join(entry.parentPath, entry.name))
      .toSorted();
  }

  async function read(path: string, sinceMs: number) {
    const { mtimeMs, size } = await NodeFSP.stat(path);
    if (mtimeMs < sinceMs) {
      return undefined;
    }
    const cached = cache.get(path);
    if (cached?.mtimeMs === mtimeMs && cached.size === size) {
      return cached;
    }
    const scanned = { ...(await scanFile(path)), mtimeMs, size };
    cache.set(path, scanned);
    return scanned;
  }

  async function scan(days: number, botFolders: Map<string, string>): Promise<UsageSummary> {
    const nowMs = Date.now();
    let paths: string[];
    try {
      paths = await listTranscripts();
    } catch {
      return { status: "unavailable" };
    }
    for (const path of cache.keys()) {
      if (!paths.includes(path)) {
        cache.delete(path);
      }
    }
    const { sinceMs } = timeBuckets(days, nowMs);
    const sources: Source[] = [];
    let skippedLines = 0;
    let unreadableFiles = 0;
    for (const path of paths) {
      try {
        const scanned = await read(path, sinceMs);
        if (scanned) {
          const folder = NodePath.relative(projectsDir, path).split(NodePath.sep)[0] ?? "";
          sources.push({ records: scanned.records, botId: botFolders.get(folder) ?? null });
          skippedLines += scanned.skipped;
        }
      } catch {
        unreadableFiles += 1;
      }
    }
    return {
      status: "ok",
      days,
      generatedAt: new Date(nowMs).toISOString(),
      files: sources.length,
      skippedLines,
      unreadableFiles,
      ...aggregateUsage(sources, days, nowMs),
    };
  }

  let running: Promise<unknown> = Promise.resolve();
  return {
    // One scan at a time: a second would read the same files again before the cache fills.
    summary: (days: number, botFolders: Map<string, string>) => {
      const next = running.then(() => scan(days, botFolders));
      running = next.catch(() => {});
      return next;
    },
  };
}
