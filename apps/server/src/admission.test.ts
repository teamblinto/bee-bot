import { expect, it } from "vite-plus/test";

import { admit, dailyRunCap } from "./admission.ts";

const now = "2026-11-05T12:00:00.000Z";
const later = "2026-11-05T13:00:00.000Z";
const open = {
  attended: true,
  box: "none",
  unattendedLane: null,
  botStatus: "ready",
  runsInLastDay: 0,
  blockedUntil: null,
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
