import { ruleFor } from "./broker.ts";

export const continueCap = 3;
export const continueWindowMs = 5 * 60_000;

export type RecoveryVerdict = "continue" | "hold" | "wait" | "fail";

// A run with children out or a wait holding its task is resumed by them, and one that already did
// something it can't repeat is never run again. An effect still `intended` after a crash may or may not have happened, so the run waits
// for a human. A turn is re-run once, and the cap stops a bot whose turns keep killing the server.
export function recoveryVerdict(input: {
  unsettledEffects: number;
  outwardDone: boolean;
  activeChildTasks: number;
  taskHeld: boolean;
  recoveredBefore: boolean;
  continuedAt: readonly string[];
  now: string;
}): RecoveryVerdict {
  if (input.activeChildTasks > 0 || input.taskHeld) {
    return "wait";
  }
  if (input.outwardDone || input.recoveredBefore) {
    return "fail";
  }
  if (input.unsettledEffects > 0) {
    return "hold";
  }
  const since = Date.parse(input.now) - continueWindowMs;
  const recent = input.continuedAt.filter((at) => Date.parse(at) > since).length;
  return recent < continueCap ? "continue" : "hold";
}

// Engine tools act inside the bot's workspace, so repeating them is safe. A Bee Bot tool that acts
// dedupes by run id, and a re-run is a new run, so repeating it would do it twice.
export function outwardTool(tool: string) {
  if (tool.startsWith("mcp__connectors__")) {
    return true;
  }
  const name = tool.startsWith("mcp__bee__") ? tool.slice("mcp__bee__".length) : undefined;
  return name === "notify" || (name !== undefined && ruleFor(name)?.labels.sideEffect === true);
}
