import type { Bot, EngineLane, RunReason } from "@beebot/contracts";

export const dailyRunCap = 100;

type Admission = {
  attended: boolean;
  // `unavailable`: the bot's boundary is a box, but no box runtime can run one now.
  box: "none" | "unavailable" | "ready";
  // R7: the lane an unattended run may use, or null when the owner allowed none.
  unattendedLane: EngineLane | null;
  botStatus: Bot["status"];
  runsInLastDay: number;
  blockedUntil: string | null;
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

// Concurrency 1 per account is not decided here: a Queued run simply isn't claimable yet.
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
  } else if (blockedUntil !== null && blockedUntil > now) {
    decision = { verdict: "defer", until: blockedUntil };
  }
  return decision;
}
