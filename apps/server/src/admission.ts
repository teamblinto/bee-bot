import type { Bot, EngineLane, RunReason } from "@beebot/contracts";

export const dailyRunCap = 100;
export const defaultMaxActiveBoxes = 3;

type Admission = {
  attended: boolean;
  // `unavailable`: the bot's boundary is a box, but no box runtime can run one now.
  box: "none" | "unavailable" | "ready";
  // R7: the lane an unattended run may use, or null when the owner allowed none.
  unattendedLane: EngineLane | null;
  engine: Bot["engineAccountId"];
  // The lane this run would take.
  lane: EngineLane;
  botStatus: Bot["status"];
  runsInLastDay: number;
  blockedUntil: string | null;
  // Server mode's API-key budget for this calendar month (UTC), or null for none.
  monthlyBudgetUsd: number | null;
  spentThisMonthUsd: number;
  now: string;
};

type Decision =
  | { verdict: "admit" }
  | { verdict: "refuse"; reason: RunReason }
  | { verdict: "defer"; until: string };

function unattendedRefusal({ box, unattendedLane }: Admission): RunReason | null {
  if (box === "none") {
    return "unattended";
  }
  if (box === "unavailable") {
    return "box_unavailable";
  }
  return unattendedLane === null ? "automated_access" : null;
}

// The subscription lane is left to the vendor's own limits: Bee can't see what it costs. Codex
// reports no cost at all, so under a budget its API-key lane is refused outright.
const overBudget = ({ engine, lane, monthlyBudgetUsd, spentThisMonthUsd }: Admission) =>
  lane === "api_key" &&
  monthlyBudgetUsd !== null &&
  (engine === "codex" || spentThisMonthUsd >= monthlyBudgetUsd);

// Account concurrency is not decided here: a Queued run simply isn't claimable yet.
export function admit(admission: Admission) {
  const { attended, botStatus, runsInLastDay, blockedUntil, now } = admission;
  const refusal = attended ? null : unattendedRefusal(admission);
  let decision: Decision = { verdict: "admit" };
  if (refusal !== null) {
    decision = { verdict: "refuse", reason: refusal };
  } else if (botStatus === "paused") {
    decision = { verdict: "refuse", reason: "bot_paused" };
  } else if (runsInLastDay >= dailyRunCap) {
    decision = { verdict: "refuse", reason: "daily_cap" };
  } else if (overBudget(admission)) {
    decision = { verdict: "refuse", reason: "budget" };
  } else if (blockedUntil !== null && blockedUntil > now) {
    decision = { verdict: "defer", until: blockedUntil };
  }
  return decision;
}

export const monthStart = (now: string) => `${now.slice(0, 7)}-01T00:00:00.000Z`;

// The same patterns `beebot-provision user quota` checks before it writes them.
const boxesPattern = /^[1-9][0-9]{0,2}$/;
const budgetPattern = /^(0|[1-9][0-9]{0,6})(\.[0-9]{1,2})?$/;

// Server mode's per-user limits, set by the operator. A malformed one is an error, never no limit.
export function cellLimits({
  BEEBOT_MAX_ACTIVE_BOXES: boxes,
  BEEBOT_MONTHLY_BUDGET_USD: budget,
}: NodeJS.ProcessEnv) {
  if (boxes !== undefined && !boxesPattern.test(boxes)) {
    return { error: "BEEBOT_MAX_ACTIVE_BOXES must be a whole number from 1 to 999" } as const;
  }
  if (budget !== undefined && !budgetPattern.test(budget)) {
    return { error: "BEEBOT_MONTHLY_BUDGET_USD must be dollars, like 25 or 12.50" } as const;
  }
  return {
    maxActiveBoxes: boxes === undefined ? defaultMaxActiveBoxes : Number(boxes),
    monthlyBudgetUsd: budget === undefined ? null : Number(budget),
  };
}
