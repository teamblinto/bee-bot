import {
  type LimitOverrides,
  type LimitRefusal,
  type Limits,
  type WakeSource,
  limitCeilings,
  limitDefaults,
} from "@beebot/contracts";

export type { Limits };

export type Verdict = { verdict: "allow" } | { verdict: "refuse"; reason: LimitRefusal };

// What a run carries from its chain. `startedAt` is the chain's first wake.
export type Chain = { hop: number; depth: number; turns: number; startedAt: string };

export type ToolCall = { tool: string; input: string; failed: boolean };

const minute = 60_000;

const allow: Verdict = { verdict: "allow" };
const refuse = (reason: LimitRefusal): Verdict => ({ verdict: "refuse", reason });

// Defaults: hop 2 (ceiling 4), depth 2 (ceiling 4), fanOut 3, mentions 4, posts 2 per 300000 ms.
// Owners may lower any limit; none rises above its default except hop and depth, up to their ceilings.
export function clampLimits(raw: LimitOverrides): Limits {
  const limits = { ...limitDefaults };
  for (const key of Object.keys(limitDefaults) as (keyof Limits)[]) {
    const value = raw[key];
    if (value === undefined || !Number.isFinite(value)) continue;
    limits[key] = Math.min(Math.max(Math.floor(value), 0), limitCeilings[key]);
  }
  return limits;
}

function checkChain(limits: Limits, chain: Chain, now: string): Verdict {
  if (chain.hop + 1 > limits.hop) return refuse("hop");
  if (chain.turns >= limits.chainTurns) return refuse("chain_turns");
  if (Date.parse(now) - Date.parse(chain.startedAt) >= limits.chainWallMs) {
    return refuse("chain_time");
  }
  return allow;
}

// The child would sit at hop + 1 and depth + 1. `tasksInRun` is a pre-check: the cap that holds is
// the one `createTask` reserves.
export function checkDelegation(
  limits: Limits,
  input: { chain: Chain; tasksInRun: number; now: string },
): Verdict {
  const chained = checkChain(limits, input.chain, input.now);
  if (chained.verdict === "refuse") return chained;
  if (input.chain.depth + 1 > limits.depth) return refuse("depth");
  if (input.tasksInRun >= limits.fanOut) return refuse("fan_out");
  return allow;
}

// Called once per mentioned bot, in mention order. `mentions` is that bot's 1-based position, so
// bots past the cap are refused. `chain` is null for a human's message, which starts a new chain.
export function checkMentionWake(
  limits: Limits,
  input: { chain: Chain | null; mentions: number; now: string },
): Verdict {
  if (input.mentions > limits.mentions) return refuse("mentions");
  return input.chain ? checkChain(limits, input.chain, input.now) : allow;
}

// The room's round: bot posts since the last human message, and when that count's window opened.
export function checkBotPost(
  limits: Limits,
  input: { botPosts: number; windowStartedAt: string | null; now: string },
): Verdict {
  if (input.windowStartedAt === null) return allow;
  if (Date.parse(input.now) - Date.parse(input.windowStartedAt) >= limits.postWindowMs)
    return allow;
  return input.botPosts >= limits.posts ? refuse("post_budget") : allow;
}

// Milliseconds to hold the wake, 0 for none. A human's input, an approval among it, never waits.
export function noProgressDelay(input: { noProgressRuns: number; source: WakeSource }): number {
  if (input.source === "human" || input.source === "approval" || input.noProgressRuns < 2) return 0;
  return Math.min(2 * minute * 2 ** (input.noProgressRuns - 2), 30 * minute);
}

export function backoffUntil(input: {
  noProgressRuns: number;
  source: WakeSource;
  lastEndedAt: string | null;
  now: string;
}): string | null {
  if (input.lastEndedAt === null) return null;
  const until = Date.parse(input.lastEndedAt) + noProgressDelay(input);
  return until > Date.parse(input.now) ? new Date(until).toISOString() : null;
}

// One tracker per run. Refuses with `repeated_failure` on the 6th identical failing call.
export function trackFailures(): (call: ToolCall) => Verdict {
  let last: string | null = null;
  let count = 0;
  return (call) => {
    if (!call.failed) {
      last = null;
      count = 0;
      return allow;
    }
    const key = JSON.stringify([call.tool, call.input]);
    count = key === last ? count + 1 : 1;
    last = key;
    return count >= 6 ? refuse("repeated_failure") : allow;
  };
}

// Null is the owner. A routine's run creating a routine needs the owner's approval.
export function checkRoutineCreate(input: { source: WakeSource | null }): Verdict {
  return input.source === "routine" ? refuse("routine_approval") : allow;
}
