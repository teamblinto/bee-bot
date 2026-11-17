import type { Approval, Bot, Continuation, Run } from "@beebot/contracts";
import { describe, expect, it } from "vite-plus/test";

import { commandFailed, handoffRequested, usageOf, type UsageLookup } from "./usageEvents.ts";

const bot: Bot = {
  id: "bot-1",
  name: "Ada",
  personality: "secret personality",
  summary: null,
  status: "ready",
  pauseReason: null,
  roomId: "room-1",
  engineAccountId: "codex",
  model: "gpt-5",
  effort: null,
  mode: "build",
  access: "supervised",
  boundary: "box",
  manifest: [],
  control: "browser",
  egressAnySite: false,
  egressHosts: [],
  unattendedLane: "api_key",
  avatarSeed: 0,
  projectPath: "C:/Users/owner/project",
  archivedAt: null,
};

const run: Run = {
  id: "run-1",
  botId: bot.id,
  status: "Queued",
  reason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  endedAt: null,
  chainId: null,
  hop: 0,
  depth: 0,
  taskId: null,
};

const lookup = (always: string[] = []): UsageLookup => ({
  bot: (id) => (id === bot.id ? bot : undefined),
  wake: () => ({ source: "routine", attended: false }),
  lane: () => "subscription",
  always: new Set(always),
});

const approval: Approval = {
  id: "approval-1",
  runId: run.id,
  botId: bot.id,
  tool: "Bash",
  digest: "d",
  status: "pending",
  reason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  decidedAt: null,
};

const continuation: Continuation = {
  id: "continuation-1",
  botId: bot.id,
  runId: run.id,
  kind: "hand_off",
  tool: "browser_pay",
  shown: "Pay 10 EUR",
  digest: "d",
  status: "waiting",
  reason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T01:00:00.000Z",
  decidedAt: null,
  finishedAt: null,
};

describe("usageOf", () => {
  it("reads a run's start and end from its timestamps, with its bot's engine and boundary", () => {
    const started = {
      ...run,
      status: "Running" as const,
      startedAt: "2026-01-01T00:00:02.000Z",
    };
    expect(usageOf({ type: "run.changed", run: started }, lookup())).toEqual({
      event: "run_started",
      properties: {
        engine: "codex",
        boundary: "box",
        source: "routine",
        attended: false,
        queued_ms: 2000,
      },
    });
    const ended = {
      ...started,
      status: "Failed" as const,
      reason: "timeout" as const,
      endedAt: "2026-01-01T00:01:02.000Z",
    };
    expect(usageOf({ type: "run.changed", run: ended }, lookup())).toEqual({
      event: "run_finished",
      properties: {
        engine: "codex",
        boundary: "box",
        status: "Failed",
        reason: "timeout",
        duration_ms: 60_000,
      },
    });
  });

  it("counts a refused run as finished at once, and a parked run as nothing", () => {
    const refused = {
      ...run,
      status: "Refused" as const,
      reason: "daily_cap" as const,
      endedAt: run.createdAt,
    };
    expect(usageOf({ type: "run.changed", run: refused }, lookup())?.properties).toMatchObject({
      status: "Refused",
      duration_ms: 0,
    });
    const parked = { ...run, status: "WaitingUser" as const };
    expect(usageOf({ type: "run.changed", run: parked }, lookup())).toBeUndefined();
    expect(usageOf({ type: "run.changed", run }, lookup())).toBeUndefined();
  });

  it("reports a run parked on quota as the account being limited", () => {
    const limited = { ...run, status: "WaitingQuota" as const, reason: "limited" as const };
    expect(usageOf({ type: "run.changed", run: limited }, lookup())).toEqual({
      event: "quota_limited",
      properties: { engine: "codex", lane: "subscription" },
    });
  });

  it("maps a tool approval's answer, including always", () => {
    const decided = {
      ...approval,
      status: "allowed" as const,
      reason: "owner" as const,
      decidedAt: "2026-01-01T00:00:05.000Z",
    };
    expect(usageOf({ type: "approval.changed", approval }, lookup())).toEqual({
      event: "approval_requested",
      properties: { kind: "tool" },
    });
    expect(usageOf({ type: "approval.changed", approval: decided }, lookup())).toEqual({
      event: "approval_decided",
      properties: { kind: "tool", decision: "allow", wait_ms: 5000 },
    });
    expect(
      usageOf({ type: "approval.changed", approval: decided }, lookup([approval.id]))?.properties,
    ).toMatchObject({ decision: "always" });
    const timedOut = { ...approval, status: "expired" as const, reason: "timeout" as const };
    expect(
      usageOf({ type: "approval.changed", approval: timedOut }, lookup())?.properties,
    ).toMatchObject({ decision: "expired" });
    const stopped = { ...approval, status: "denied" as const, reason: "stopped" as const };
    expect(usageOf({ type: "approval.changed", approval: stopped }, lookup())).toBeUndefined();
  });

  it("maps continuations: an approve is allow, and later steps decide nothing", () => {
    const action = { ...continuation, kind: "approval" as const };
    expect(usageOf({ type: "continuation.changed", continuation: action }, lookup())).toEqual({
      event: "approval_requested",
      properties: { kind: "action" },
    });
    const approved = { ...action, status: "approved" as const, reason: "owner" as const };
    expect(
      usageOf({ type: "continuation.changed", continuation: approved }, lookup())?.properties,
    ).toMatchObject({ kind: "action", decision: "allow" });
    const claimed = { ...approved, status: "claimed" as const };
    expect(
      usageOf({ type: "continuation.changed", continuation: claimed }, lookup()),
    ).toBeUndefined();
    const done = { ...continuation, status: "succeeded" as const, reason: "owner" as const };
    expect(
      usageOf({ type: "continuation.changed", continuation: done }, lookup())?.properties,
    ).toMatchObject({ kind: "hand_off", decision: "allow" });
    const denied = { ...continuation, status: "denied" as const, reason: "owner" as const };
    expect(
      usageOf({ type: "continuation.changed", continuation: denied }, lookup())?.properties,
    ).toMatchObject({ kind: "hand_off", decision: "deny" });
    const expired = {
      ...continuation,
      status: "expired" as const,
      reason: "timeout" as const,
      finishedAt: continuation.expiresAt,
    };
    expect(
      usageOf({ type: "continuation.changed", continuation: expired }, lookup())?.properties,
    ).toEqual({ kind: "hand_off", decision: "expired", wait_ms: 3_600_000 });
  });

  it("counts a firing once, not again when its retry is scheduled", () => {
    const firing = {
      id: "firing-1",
      routineId: "routine-1",
      slot: "2026-01-01T00:00:00.000Z",
      status: "ran" as const,
      reason: null,
      missedBefore: 2,
      attempts: 1,
      retryAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      decidedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(usageOf({ type: "firing.changed", firing }, lookup())).toEqual({
      event: "routine_fired",
      properties: { status: "ran", reason: null, missed_before: 2 },
    });
    const retrying = { ...firing, retryAt: "2026-01-01T00:05:00.000Z" };
    expect(usageOf({ type: "firing.changed", firing: retrying }, lookup())).toBeUndefined();
  });

  it("never carries the bot's name, personality or folder", () => {
    const ended = { ...run, status: "Completed" as const, endedAt: run.createdAt };
    const text = JSON.stringify(usageOf({ type: "run.changed", run: ended }, lookup()));
    expect(text).not.toMatch(/Ada|secret|owner|run-1|bot-1/);
  });
});

describe("commandFailed", () => {
  it("takes the body's code, or storage_failed when it has none", () => {
    expect(commandFailed("set-bot-boundary", 409, { code: "bot_busy" })?.properties).toEqual({
      command: "set-bot-boundary",
      status: 409,
      code: "bot_busy",
    });
    expect(commandFailed("send-message", 500, undefined)?.properties.code).toBe("storage_failed");
    expect(commandFailed("send-message", 200, { ok: true })).toBeUndefined();
    expect(commandFailed("track", 400, { code: "bad_request" })).toBeUndefined();
  });
});

describe("handoffRequested", () => {
  it("tells a human-only step from a challenge", () => {
    expect(handoffRequested("hand_off", "human_only").properties.reason).toBe("human_only");
    expect(handoffRequested("captcha", "example.com").properties.reason).toBe("challenge");
    expect(handoffRequested("takeover", "stuck").properties.reason).toBe("other");
  });
});
