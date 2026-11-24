import { expect, it } from "vite-plus/test";

import {
  admit,
  capHit,
  cellLimits,
  dailyRunCap,
  defaultMaxActiveBoxes,
  monthStart,
} from "./admission.ts";

const now = "2026-11-05T12:00:00.000Z";
const later = "2026-11-05T13:00:00.000Z";
const open = {
  attended: true,
  box: "none",
  unattendedLane: null,
  engine: "claude",
  lane: "subscription",
  botStatus: "ready",
  runsInLastDay: 0,
  blockedUntil: null,
  monthlyBudgetUsd: null,
  spentThisMonthUsd: 0,
  now,
} as const;
const boxed = { ...open, attended: false, box: "ready", unattendedLane: "api_key" } as const;

it("admits an attended wake on a ready bot, with or without a box", () => {
  expect(admit(open)).toEqual({ verdict: "admit" });
  expect(admit({ ...open, box: "unavailable" })).toEqual({ verdict: "admit" });
});

it.each([
  ["no box", { box: "none" }, "unattended"],
  ["a box that can't run", { box: "unavailable" }, "box_unavailable"],
  ["a box but no allowed lane", { unattendedLane: null }, "automated_access"],
] as const)("refuses an unattended wake on a bot with %s", (_, change, reason) => {
  expect(admit({ ...boxed, ...change })).toEqual({ verdict: "refuse", reason });
});

it("admits an unattended wake on a ready box, on either allowed lane", () => {
  expect(admit(boxed)).toEqual({ verdict: "admit" });
  expect(admit({ ...boxed, unattendedLane: "subscription" })).toEqual({ verdict: "admit" });
});

it("keeps the other refusals for an unattended box wake", () => {
  expect(admit({ ...boxed, botStatus: "paused" })).toEqual({
    verdict: "refuse",
    reason: "bot_paused",
  });
  expect(admit({ ...boxed, blockedUntil: later })).toEqual({ verdict: "defer", until: later });
});

it("refuses a paused bot rather than deferring it", () => {
  expect(admit({ ...open, botStatus: "paused", blockedUntil: later })).toEqual({
    verdict: "refuse",
    reason: "bot_paused",
  });
});

it("refuses at the daily cap, not one run before it", () => {
  expect(admit({ ...open, runsInLastDay: dailyRunCap - 1 }).verdict).toBe("admit");
  expect(admit({ ...open, runsInLastDay: dailyRunCap })).toEqual({
    verdict: "refuse",
    reason: "daily_cap",
  });
});

it("defers to blocked_until while the account is blocked, and admits once it has passed", () => {
  expect(admit({ ...open, blockedUntil: later })).toEqual({ verdict: "defer", until: later });
  expect(admit({ ...open, blockedUntil: now }).verdict).toBe("admit");
});

it("refuses an API-key run once this month's spend reaches the budget, and only then", () => {
  const budgeted = { ...open, lane: "api_key", monthlyBudgetUsd: 10 } as const;
  expect(admit({ ...budgeted, spentThisMonthUsd: 9.99 }).verdict).toBe("admit");
  expect(admit({ ...budgeted, spentThisMonthUsd: 10 })).toEqual({
    verdict: "refuse",
    reason: "budget",
  });
  expect(admit({ ...budgeted, lane: "subscription", spentThisMonthUsd: 50 }).verdict).toBe("admit");
  expect(admit({ ...open, lane: "api_key", spentThisMonthUsd: 1e6 }).verdict).toBe("admit");
});

it("refuses Codex's API-key lane under any budget, since Codex reports no cost", () => {
  const codex = { ...open, engine: "codex", lane: "api_key" } as const;
  expect(admit({ ...codex, monthlyBudgetUsd: 10 })).toEqual({
    verdict: "refuse",
    reason: "budget",
  });
  expect(admit({ ...codex, monthlyBudgetUsd: 10, lane: "subscription" }).verdict).toBe("admit");
  expect(admit(codex).verdict).toBe("admit");
});

it("starts each budget period at the first of the month, UTC", () => {
  expect(monthStart("2026-11-30T23:59:59.999Z")).toBe("2026-11-01T00:00:00.000Z");
  expect(monthStart("2026-12-01T00:00:00.000Z")).toBe("2026-12-01T00:00:00.000Z");
});

it("reads the operator's limits, failing closed on a malformed one", () => {
  expect(cellLimits({})).toEqual({ maxActiveBoxes: defaultMaxActiveBoxes, monthlyBudgetUsd: null });
  expect(cellLimits({ BEEBOT_MAX_ACTIVE_BOXES: "5", BEEBOT_MONTHLY_BUDGET_USD: "12.50" })).toEqual({
    maxActiveBoxes: 5,
    monthlyBudgetUsd: 12.5,
  });
  for (const env of [
    { BEEBOT_MAX_ACTIVE_BOXES: "0" },
    { BEEBOT_MAX_ACTIVE_BOXES: "" },
    { BEEBOT_MAX_ACTIVE_BOXES: "three" },
    { BEEBOT_MONTHLY_BUDGET_USD: "" },
    { BEEBOT_MONTHLY_BUDGET_USD: "-1" },
    { BEEBOT_MONTHLY_BUDGET_USD: "1e9" },
  ]) {
    expect(cellLimits(env)).toHaveProperty("error");
  }
});

it("capHit trips at either daily cap, and never with both caps cleared", () => {
  const caps = { dailyTokenCap: 4000, dailyUsdCap: 2 };
  expect(capHit({ tokens: 3999, usd: 1.99 }, caps)).toBe(false);
  expect(capHit({ tokens: 4000, usd: 0 }, caps)).toBe(true);
  expect(capHit({ tokens: 0, usd: 2 }, caps)).toBe(true);
  expect(capHit({ tokens: 1e9, usd: 1e6 }, { dailyTokenCap: null, dailyUsdCap: null })).toBe(false);
});
