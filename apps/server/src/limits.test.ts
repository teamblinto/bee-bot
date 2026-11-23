import { describe, expect, it } from "vite-plus/test";

import {
  backoffUntil,
  checkBotPost,
  checkDelegation,
  checkFollowUp,
  checkMentionWake,
  checkRoutineCreate,
  clampLimits,
  noProgressDelay,
  trackFailures,
} from "./limits.ts";

const minute = 60_000;
const startedAt = "2026-11-05T12:00:00.000Z";
const now = "2026-11-05T12:10:00.000Z";
const at = (ms: number) => new Date(Date.parse(startedAt) + ms).toISOString();
const limits = clampLimits({});
const chain = { hop: 0, depth: 0, turns: 1, startedAt };
const allow = { verdict: "allow" };
const refuse = (reason: string) => ({ verdict: "refuse", reason });

describe("clampLimits", () => {
  it("never exceeds a ceiling", () => {
    expect(clampLimits({ hop: 10, depth: 10, fanOut: 10, mentions: 10, posts: 10 })).toMatchObject({
      hop: 4,
      depth: 4,
      fanOut: 3,
      mentions: 4,
      posts: 2,
    });
  });

  it("lets an owner lower a limit", () => {
    expect(clampLimits({ hop: 1, chainTurns: 5 })).toMatchObject({ hop: 1, chainTurns: 5 });
  });
});

describe("checkFollowUp", () => {
  it("lets a follow-up through at any hop, but not past the chain's turns or time", () => {
    expect(checkFollowUp(limits, { chain: { ...chain, hop: 9 }, now })).toEqual(allow);
    expect(checkFollowUp(limits, { chain: { ...chain, turns: 20 }, now })).toEqual(
      refuse("chain_turns"),
    );
    expect(
      checkFollowUp(limits, { chain: { ...chain, startedAt: at(-50 * minute) }, now }),
    ).toEqual(refuse("chain_time"));
  });
});

describe("checkDelegation", () => {
  it("refuses the hop after the limit", () => {
    expect(checkDelegation(limits, { chain: { ...chain, hop: 1 }, tasksInRun: 0, now })).toEqual(
      allow,
    );
    expect(checkDelegation(limits, { chain: { ...chain, hop: 2 }, tasksInRun: 0, now })).toEqual(
      refuse("hop"),
    );
  });

  it("refuses a child past the spawn depth", () => {
    expect(checkDelegation(limits, { chain: { ...chain, depth: 1 }, tasksInRun: 0, now })).toEqual(
      allow,
    );
    expect(checkDelegation(limits, { chain: { ...chain, depth: 2 }, tasksInRun: 0, now })).toEqual(
      refuse("depth"),
    );
  });

  it("refuses a 4th task in one run", () => {
    expect(checkDelegation(limits, { chain, tasksInRun: 2, now })).toEqual(allow);
    expect(checkDelegation(limits, { chain, tasksInRun: 3, now })).toEqual(refuse("fan_out"));
  });

  it("refuses once the chain spends its turns or time", () => {
    expect(checkDelegation(limits, { chain: { ...chain, turns: 19 }, tasksInRun: 0, now })).toEqual(
      allow,
    );
    expect(checkDelegation(limits, { chain: { ...chain, turns: 20 }, tasksInRun: 0, now })).toEqual(
      refuse("chain_turns"),
    );
    expect(checkDelegation(limits, { chain, tasksInRun: 0, now: at(60 * minute - 1) })).toEqual(
      allow,
    );
    expect(checkDelegation(limits, { chain, tasksInRun: 0, now: at(60 * minute) })).toEqual(
      refuse("chain_time"),
    );
  });
});

describe("checkMentionWake", () => {
  it("wakes the first 4 mentions and drops the 5th", () => {
    expect(checkMentionWake(limits, { chain: null, mentions: 4, now })).toEqual(allow);
    expect(checkMentionWake(limits, { chain: null, mentions: 5, now })).toEqual(refuse("mentions"));
  });

  it("counts a bot's mention as a hop on its chain", () => {
    expect(checkMentionWake(limits, { chain: { ...chain, hop: 2 }, mentions: 1, now })).toEqual(
      refuse("hop"),
    );
  });
});

describe("checkBotPost", () => {
  it("refuses a 3rd bot post within the window", () => {
    const input = { windowStartedAt: startedAt, now: at(4 * minute) };
    expect(checkBotPost(limits, { ...input, botPosts: 1 })).toEqual(allow);
    expect(checkBotPost(limits, { ...input, botPosts: 2 })).toEqual(refuse("post_budget"));
  });

  it("allows a post once the window has passed", () => {
    expect(
      checkBotPost(limits, { botPosts: 2, windowStartedAt: startedAt, now: at(5 * minute) }),
    ).toEqual(allow);
  });
});

describe("noProgressDelay", () => {
  it("doubles from 2 to a 30 minute cap", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 7].map((noProgressRuns) =>
      noProgressDelay({ noProgressRuns, source: "task" }),
    );
    expect(delays).toEqual([0, 0, 2, 4, 8, 16, 30, 30].map((m) => m * minute));
  });

  it("never holds a human's input", () => {
    expect(noProgressDelay({ noProgressRuns: 5, source: "human" })).toBe(0);
  });
});

describe("backoffUntil", () => {
  it("holds a wake after repeated no-progress turns, never a human's", () => {
    const input = {
      noProgressRuns: 2,
      source: "task" as const,
      lastEndedAt: startedAt,
      now: at(minute),
    };
    expect(backoffUntil(input)).toBe(at(2 * minute));
    expect(backoffUntil({ ...input, now: at(3 * minute) })).toBeNull();
    expect(backoffUntil({ ...input, source: "human" })).toBeNull();
    expect(backoffUntil({ ...input, source: "approval" })).toBeNull();
    expect(backoffUntil({ ...input, lastEndedAt: null })).toBeNull();
    expect(backoffUntil({ ...input, noProgressRuns: 3 })).toBe(at(4 * minute));
  });
});

describe("trackFailures", () => {
  const failing = { tool: "bash", input: '{"cmd":"make"}', failed: true };

  it("refuses the 6th identical failing call", () => {
    const track = trackFailures();
    for (let i = 0; i < 5; i++) expect(track(failing)).toEqual(allow);
    expect(track(failing)).toEqual(refuse("repeated_failure"));
  });

  it("starts over after a success or a different call", () => {
    const track = trackFailures();
    for (let i = 0; i < 5; i++) track(failing);
    track({ ...failing, failed: false });
    for (let i = 0; i < 4; i++) track(failing);
    track({ ...failing, input: '{"cmd":"make test"}' });
    for (let i = 0; i < 5; i++) expect(track(failing)).toEqual(allow);
  });
});

describe("checkRoutineCreate", () => {
  it("needs the owner's approval only for a routine's run", () => {
    expect(checkRoutineCreate({ source: "routine" })).toEqual(refuse("routine_approval"));
    expect(checkRoutineCreate({ source: null })).toEqual(allow);
    expect(checkRoutineCreate({ source: "human" })).toEqual(allow);
  });
});
