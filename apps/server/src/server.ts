import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import {
  type Bootstrap,
  ClientMessage,
  Command,
  type ProtocolNotice,
  protocolVersion,
  type ServerMessage,
} from "@beebot/contracts";
import { type WebSocket, WebSocketServer } from "ws";

import { fakeRunTurn, type RunTurn } from "./engine.ts";
import type { EventStore } from "./store.ts";
import { createSupervisor } from "./supervisor.ts";

const maxBodyBytes = 256 * 1024;

type Options = Pick<Bootstrap, "port" | "token" | "allowedOrigins" | "fakeEngine"> & {
  store: EventStore;
  runTurn?: RunTurn;
  turnTimeoutMs?: number | undefined;
};

function sendJson(response: NodeHttp.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

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
async function readBody(request: NodeHttp.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= maxBodyBytes) {
      chunks.push(chunk);
    }
  }
  return size <= maxBodyBytes ? Buffer.concat(chunks).toString() : undefined;
}

function parseCommand(text: string | undefined) {
  try {
    return Command.safeParse(JSON.parse(text ?? "")).data;
  } catch {
    return undefined;
  }
}

export async function startServer({
  port,
  token,
  allowedOrigins,
  fakeEngine = false,
  store,
  runTurn = fakeRunTurn,
  turnTimeoutMs,
}: Options) {
  const expectedToken = Buffer.from(token);
  const subscribers = new Set<WebSocket>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  function broadcast(message: ServerMessage) {
    for (const subscriber of subscribers) {
      send(subscriber, message);
    }
  }

  store.onEvent((event) => broadcast({ type: "event", event }));
  const supervisor = createSupervisor({
    store,
    runTurn,
    turnTimeoutMs,
    onDelta: (runId, text) => broadcast({ type: "delta", runId, text }),
  });

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
    // A cursor of 0 means an empty client, and rows like the seeded account have no event.
    if (afterSeq === 0 || afterSeq < oldest - 1 || afterSeq > latest) {
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
        const { name, personality, engineAccountId = "claude" } = command;
        if (engineAccountId === "fake" && !fakeEngine) {
          return { status: 403, body: { code: "engine_not_allowed" } };
        }
        return { status: 200, body: store.createBot({ name, personality, engineAccountId }) };
      }
      case "update-bot": {
        const { botId, name, personality } = command;
        const bot = store.updateBot(botId, { name, personality });
        return bot ? { status: 200, body: bot } : notFound;
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
    }
  }

  async function handleCommand(
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) {
    const command = parseCommand(await readBody(request));
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

  const server = NodeHttp.createServer((request, response) => {
    const url = URL.parse(request.url ?? "", "http://127.0.0.1");
    if (!url) {
      sendJson(response, 400, { code: "bad_request" });
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
    close: async () => {
      await supervisor.close();
      for (const client of sockets.clients) {
        client.terminate();
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
