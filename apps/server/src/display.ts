import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";

import type { WebSocket } from "ws";

import type { BoxAttach } from "./boxRuntime.ts";

export const displayTicketTtlMs = 30_000;
// RFB client messages are a few bytes, except a clipboard cut.
export const maxDisplayClientBytes = 64 * 1024;
const pauseAboveBytes = 4 * 1024 * 1024;
const resumeBelowBytes = 1024 * 1024;

type Grant = { botId: string; mode: "view"; expiresAt: number };

// A `/display` URL carries a ticket instead of the owner token, so a logged URL opens nothing.
export function createDisplayTickets(now = Date.now, ttlMs = displayTicketTtlMs) {
  const grants = new Map<string, Grant>();
  return {
    issue: (botId: string, mode: "view") => {
      for (const [ticket, grant] of grants) {
        if (grant.expiresAt <= now()) {
          grants.delete(ticket);
        }
      }
      const ticket = NodeCrypto.randomBytes(32).toString("base64url");
      const expiresAt = now() + ttlMs;
      grants.set(ticket, { botId, mode, expiresAt });
      return { ticket, expiresAt };
    },
    consume: (ticket: string | null) => {
      const grant = ticket === null ? undefined : grants.get(ticket);
      if (ticket === null || grant === undefined) {
        return undefined;
      }
      grants.delete(ticket);
      return grant.expiresAt > now() ? grant : undefined;
    },
  };
}

// Relays raw RFB bytes between the viewer and the box's view-only VNC. 4404 tells the viewer the
// box has no display, so it falls back to the screencast.
export async function serveDisplay(client: WebSocket, open: () => Promise<BoxAttach>) {
  client.on("error", () => client.terminate());
  let stream: NodeStream.Duplex;
  try {
    ({ stream } = await open());
  } catch {
    client.close(4404, "display unavailable");
    return;
  }
  if (client.readyState !== client.OPEN) {
    stream.destroy();
    return;
  }
  client.on("message", (data, isBinary) => {
    if (!isBinary) {
      client.close(1003, "binary only");
      return;
    }
    stream.write(data);
  });
  client.on("close", () => stream.destroy());
  stream.on("data", (chunk: Buffer) => {
    client.send(chunk, { binary: true }, () => {
      if (stream.isPaused() && client.bufferedAmount < resumeBelowBytes) {
        stream.resume();
      }
    });
    if (client.bufferedAmount > pauseAboveBytes) {
      stream.pause();
    }
  });
  NodeStream.finished(stream, { writable: false }, () => client.close(1000, "display ended"));
}
