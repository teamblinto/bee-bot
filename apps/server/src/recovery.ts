export const continueCap = 3;
export const continueWindowMs = 5 * 60_000;

export type RecoveryVerdict = "continue" | "hold" | "wait" | "fail";

// A run with children out or a wait holding its task is resumed by them. A run that did something
// it can't repeat, or was cut twice, is never run again. An effect still `intended` may or may not
// have happened, so the run waits for a human. The cap stops a bot whose turns keep killing the server.
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

// Repeating only these is safe: they read, a restart releases takeovers, and a repeated share
// leaves an orphan attachment at worst. A re-run is a new run, so any other Bee Bot tool would act twice.
const repeatableBeeTools = new Set([
  "task_status",
  "read_bot_activity",
  "memory_search",
  "memory_get",
  "browser_snapshot",
  "computer_screenshot",
  "computer_windows",
  "computer_look",
  "computer_desktop",
  "request_takeover",
  "share_file",
]);

// Engine tools act inside the bot's workspace, so repeating them is safe.
export function outwardTool(tool: string) {
  if (tool.startsWith("mcp__connectors__")) {
    return true;
  }
  return tool.startsWith("mcp__bee__") && !repeatableBeeTools.has(tool.slice("mcp__bee__".length));
}
