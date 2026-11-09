import type * as NodeHttp from "node:http";

import { z } from "zod";

import type { Decision } from "./approvals.ts";
import { botToolNames, botTools } from "./botTools.ts";
import { browserToolNames, browserTools, takeoverTool } from "./browser.ts";
import { computerToolNames, computerTools, type ToolContent } from "./computer.ts";
import { memoryTools } from "./memory.ts";

const defaultKeepaliveMs = 15_000;

const tools = [
  {
    name: "approve",
    description: "Asks the owner whether a tool call may run.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
      },
      required: ["tool_name", "input"],
    },
  },
  ...memoryTools,
  ...botTools,
  ...browserTools,
  takeoverTool,
  ...computerTools,
];
const memoryNames = new Set(memoryTools.map(({ name }) => name));

const Rpc = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z
    .object({
      protocolVersion: z.unknown().optional(),
      name: z.unknown().optional(),
      arguments: z.unknown().optional(),
    })
    .optional(),
});

export function sendJson(response: NodeHttp.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function parseRpc(text: string) {
  try {
    return Rpc.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

// The CLI gives up on a plain JSON answer at 60 s, and a card can wait 5 minutes.
async function streamToolCall(
  response: NodeHttp.ServerResponse,
  id: string | number,
  approve: (closed: AbortSignal) => Promise<Decision>,
  keepaliveMs: number,
) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
  response.flushHeaders();
  const beat = setInterval(() => response.write(": keepalive\n\n"), keepaliveMs);
  const closed = new AbortController();
  response.once("close", () => {
    clearInterval(beat);
    closed.abort();
  });
  const decision = await approve(closed.signal).catch((): Decision => ({
    behavior: "deny",
    message: "Refused: the request could not be checked.",
  }));
  clearInterval(beat);
  const result = { content: [{ type: "text", text: JSON.stringify(decision) }] };
  response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
}

export async function answerMcp(
  response: NodeHttp.ServerResponse,
  body: string,
  approve: (args: unknown, closed: AbortSignal) => Promise<Decision>,
  memory: (name: string, args: unknown) => string,
  bot: (name: string, args: unknown) => string,
  browser: (name: string, args: unknown) => Promise<string>,
  computer: (name: string, args: unknown) => Promise<ToolContent[]>,
  keepaliveMs = defaultKeepaliveMs,
) {
  const rpc = parseRpc(body);
  if (!rpc) {
    const error = { code: -32600, message: "Invalid request" };
    sendJson(response, 400, { jsonrpc: "2.0", id: null, error });
    return;
  }
  const { id, method, params } = rpc;
  if (id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const answer = (result: unknown) => sendJson(response, 200, { jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      answer({
        protocolVersion: params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "bee", version: "1" },
      });
      return;
    case "tools/list":
      answer({ tools });
      return;
    case "ping":
      answer({});
      return;
    case "tools/call": {
      if (typeof params?.name === "string" && memoryNames.has(params.name)) {
        let text: string;
        try {
          text = memory(params.name, params.arguments);
        } catch (error) {
          // The kind only, here and in the answer: the error can quote memory text.
          console.error(`beebotd: memory tool failed: ${(error as Error)?.name}`);
          text = "Memory is unavailable right now.";
        }
        answer({ content: [{ type: "text", text }] });
        return;
      }
      if (typeof params?.name === "string" && botToolNames.has(params.name)) {
        let text: string;
        try {
          text = bot(params.name, params.arguments);
        } catch (error) {
          console.error(`beebotd: bot tool ${params.name} failed: ${(error as Error)?.name}`);
          text = "This tool is unavailable right now.";
        }
        answer({ content: [{ type: "text", text }] });
        return;
      }
      if (typeof params?.name === "string" && browserToolNames.has(params.name)) {
        let text: string;
        try {
          text = await browser(params.name, params.arguments);
        } catch (error) {
          console.error(`beebotd: browser tool ${params.name} failed: ${(error as Error)?.name}`);
          text = "The browser is unavailable right now.";
        }
        answer({ content: [{ type: "text", text }] });
        return;
      }
      if (typeof params?.name === "string" && computerToolNames.has(params.name)) {
        let content: ToolContent[];
        try {
          content = await computer(params.name, params.arguments);
        } catch (error) {
          console.error(`beebotd: computer tool ${params.name} failed: ${(error as Error)?.name}`);
          content = [{ type: "text", text: "The computer is unavailable right now." }];
        }
        answer({ content });
        return;
      }
      const args = params?.name === "approve" ? params.arguments : undefined;
      await streamToolCall(response, id, (closed) => approve(args, closed), keepaliveMs);
      return;
    }
    default: {
      const error = { code: -32601, message: "Method not found" };
      sendJson(response, 200, { jsonrpc: "2.0", id, error });
    }
  }
}
