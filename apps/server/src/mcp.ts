import type * as NodeHttp from "node:http";

import type { BotControl } from "@beebot/contracts";
import { z } from "zod";

import type { Decision } from "./approvals.ts";
import { botToolNames, botTools } from "./botTools.ts";
import { browserToolNames, browserTools, takeoverTool } from "./browser.ts";
import {
  boxScreen,
  computerToolNames,
  computerTools,
  type ScreenSize,
  type ToolContent,
} from "./computer.ts";
import { cuaToolNames, cuaTools } from "./cuaScreen.ts";
import { memoryTools } from "./memory.ts";

const defaultKeepaliveMs = 15_000;

type Tool = { name: string; description: string; inputSchema: object };

const approveTool = {
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
};

// The tools a bot sees follow its control mode, so it never reaches for a screen it lacks. Each
// call is still checked against the mode by the broker. A host bot gets the cua tools when
// cua-driver runs, and the pointer-moving ones sized to the display otherwise.
export function toolsFor(control: BotControl, screen: ScreenSize | "cua" | undefined): Tool[] {
  const browsing = control === "browser" || control === "computer";
  return [
    approveTool,
    ...memoryTools,
    ...botTools,
    ...(browsing ? [...browserTools, takeoverTool] : []),
    ...(control === "computer" ? computerTools(boxScreen, "box") : []),
    ...(control === "host" && screen === "cua" ? cuaTools : []),
    ...(control === "host" && typeof screen === "object" ? computerTools(screen, "host") : []),
  ];
}

export type McpHandlers = {
  approve: (args: unknown, closed: AbortSignal) => Promise<Decision>;
  memory: (name: string, args: unknown) => string;
  bot: (name: string, args: unknown) => string | Promise<string>;
  browser: (name: string, args: unknown) => Promise<string>;
  computer: (name: string, args: unknown) => Promise<ToolContent[]>;
  tools: () => Promise<Tool[]>;
};
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
async function streamResult(
  response: NodeHttp.ServerResponse,
  id: string | number,
  produce: (closed: AbortSignal) => Promise<unknown>,
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
  const result = await produce(closed.signal);
  clearInterval(beat);
  response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
}

const textResult = (text: string) => ({ content: [{ type: "text", text }] });

function streamToolCall(
  response: NodeHttp.ServerResponse,
  id: string | number,
  approve: (closed: AbortSignal) => Promise<Decision>,
  keepaliveMs: number,
) {
  return streamResult(
    response,
    id,
    async (closed) => {
      const decision = await approve(closed).catch((): Decision => ({
        behavior: "deny",
        message: "Refused: the request could not be checked.",
      }));
      return textResult(JSON.stringify(decision));
    },
    keepaliveMs,
  );
}

export async function answerMcp(
  response: NodeHttp.ServerResponse,
  body: string,
  { approve, memory, bot, browser, computer, tools }: McpHandlers,
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
      answer({ tools: await tools() });
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
          text = await bot(params.name, params.arguments);
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
      if (
        typeof params?.name === "string" &&
        (computerToolNames.has(params.name) || cuaToolNames.has(params.name))
      ) {
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

export type ConnectorHandlers = {
  tools: () => Promise<Tool[]>;
  call: (name: string, args: unknown, closed: AbortSignal) => Promise<string>;
};

// The `connectors` server: outside apps' tools, which beebotd calls on the bot's behalf. The list
// and every call read the run's grants afresh.
export async function answerConnectors(
  response: NodeHttp.ServerResponse,
  body: string,
  { tools, call }: ConnectorHandlers,
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
        serverInfo: { name: "connectors", version: "1" },
      });
      return;
    case "tools/list":
      answer({ tools: await tools() });
      return;
    case "ping":
      answer({});
      return;
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      await streamResult(
        response,
        id,
        async (closed) =>
          textResult(
            await call(name, params?.arguments, closed).catch((error: unknown) => {
              console.error(`beebotd: connector tool failed: ${(error as Error)?.name}`);
              return "This app is unavailable right now.";
            }),
          ),
        keepaliveMs,
      );
      return;
    }
    default: {
      const error = { code: -32601, message: "Method not found" };
      sendJson(response, 200, { jsonrpc: "2.0", id, error });
    }
  }
}
