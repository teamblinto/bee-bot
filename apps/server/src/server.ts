import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Duplex } from "node:stream";

import {
  type Bot,
  type Bootstrap,
  ClientMessage,
  Command,
  defaultBotModel,
  type Effort,
  type EngineModel,
  EngineStatus,
  type ModelCatalog,
  type ProtocolNotice,
  protocolVersion,
  type ServerMessage,
  usageDays,
  type UsageRefreshResult,
} from "@beebot/contracts";
import { type WebSocket, WebSocketServer } from "ws";

import { createApprovals } from "./approvals.ts";
import { staticClaudeModels } from "./claude.ts";
import { fakeRunTurn, type RunTurn, workspacePath } from "./engine.ts";
import { answerMcp, sendJson } from "./mcp.ts";
import { callMemoryTool } from "./memory.ts";
import type { EventStore } from "./store.ts";
import { createSupervisor } from "./supervisor.ts";
import {
  createLimitRefresher,
  createUsageHistory,
  projectFolder,
  type UsageProbe,
} from "./usage.ts";

const maxBodyBytes = 256 * 1024;
// A `Write` call carries the whole file.
const maxMcpBodyBytes = 16 * 1024 * 1024;

type Options = Pick<Bootstrap, "port" | "token" | "dataDir" | "allowedOrigins" | "fakeEngine"> & {
  store: EventStore;
  probeEngine: () => Promise<EngineStatus>;
  runTurn?: RunTurn;
  probeUsage?: ((onModels: (models: EngineModel[]) => void) => Promise<UsageProbe>) | undefined;
  // Where Claude Code keeps its transcripts.
  projectsDir?: string | undefined;
  usageRefreshGapMs?: number | undefined;
  turnTimeoutMs?: number | undefined;
  approvalTimeoutMs?: number | undefined;
  mcpKeepaliveMs?: number | undefined;
};

function refuseUpgrade(socket: Duplex, status: number, body: unknown) {
  const text = JSON.stringify(body);
  socket.end(
    `HTTP/1.1 ${status} ${NodeHttp.STATUS_CODES[status]}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(text)}\r\n` +
      "Connection: close\r\n\r\n" +
      text,
  );
}

function send(socket: WebSocket, message: ServerMessage) {
  socket.send(JSON.stringify(message));
}

function parseClientMessage(text: string) {
  try {
    return ClientMessage.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

// Past the cap the stream is still drained: abandoning it would destroy the socket and the answer.
async function readBody(request: NodeHttp.IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= maxBytes) {
      chunks.push(chunk);
    }
  }
  return size <= maxBytes ? Buffer.concat(chunks).toString() : undefined;
}

function parseCommand(text: string | undefined) {
  try {
    return Command.safeParse(JSON.parse(text ?? "")).data;
  } catch {
    return undefined;
  }
}

function logUsageFailure(error: unknown) {
  console.error(`beebotd: usage check failed: ${(error as Error)?.name}`);
}

export async function startServer({
  port,
  token,
  dataDir,
  allowedOrigins,
  fakeEngine = false,
  store,
  probeEngine,
  runTurn = fakeRunTurn,
  probeUsage,
  projectsDir = NodePath.join(NodeOS.homedir(), ".claude", "projects"),
  usageRefreshGapMs,
  turnTimeoutMs,
  approvalTimeoutMs,
  mcpKeepaliveMs,
}: Options) {
  const expectedToken = Buffer.from(token);
  const subscribers = new Set<WebSocket>();
  let claudeModels = staticClaudeModels;

  const catalog = (): ModelCatalog => ({
    claude: claudeModels,
    ...(fakeEngine && { fake: staticClaudeModels }),
  });
  const modelsOf = (accountId: string) =>
    accountId === "claude" ? claudeModels : staticClaudeModels;

  function setClaudeModels(models: EngineModel[]) {
    if (JSON.stringify(models) !== JSON.stringify(claudeModels)) {
      claudeModels = models;
      broadcast({ type: "model-catalog", models: catalog() });
    }
  }

  // A saved model that left the catalog is still the bot's: only a change to one is refused.
  function engineChoice(
    bot: Pick<Bot, "model" | "effort" | "engineAccountId">,
    change: {
      engineAccountId?: string | undefined;
      model?: string | undefined;
      effort?: Effort | null | undefined;
    },
  ) {
    if (change.engineAccountId && change.engineAccountId !== bot.engineAccountId) {
      return { refused: { status: 409, body: { code: "provider_locked" } } };
    }
    const model = change.model ?? bot.model;
    const entry = modelsOf(bot.engineAccountId).find(({ id }) => id === model);
    if (!entry && model !== bot.model) {
      return { refused: { status: 400, body: { code: "unknown_model" } } };
    }
    if (change.effort && !entry?.efforts.includes(change.effort)) {
      return { refused: { status: 400, body: { code: "unsupported_effort" } } };
    }
    // Moving to a model without the current level leaves the choice to the CLI.
    const kept = bot.effort && entry?.efforts.includes(bot.effort) ? bot.effort : null;
    return { model, effort: change.effort === undefined ? kept : change.effort };
  }

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  function broadcast(message: ServerMessage) {
    for (const subscriber of subscribers) {
      send(subscriber, message);
    }
  }

  // The boot's index rebuild emits nothing, so a cursor from before it can't be caught up by replay.
  const bootSeq = store.bounds().latest;
  store.onEvent((event) => broadcast({ type: "event", event }));
  const approvals = createApprovals({
    store,
    dataDir,
    timeoutMs: approvalTimeoutMs,
    onChange: () => {
      broadcast({ type: "pending-approvals", approvals: approvals.pending() });
      supervisor.syncClocks();
    },
  });
  const supervisor = createSupervisor({
    store,
    runTurn,
    approvals,
    permissionsUrl: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    turnTimeoutMs,
    onDelta: (runId, text) => broadcast({ type: "delta", runId, text }),
    onToolStart: (runId, { id, name, detail }) =>
      broadcast({ type: "tool-start", runId, toolId: id, name, detail }),
    onToolEnd: (runId, toolId, failed) => broadcast({ type: "tool-end", runId, toolId, failed }),
    onThinking: (runId, { active, text }) => broadcast({ type: "thinking", runId, active, text }),
    onRateLimit: (accountId, updates) => store.mergeUsage(accountId, updates),
    onTurnEnded: (accountId) => void limits.refresh(accountId).catch(logUsageFailure),
    accountHeld: (accountId) => limits.isProbing(accountId),
  });
  const limits = createLimitRefresher({
    store,
    probe: probeUsage && (() => probeUsage(setClaudeModels)),
    minGapMs: usageRefreshGapMs,
    onSettled: () => supervisor.pump(),
  });
  const history = createUsageHistory(projectsDir);

  // Non-browser clients send no Origin; they still need the token.
  const originAllowed = (origin: string | undefined) =>
    origin === undefined || allowedOrigins.includes(origin);

  function tokenMatches(presented: string | null | undefined) {
    const candidate = Buffer.from(presented ?? "");
    return (
      candidate.length === expectedToken.length &&
      NodeCrypto.timingSafeEqual(candidate, expectedToken)
    );
  }

  function refusal(
    origin: string | undefined,
    presentedToken: string | null | undefined,
    url: URL,
  ) {
    if (!originAllowed(origin)) {
      return { status: 403, body: { code: "origin_refused" } };
    }
    if (!tokenMatches(presentedToken)) {
      return { status: 401, body: { code: "unauthorized" } };
    }
    const clientVersion = url.searchParams.get("protocolVersion");
    if (clientVersion !== String(protocolVersion)) {
      const notice: ProtocolNotice = {
        code: "protocol_mismatch",
        message: `This client speaks protocol ${clientVersion ?? "(none)"}, but the Bee Bot server speaks ${protocolVersion}. Update Bee Bot so both match.`,
        serverProtocolVersion: protocolVersion,
      };
      return { status: 426, body: notice };
    }
    return undefined;
  }

  function catchUp(afterSeq: number): ServerMessage {
    const { oldest, latest } = store.bounds();
    // Covers cursor 0 too: an empty client, and rows like the seeded account have no event.
    if (afterSeq <= bootSeq || afterSeq < oldest - 1 || afterSeq > latest) {
      return { type: "snapshot", seq: latest, state: store.state() };
    }
    return { type: "replay", events: store.eventsAfter(afterSeq) };
  }

  function runCommand(command: Command) {
    const notFound = { status: 404, body: { code: "not_found" } };
    const ok = { status: 200, body: { ok: true } };
    // shortcut: any open client counts, not the sender's own. Tie it to the sender once a token can
    // be held by something other than the owner's own clients.
    const attended = subscribers.size > 0;
    switch (command.type) {
      case "create-bot": {
        const { name, personality, engineAccountId = "claude", model = defaultBotModel } = command;
        if (engineAccountId === "fake" && !fakeEngine) {
          return { status: 403, body: { code: "engine_not_allowed" } };
        }
        if (!modelsOf(engineAccountId).some(({ id }) => id === model)) {
          return { status: 400, body: { code: "unknown_model" } };
        }
        const bot = store.createBot({ name, personality, engineAccountId, model });
        return { status: 200, body: bot };
      }
      case "update-bot": {
        const { botId, name, personality } = command;
        const current = store.getBot(botId);
        if (!current) {
          return notFound;
        }
        const choice = engineChoice(current, command);
        if (choice.refused) {
          return choice.refused;
        }
        const { model, effort } = choice;
        return { status: 200, body: store.updateBot(botId, { name, personality, model, effort }) };
      }
      case "set-bot-engine": {
        const current = store.getBot(command.botId);
        if (!current) {
          return notFound;
        }
        const choice = engineChoice(current, command);
        if (choice.refused) {
          return choice.refused;
        }
        const { model, effort } = choice;
        const { mode = current.mode, access = current.access } = command;
        const bot = store.setBotEngine(command.botId, { model, effort, mode, access });
        return { status: 200, body: bot };
      }
      case "set-bot-paused": {
        const bot = store.setBotPause(command.botId, command.paused ? "owner" : null);
        return bot ? { status: 200, body: bot } : notFound;
      }
      case "send-message": {
        const { messageId: id, roomId, body } = command;
        const result = store.sendMessage({ id, roomId, body, attended });
        if (result === "not_found") {
          return notFound;
        }
        return result === "conflict" ? { status: 409, body: { code: "message_id_reused" } } : ok;
      }
      case "stop-bot":
        supervisor.stopBot(command.botId);
        return ok;
      case "stop-all":
        supervisor.stopAll();
        return ok;
      case "continue-run": {
        const result = store.continueRun(command.runId, attended);
        if (result === "not_found") {
          return notFound;
        }
        return result === "continued" ? ok : { status: 409, body: { code: result } };
      }
      case "decide-approval":
        return approvals.decide(command);
      case "acknowledge-notice":
        store.acknowledgeNotice();
        return ok;
      case "add-memory": {
        const { botId, text, memoryType: type, supersedes } = command;
        const memory = store.addMemory({ botId, text, type, supersedes });
        return memory ? { status: 200, body: memory } : notFound;
      }
      case "decide-memory":
        return store.decideMemory(command.memoryId, command.decision) ? ok : notFound;
      case "forget-memory":
        return store.forgetMemory(command.memoryId) ? ok : notFound;
    }
  }

  async function handleCommand(
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) {
    const command = parseCommand(await readBody(request, maxBodyBytes));
    if (!command) {
      sendJson(response, 400, { code: "bad_request" });
      return;
    }
    try {
      const { status, body } = runCommand(command);
      sendJson(response, status, body);
      supervisor.pump();
    } catch (error) {
      console.error(error);
      sendJson(response, 500, { code: "storage_failed" });
    }
  }

  // The CLI is the only caller, so an Origin means a browser is trying its luck.
  async function handleMcp(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    if (request.headers.origin !== undefined) {
      sendJson(response, 403, { code: "origin_refused" });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { code: "method_not_allowed" });
      return;
    }
    const run = approvals.authenticate(request.headers.authorization?.replace(/^Bearer /, ""));
    if (!run) {
      sendJson(response, 401, { code: "unauthorized" });
      return;
    }
    const body = await readBody(request, maxMcpBodyBytes);
    if (body === undefined) {
      sendJson(response, 413, { code: "too_large" });
      return;
    }
    await answerMcp(
      response,
      body,
      (args, closed) => approvals.approve(run, args, closed),
      (name, args) => callMemoryTool(store, run, name, args),
      mcpKeepaliveMs,
    );
  }

  async function handleEngine(response: NodeHttp.ServerResponse) {
    try {
      const status = EngineStatus.parse(await probeEngine());
      if (status.pauseReason) {
        store.pauseReadyBots("claude", status.pauseReason);
      } else {
        store.clearEnginePauses("claude");
      }
      sendJson(response, 200, status);
    } catch (error) {
      console.error(`beebotd: engine check failed: ${(error as Error)?.name}`);
      sendJson(response, 500, { code: "engine_check_failed" });
    }
  }

  async function handleUsage(url: URL, response: NodeHttp.ServerResponse) {
    const days = Number(url.searchParams.get("days"));
    if (!usageDays.some((allowed) => allowed === days)) {
      sendJson(response, 400, { code: "bad_request" });
      return;
    }
    const folders = store
      .botIds()
      .map((id): [string, string] => [projectFolder(workspacePath(dataDir, id)), id]);
    sendJson(response, 200, await history.summary(days, new Map(folders)));
  }

  async function handleRefreshLimits(response: NodeHttp.ServerResponse) {
    const outcome = await limits.refresh("claude");
    sendJson(response, 200, { outcome } satisfies UsageRefreshResult);
  }

  const server = NodeHttp.createServer((request, response) => {
    const url = URL.parse(request.url ?? "", "http://127.0.0.1");
    if (!url) {
      sendJson(response, 400, { code: "bad_request" });
      return;
    }

    if (url.pathname === "/mcp") {
      handleMcp(request, response).catch(() => response.destroy());
      return;
    }

    const { origin } = request.headers;
    if (origin !== undefined && originAllowed(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS" && originAllowed(origin)) {
      // Preflights carry no credentials, so the token check can't apply here.
      response.setHeader("Access-Control-Allow-Methods", "GET, POST");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.writeHead(204).end();
      return;
    }

    const refused = refusal(origin, request.headers.authorization?.replace(/^Bearer /, ""), url);
    if (refused) {
      sendJson(response, refused.status, refused.body);
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
    } else if (request.method === "GET" && url.pathname === "/state") {
      try {
        sendJson(response, 200, { seq: store.bounds().latest, state: store.state() });
      } catch (error) {
        console.error(error);
        sendJson(response, 500, { code: "storage_failed" });
      }
    } else if (request.method === "GET" && url.pathname === "/engine") {
      void handleEngine(response);
    } else if (request.method === "GET" && url.pathname === "/usage") {
      handleUsage(url, response).catch(() => sendJson(response, 200, { status: "unavailable" }));
    } else if (request.method === "POST" && url.pathname === "/usage/limits") {
      handleRefreshLimits(response).catch((error: unknown) => {
        logUsageFailure(error);
        sendJson(response, 500, { code: "storage_failed" });
      });
    } else if (request.method === "POST" && url.pathname === "/commands") {
      handleCommand(request, response).catch(() => response.destroy());
    } else {
      sendJson(response, 404, { code: "not_found" });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    const url = URL.parse(request.url ?? "", "http://127.0.0.1");
    if (url?.pathname !== "/ws") {
      refuseUpgrade(socket, 404, { code: "not_found" });
      return;
    }
    // Browsers can't set headers on a WebSocket, so the token rides in the query.
    const refused = refusal(request.headers.origin, url.searchParams.get("token"), url);
    if (refused) {
      refuseUpgrade(socket, refused.status, refused.body);
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      client.on("error", () => client.terminate());
      client.on("close", () => subscribers.delete(client));
      client.on("message", (data) => {
        const message = parseClientMessage(data.toString());
        if (!message) {
          client.close(1008, "invalid message");
          return;
        }
        // Store reads and broadcasts are synchronous, so no event can slip between this replay
        // and joining subscribers.
        try {
          send(client, catchUp(message.afterSeq));
          send(client, { type: "pending-approvals", approvals: approvals.pending() });
          send(client, { type: "model-catalog", models: catalog() });
          subscribers.add(client);
        } catch (error) {
          console.error(error);
          client.close(1011, "storage failed");
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  supervisor.pump();

  return {
    port: (server.address() as AddressInfo).port,
    // Fills the model catalog too, so the first picker shows what the CLI offers.
    refreshLimits: () => void limits.refresh("claude").catch(logUsageFailure),
    close: async () => {
      approvals.close();
      await supervisor.close();
      for (const client of sockets.clients) {
        client.terminate();
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
