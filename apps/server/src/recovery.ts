import { ruleFor } from "./broker.ts";

export const continueCap = 3;
export const continueWindowMs = 5 * 60_000;

export type RecoveryVerdict = "continue" | "hold" | "wait" | "fail";

// A run with children out is resumed by their results, and one that acted outside is never run
// again. An effect still `intended` after a crash may or may not have happened, so the run waits
// for a human. A turn is re-run once, and the cap stops a bot whose turns keep killing the server.
export function recoveryVerdict(input: {
  unsettledEffects: number;
  outwardDone: boolean;
  activeChildTasks: number;
  recoveredBefore: boolean;
  continuedAt: readonly string[];
  now: string;
}): RecoveryVerdict {
  if (input.activeChildTasks > 0) {
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

// Engine tools act inside the bot's workspace, so repeating them is safe.
export function outwardTool(tool: string) {
  if (tool.startsWith("mcp__connectors__")) {
    return true;
  }
  const name = tool.startsWith("mcp__bee__") ? tool.slice("mcp__bee__".length) : undefined;
  const labels = name === undefined ? undefined : ruleFor(name)?.labels;
  return labels?.sideEffect === true && (labels.readsUntrusted || name === "send_message");
}
