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
};

export const workspacePath = (dataDir: string, botId: string) =>
  NodePath.join(dataDir, "bots", botId, "workspace");

// Must settle once `signal` aborts: the supervisor finalizes a run only after its turn has ended.
export type RunTurn = (turn: {
  prompt: string;
  sessionId: string;
  resume: boolean;
  launch: BotLaunch;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onTool: (name: string) => void;
  // Where this run asks for tool approval. The token is a secret: never log it or put it on argv.
  permissions: { url: string; token: string };
  // Call once the prompt reached the engine: from then on it must never be sent again.
  onDelivered: () => void;
}) => Promise<TurnOutcome>;

const wordDelayMs = 40;
const defaultLimitSeconds = 30;

const ToolResult = z.object({
  result: z.object({ content: z.tuple([z.object({ text: z.string() })]) }),
});

const inputKeys: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Glob: "pattern",
  Grep: "pattern",
};

async function askPermission(
  { url, token }: { url: string; token: string },
  tool: string,
  detail: string,
  signal: AbortSignal,
) {
  const params = {
    name: "approve",
    arguments: {
      tool_name: tool,
      input: { [inputKeys[tool] ?? "command"]: detail },
      tool_use_id: "fake",
    },
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
    signal,
  });
  const data = /^data: (.*)$/m.exec(await response.text())?.[1];
  if (data === undefined) {
    return false;
  }
  const { result } = ToolResult.parse(JSON.parse(data));
  return result.content[0].text.startsWith('{"behavior":"allow"');
}

// The last line of the prompt scripts the turn: /fail, /auth, /limit [seconds], /hang,
// /approve <Tool> <detail...>. Anything else streams a reply word by word.
export const fakeRunTurn: RunTurn = async ({ prompt, signal, onDelta, onTool, permissions }) => {
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
      onTool(tool);
      const allowed = await askPermission(permissions, tool, detail, signal);
      const text = `Test engine: ${allowed ? "allowed" : "denied"}`;
      onDelta(text);
      return { kind: "completed", text };
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
