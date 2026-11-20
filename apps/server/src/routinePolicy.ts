import type { RoutineFiring, RunReason } from "@beebot/contracts";

import { catchUpWindowMs } from "./routines.ts";

const day = 24 * 60 * 60_000;
// Under the 15-minute minimum gap, so a stagger never reorders a routine's slots.
const maxStaggerSecs = 300;
// Past this, a card is a catch-up rather than a slightly late tick.
const lateGraceMs = 10 * 60_000;
// Claude Desktop catches up on the last 7 days. Past the same span, Bee assumes nobody is there.
const ownerAwayMs = 7 * day;
// Rakazo retries a failed routine after 12 minutes.
const retryDelayMs = 12 * 60_000;
// Rakazo stops at 8, but each attempt here costs the owner a click.
const setupFailureLimit = 3;
const setupReasons = new Set<RunReason>(["auth_failed", "folder_missing"]);

// FNV-1a, so a routine keeps its offset across restarts and machines.
export function staggerMs(routineId: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < routineId.length; index += 1) {
    hash = Math.imul(hash ^ routineId.charCodeAt(index), 0x01000193);
  }
  return ((hash >>> 0) % maxStaggerSecs) * 1000;
}

export function slotOutcome(input: {
  slot: string;
  passedOver: number;
  now: string;
  staggerMs: number;
  lastOwnerActivity: string;
  botPaused: boolean;
}): Pick<RoutineFiring, "status" | "reason"> {
  const now = Date.parse(input.now);
  // The caller picks the slot on the cron's clock, which runs `staggerMs` behind the wall clock.
  if (now - input.staggerMs - Date.parse(input.slot) > catchUpWindowMs) {
    return { status: "missed", reason: "asleep" };
  }
  if (now - Date.parse(input.lastOwnerActivity) > ownerAwayMs) {
    return { status: "skipped", reason: "owner_away" };
  }
  if (input.botPaused) {
    return { status: "skipped", reason: "bot_paused" };
  }
  const late = now - Date.parse(input.slot) - input.staggerMs > lateGraceMs;
  return { status: "ready", reason: input.passedOver > 0 || late ? "catch_up" : null };
}

export function attemptOutcome(input: {
  status: "Completed" | "Failed" | "Cancelled";
  reason: RunReason | null;
  attempts: number;
  setupFailures: number;
  now: string;
}) {
  if (input.status === "Cancelled") {
    return { setupFailures: input.setupFailures, stop: false, retryAt: null };
  }
  const setup =
    input.status === "Failed" && input.reason !== null && setupReasons.has(input.reason);
  const setupFailures = setup ? input.setupFailures + 1 : 0;
  const stop = setupFailures >= setupFailureLimit;
  // A rate limit already reopens its wake when the block lifts.
  const retry =
    input.status === "Failed" && !stop && input.attempts < 2 && input.reason !== "limited";
  const retryAt = retry ? new Date(Date.parse(input.now) + retryDelayMs).toISOString() : null;
  return { setupFailures, stop, retryAt };
}
