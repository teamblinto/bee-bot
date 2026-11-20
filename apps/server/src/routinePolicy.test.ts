import { describe, expect, it } from "vite-plus/test";

import { attemptOutcome, slotOutcome, staggerMs } from "./routinePolicy.ts";

describe("stagger", () => {
  it("is the same for an ID every time, in whole seconds under five minutes", () => {
    const ids = Array.from({ length: 200 }, () => crypto.randomUUID());
    for (const id of ids) {
      const offset = staggerMs(id);
      expect(staggerMs(id)).toBe(offset);
      expect(offset % 1000).toBe(0);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(300_000);
    }
    expect(new Set(ids.map(staggerMs)).size).toBeGreaterThan(100);
  });
});

describe("slot outcome", () => {
  const slot = "2026-03-10T09:00:00.000Z";
  const base = {
    slot,
    passedOver: 0,
    now: "2026-03-10T09:03:00.000Z",
    staggerMs: 60_000,
    lastOwnerActivity: "2026-03-09T20:00:00.000Z",
    botPaused: false,
  };

  it("opens a plain card on time", () => {
    expect(slotOutcome(base)).toEqual({ status: "ready", reason: null });
  });

  it("calls it a catch-up when slots were passed over or it is well past due", () => {
    expect(slotOutcome({ ...base, passedOver: 2 })).toEqual({
      status: "ready",
      reason: "catch_up",
    });
    expect(slotOutcome({ ...base, now: "2026-03-10T13:00:00.000Z" })).toEqual({
      status: "ready",
      reason: "catch_up",
    });
  });

  it("skips while the owner has been away more than a week", () => {
    expect(slotOutcome({ ...base, lastOwnerActivity: "2026-03-03T09:02:00.000Z" })).toEqual({
      status: "skipped",
      reason: "owner_away",
    });
    expect(slotOutcome({ ...base, lastOwnerActivity: "2026-03-03T09:04:00.000Z" }).status).toBe(
      "ready",
    );
  });

  it("puts a slot past the catch-up window before every other reason", () => {
    const old = { ...base, now: "2026-03-12T09:00:00.000Z", botPaused: true };
    expect(slotOutcome(old)).toEqual({ status: "missed", reason: "asleep" });
    expect(slotOutcome({ ...base, botPaused: true }).reason).toBe("bot_paused");
  });

  it("measures the catch-up window on the cron's staggered clock", () => {
    const yesterday = { ...base, slot: "2026-03-09T09:00:00.000Z", staggerMs: 180_000 };
    expect(slotOutcome({ ...yesterday, now: "2026-03-10T09:02:00.000Z" })).toEqual({
      status: "ready",
      reason: "catch_up",
    });
    expect(slotOutcome({ ...yesterday, now: "2026-03-10T09:03:01.000Z" }).status).toBe("missed");
  });
});

describe("attempt outcome", () => {
  const now = "2026-03-10T09:00:00.000Z";
  const failed = {
    status: "Failed",
    reason: "engine_failed",
    attempts: 1,
    setupFailures: 0,
    now,
  } as const;

  it("retries a failed first attempt once, 12 minutes later", () => {
    expect(attemptOutcome(failed)).toEqual({
      setupFailures: 0,
      stop: false,
      retryAt: "2026-03-10T09:12:00.000Z",
    });
    expect(attemptOutcome({ ...failed, attempts: 2 }).retryAt).toBeNull();
  });

  it("leaves a rate limit, a stop and a success alone", () => {
    expect(attemptOutcome({ ...failed, reason: "limited" }).retryAt).toBeNull();
    expect(attemptOutcome({ ...failed, status: "Cancelled", setupFailures: 2 })).toEqual({
      setupFailures: 2,
      stop: false,
      retryAt: null,
    });
    expect(attemptOutcome({ ...failed, status: "Completed", setupFailures: 2 })).toEqual({
      setupFailures: 0,
      stop: false,
      retryAt: null,
    });
  });

  it("stops at the third setup failure in a row, and other failures break the run", () => {
    const setup = { ...failed, reason: "auth_failed" } as const;
    expect(attemptOutcome({ ...setup, setupFailures: 1 })).toMatchObject({
      setupFailures: 2,
      stop: false,
    });
    expect(attemptOutcome({ ...setup, setupFailures: 2 })).toEqual({
      setupFailures: 3,
      stop: true,
      retryAt: null,
    });
    expect(attemptOutcome({ ...failed, setupFailures: 2 }).setupFailures).toBe(0);
  });
});
