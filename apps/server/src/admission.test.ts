import { expect, it } from "vite-plus/test";

import { admit, dailyRunCap } from "./admission.ts";

const now = "2026-11-05T12:00:00.000Z";
const later = "2026-11-05T13:00:00.000Z";
const open = {
  attended: true,
  botStatus: "ready",
  runsInLastDay: 0,
  blockedUntil: null,
  now,
} as const;

it("admits an attended wake on a ready bot", () => {
  expect(admit(open)).toEqual({ verdict: "admit" });
});

it("refuses every unattended wake", () => {
  expect(admit({ ...open, attended: false })).toEqual({ verdict: "refuse", reason: "unattended" });
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
