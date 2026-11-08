import type { LimitRefusal, WakeSource } from "@beebot/contracts";

export type Limits = {
  hop: number;
  depth: number;
  fanOut: number;
  mentions: number;
  posts: number;
  postWindowMs: number;
  chainTurns: number;
  chainWallMs: number;
};

export type Verdict = { verdict: "allow" } | { verdict: "refuse"; reason: LimitRefusal };

// What a run carries from its chain. `startedAt` is the chain's first wake.
export type Chain = { hop: number; depth: number; turns: number; startedAt: string };

export type ToolCall = { tool: string; input: string; failed: boolean };

const notImplemented = (name: string) => new Error(`limits.${name} is not implemented`);

// Defaults: hop 2 (ceiling 4), depth 1 (ceiling 2), fanOut 3, mentions 4, posts 2 per 300000 ms.
export function clampLimits(_raw: Partial<Limits>): Limits {
  throw notImplemented("clampLimits");
}

// The child would sit at hop + 1 and depth + 1. `tasksInRun` is a pre-check: the cap that holds is
// the one `createTask` reserves.
export function checkDelegation(
  _limits: Limits,
  _input: { chain: Chain; tasksInRun: number; now: string },
): Verdict {
  throw notImplemented("checkDelegation");
}

// `chain` is null for a human's message, which starts a new chain.
export function checkMentionWake(
  _limits: Limits,
  _input: { chain: Chain | null; mentions: number; now: string },
): Verdict {
  throw notImplemented("checkMentionWake");
}

// The room's round: bot posts since the last human message, and when that count's window opened.
export function checkBotPost(
  _limits: Limits,
  _input: { botPosts: number; windowStartedAt: string | null; now: string },
): Verdict {
  throw notImplemented("checkBotPost");
}

// Milliseconds to hold the wake, 0 for none. A human's input never waits.
export function noProgressDelay(_input: { noProgressRuns: number; source: WakeSource }): number {
  throw notImplemented("noProgressDelay");
}

// One tracker per run. Refuses with `repeated_failure` on the 6th identical failing call.
export function trackFailures(): (call: ToolCall) => Verdict {
  throw notImplemented("trackFailures");
}

// Null is the owner. A routine's run creating a routine needs the owner's approval.
export function checkRoutineCreate(_input: { source: WakeSource | null }): Verdict {
  throw notImplemented("checkRoutineCreate");
}
