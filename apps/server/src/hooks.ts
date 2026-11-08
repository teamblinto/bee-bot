import type * as NodeHttp from "node:http";

import { z } from "zod";

import type { Decision } from "./approvals.ts";
import { sendJson } from "./mcp.ts";

// Bee's own tools are checked where they run, on /mcp, so the hook leaves them to the CLI's
// allowlist.
const beeToolPrefix = "mcp__bee__";

const HookInput = z.object({
  hook_event_name: z.literal("PreToolUse"),
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string().optional(),
});

function parseHook(text: string) {
  try {
    return HookInput.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

// Claude Code's PreToolUse answer. A call that now waits on the owner is a deny that says so (R17):
// the bot ends its turn, and the outcome resumes the session.
export function hookAnswer(decision: Decision) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.behavior,
      permissionDecisionReason:
        decision.behavior === "allow" ? "Bee's broker allowed this call." : decision.message,
    },
  };
}

const unreadable: Decision = { behavior: "deny", message: "Refused: Bee couldn't read this call." };

export async function answerPreToolUse(
  response: NodeHttp.ServerResponse,
  body: string,
  approve: (args: unknown, closed: AbortSignal) => Promise<Decision>,
) {
  const input = parseHook(body);
  if (input?.tool_name.startsWith(beeToolPrefix)) {
    sendJson(response, 200, {});
    return;
  }
  const closed = new AbortController();
  response.once("close", () => closed.abort());
  const decision = input
    ? await approve(
        { tool_name: input.tool_name, input: input.tool_input, tool_use_id: input.tool_use_id },
        closed.signal,
      ).catch((): Decision => ({
        behavior: "deny",
        message: "Refused: the call could not be checked.",
      }))
    : unreadable;
  sendJson(response, 200, hookAnswer(decision));
}
