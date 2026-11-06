import { once } from "node:events";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers/promises";

import type { BotModel, PauseReason } from "@beebot/contracts";
import { z } from "zod";

export type TurnOutcome =
  | { kind: "completed"; text: string }
  | { kind: "failed" }
  | { kind: "limited"; retryAfterMs: number }
  | { kind: "auth_failed"; pauseReason?: PauseReason }
  // The engine no longer has this session: the supervisor restarts from the room digest.
  | { kind: "session_lost" };

export type BotLaunch = {
  botId: string;
  name: string;
  personality: string;
  engineAccountId: string;
  model: BotModel;
  memory: string;
};

export const workspacePath = (dataDir: string, botId: string) =>
  NodePath.join(dataDir, "bots", botId, "workspace");

export type ToolStart = { id: string; name: string; detail: string | null };
export type ThinkingState = { active: boolean; text: string };

// Must settle once `signal` aborts: the supervisor finalizes a run only after its turn has ended.
export type RunTurn = (turn: {
  prompt: string;
  sessionId: string;
  resume: boolean;
  launch: BotLaunch;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  // Called again with the same `id` once the detail is known.
  onToolStart: (tool: ToolStart) => void;
  onToolEnd: (id: string, failed: boolean) => void;
  onThinking: (state: ThinkingState) => void;
  // Where this run asks for tool approval. The token is a secret: never log it or put it on argv.
  permissions: { url: string; token: string };
  // Call once the prompt reached the engine: from then on it must never be sent again.
  onDelivered: () => void;
}) => Promise<TurnOutcome>;

const wordDelayMs = 40;
const workStepMs = 700;
const workSteps: Array<[string, string | null, boolean]> = [
  ["Read", "src/index.ts", false],
  ["Grep", "createServer", false],
  ["Bash", "pnpm test --filter missing", true],
  ["Edit", "src/index.ts", false],
  ["mcp__bee__memory_search", null, false],
];
const workReply = `I checked the entry file and fixed the import.

- Read \`src/index.ts\`
- One test command failed

\`\`\`ts
export const port = 5833;
\`\`\`

Everything else looks fine.`;
const defaultLimitSeconds = 30;

const ToolResult = z.object({
  result: z.object({ content: z.tuple([z.object({ text: z.string() })]) }),
});

// A Map, because a tool name is whatever the engine reports and could be "constructor".
const inputKeys = new Map([
  ["Bash", "command"],
  ["Read", "file_path"],
  ["Write", "file_path"],
  ["Edit", "file_path"],
  ["Glob", "pattern"],
  ["Grep", "pattern"],
]);

const maxDetailChars = 120;

// The whole of what a client may see of a tool's input, and only ever in memory.
export function toolDetail(name: string, input: unknown, cwd: string) {
  const key = inputKeys.get(name);
  const value =
    key && input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const inside = value.startsWith(cwd + NodePath.sep) ? value.slice(cwd.length + 1) : value;
  const line = inside.replace(/\s+/g, " ").trim();
  return line.length > maxDetailChars ? `${line.slice(0, maxDetailChars - 1)}…` : line;
}

type Permissions = { url: string; token: string };

const callTool = ({ url, token }: Permissions, params: unknown, signal: AbortSignal) =>
  fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
    signal,
  });

async function askPermission(
  permissions: Permissions,
  tool: string,
  detail: string,
  signal: AbortSignal,
) {
  const params = {
    name: "approve",
    arguments: {
      tool_name: tool,
      input: { [inputKeys.get(tool) ?? "command"]: detail },
      tool_use_id: "fake",
    },
  };
  const response = await callTool(permissions, params, signal);
  const data = /^data: (.*)$/m.exec(await response.text())?.[1];
  if (data === undefined) {
    return false;
  }
  const { result } = ToolResult.parse(JSON.parse(data));
  return result.content[0].text.startsWith('{"behavior":"allow"');
}

// Memory tools answer as plain JSON, not as the approval stream.
async function proposeMemory(permissions: Permissions, text: string, signal: AbortSignal) {
  const params = { name: "memory_propose", arguments: { text, type: "user" } };
  const response = await callTool(permissions, params, signal);
  return ToolResult.parse(await response.json()).result.content[0].text;
}

// The last line of the prompt scripts the turn: /fail, /auth, /limit [seconds], /hang,
// /approve <Tool> <detail...>, /remember <text...>, /work [thought] (a scripted multi-tool turn).
// Anything else streams a reply word by word.
export const fakeRunTurn: RunTurn = async ({
  prompt,
  signal,
  onDelta,
  onToolStart,
  onToolEnd,
  onThinking,
  permissions,
}) => {
  const line = (prompt.split("\n").at(-1) ?? "").trim();
  const [directive, argument] = line.split(/\s+/);
  switch (directive) {
    case "/fail":
      return { kind: "failed" };
    case "/auth":
      return { kind: "auth_failed" };
    case "/limit":
      return { kind: "limited", retryAfterMs: (Number(argument) || defaultLimitSeconds) * 1000 };
    case "/hang":
      if (!signal.aborted) {
        await once(signal, "abort");
      }
      return { kind: "failed" };
    case "/approve": {
      const [, tool = "", detail = ""] = /^\S+\s+(\S+)\s*(.*)$/.exec(line) ?? [];
      onToolStart({ id: "fake-approve", name: tool, detail: detail || null });
      const allowed = await askPermission(permissions, tool, detail, signal);
      onToolEnd("fake-approve", !allowed);
      const text = `Test engine: ${allowed ? "allowed" : "denied"}`;
      onDelta(text);
      return { kind: "completed", text };
    }
    case "/remember": {
      onToolStart({ id: "fake-remember", name: "mcp__bee__memory_propose", detail: null });
      const text = await proposeMemory(permissions, line.replace(/^\S+\s*/, ""), signal);
      onToolEnd("fake-remember", false);
      onDelta(text);
      return { kind: "completed", text };
    }
    case "/work": {
      onThinking({
        active: true,
        text: argument === "thought" ? "Looking at the files first." : "",
      });
      await NodeTimers.setTimeout(workStepMs, undefined, { signal });
      onThinking({ active: false, text: "" });
      for (const [index, [name, detail, failed]] of workSteps.entries()) {
        onToolStart({ id: `fake-${index}`, name, detail });
        await NodeTimers.setTimeout(workStepMs, undefined, { signal });
        onToolEnd(`fake-${index}`, failed);
      }
      for (const word of workReply.split(/(?<=\s)/)) {
        await NodeTimers.setTimeout(wordDelayMs, undefined, { signal });
        onDelta(word);
      }
      return { kind: "completed", text: workReply };
    }
    default: {
      const text = `Test engine reply: ${prompt}`;
      for (const word of text.split(/(?<=\s)/)) {
        await NodeTimers.setTimeout(wordDelayMs, undefined, { signal });
        onDelta(word);
      }
      return { kind: "completed", text };
    }
  }
};
