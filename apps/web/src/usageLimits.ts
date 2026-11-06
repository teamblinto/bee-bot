import type { UsageWindow } from "@beebot/contracts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

// Null means unknown, and unknown is never 0.
export const remainingPercent = ({ usedPercent }: UsageWindow) =>
  usedPercent === null ? null : Math.round(100 - Math.max(0, Math.min(100, usedPercent)));

function resetMillis({ resetsAt }: UsageWindow) {
  const at = resetsAt === null ? NaN : Date.parse(resetsAt);
  return Number.isFinite(at) ? at : null;
}

function elapsedShare(window: UsageWindow, now: number) {
  const resetsAt = resetMillis(window);
  const length = (window.windowDurationMins ?? 0) * minute;
  return resetsAt === null || length <= 0
    ? null
    : Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

// Bars show quota remaining, so even pace tracks time remaining.
export function paceRemainingPercent(window: UsageWindow, now: number) {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

export type LimitPace = "ahead" | "on" | "under";

export function paceOf(window: UsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  if (elapsed === null || window.usedPercent === null) {
    return null;
  }
  const gap = window.usedPercent - elapsed * 100;
  if (gap > 5) {
    return "ahead";
  }
  return gap < -5 ? "under" : "on";
}

function formatDuration(ms: number) {
  const remaining = Math.max(0, ms);
  const days = Math.floor(remaining / day);
  const hours = Math.floor((remaining % day) / hour);
  const minutes = Math.floor((remaining % hour) / minute);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatResetsIn(window: UsageWindow, now: number) {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) {
    return null;
  }
  if (resetsAt <= now) {
    return "resets now";
  }
  return resetsAt - now < minute
    ? "Resets momentarily"
    : `resets in ${formatDuration(resetsAt - now)}`;
}
