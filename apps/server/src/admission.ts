import type { Bot, RunReason } from "@beebot/contracts";

export const dailyRunCap = 100;

type Admission = {
  attended: boolean;
  botStatus: Bot["status"];
  runsInLastDay: number;
  blockedUntil: string | null;
  now: string;
};

type Decision =
  | { verdict: "admit" }
  | { verdict: "refuse"; reason: RunReason }
  | { verdict: "defer"; until: string };

// Concurrency 1 per account is not decided here: a Queued run simply isn't claimable yet.
export function admit({ attended, botStatus, runsInLastDay, blockedUntil, now }: Admission) {
  let decision: Decision = { verdict: "admit" };
  // Boxes don't exist yet, so every unattended wake is outside one.
  if (!attended) {
    decision = { verdict: "refuse", reason: "unattended" };
  } else if (botStatus === "paused") {
    decision = { verdict: "refuse", reason: "bot_paused" };
  } else if (runsInLastDay >= dailyRunCap) {
    decision = { verdict: "refuse", reason: "daily_cap" };
  } else if (blockedUntil !== null && blockedUntil > now) {
    decision = { verdict: "defer", until: blockedUntil };
  }
  return decision;
}
