export const continueCap = 3;
export const continueWindowMs = 5 * 60_000;

// An effect still `intended` after a crash may or may not have happened, so the run waits for a
// human. The cap stops a turn that keeps killing the server from looping.
export function recoveryVerdict(input: {
  unsettledEffects: number;
  continuedAt: readonly string[];
  now: string;
}) {
  if (input.unsettledEffects > 0) {
    return "hold";
  }
  const since = Date.parse(input.now) - continueWindowMs;
  const recent = input.continuedAt.filter((at) => Date.parse(at) > since).length;
  return recent < continueCap ? "continue" : "hold";
}
