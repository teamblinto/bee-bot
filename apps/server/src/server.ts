import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import {
  type Bootstrap,
  ClientMessage,
  type DiagnosticResult,
  type ProtocolNotice,
  protocolVersion,
  type ServerMessage,
} from "@beebot/contracts";
import { type WebSocket, WebSocketServer } from "ws";

import type { EventStore } from "./store.ts";

type Options = Pick<Bootstrap, "port" | "token" | "allowedOrigins"> & { store: EventStore };

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

export async function startServer({ port, token, allowedOrigins, store }: Options) {
  const expectedToken = Buffer.from(token);
  const subscribers = new Set<WebSocket>();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });

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
    if (afterSeq < oldest - 1 || afterSeq > latest) {
      return { type: "snapshot", seq: latest, events: store.eventsAfter(0) };
    }
    return { type: "replay", events: store.eventsAfter(afterSeq) };
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
      response.setHeader("Access-Control-Allow-Headers", "Authorization");
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
    } else if (request.method === "POST" && url.pathname === "/commands/diagnostic") {
      try {
        const event = store.append("diagnostic");
        for (const subscriber of subscribers) {
          send(subscriber, { type: "event", event });
        }
        const result: DiagnosticResult = { event };
        sendJson(response, 200, result);
      } catch (error) {
        console.error(error);
        sendJson(response, 500, { code: "storage_failed" });
      }
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

  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const client of sockets.clients) {
        client.terminate();
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
