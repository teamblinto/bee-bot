import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";

import type { WebSocket } from "ws";

import type { BoxAttach } from "./boxRuntime.ts";

export const displayTicketTtlMs = 30_000;
// RFB client messages are a few bytes, except a clipboard cut.
export const maxDisplayClientBytes = 64 * 1024;
const pauseAboveBytes = 4 * 1024 * 1024;
const resumeBelowBytes = 1024 * 1024;

type Grant = { botId: string; mode: "view" | "control"; leaseId?: string; expiresAt: number };

// A `/display` URL carries a ticket instead of the owner token, so a logged URL opens nothing. A
// control ticket is bound to the lease it was issued for.
export function createDisplayTickets(now = Date.now, ttlMs = displayTicketTtlMs) {
  const grants = new Map<string, Grant>();
  return {
    issue: (botId: string, mode: "view" | "control", leaseId?: string) => {
      for (const [ticket, grant] of grants) {
        if (grant.expiresAt <= now()) {
          grants.delete(ticket);
        }
      }
      const ticket = NodeCrypto.randomBytes(32).toString("base64url");
      const expiresAt = now() + ttlMs;
      grants.set(ticket, { botId, mode, ...(leaseId !== undefined && { leaseId }), expiresAt });
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

// A person's lease owns the desktop's input server and every control viewer: both start no earlier
// than the take and end with the give, whichever way the lease ends.
export function createDesktopControl(
  start: (botId: string, leaseId: string) => Promise<BoxAttach> | undefined,
) {
  const leases = new Map<
    string,
    { botId: string; server: Promise<NodeStream.Duplex | undefined>; viewers: Set<WebSocket> }
  >();

  function give(leaseId: string) {
    const lease = leases.get(leaseId);
    if (!lease) {
      return false;
    }
    leases.delete(leaseId);
    for (const viewer of lease.viewers) {
      viewer.close(4409, "control returned");
    }
    void lease.server.then((stream) => stream?.destroy());
    return true;
  }

  return {
    // False when the bot has no desktop.
    take: (botId: string, leaseId: string) => {
      const starting = start(botId, leaseId);
      if (!starting) {
        return false;
      }
      const server = starting.then(
        ({ stream }) => {
          stream.on("error", () => {});
          stream.resume();
          return stream;
        },
        (error: unknown) => {
          console.error(`beebotd: desktop control didn't start: ${(error as Error)?.message}`);
          return undefined;
        },
      );
      leases.set(leaseId, { botId, server, viewers: new Set() });
      return true;
    },
    give,
    holds: (botId: string, leaseId: string) => leases.get(leaseId)?.botId === botId,
    // False when the lease is already gone.
    watch: (leaseId: string, viewer: WebSocket) => {
      const lease = leases.get(leaseId);
      if (!lease) {
        return false;
      }
      lease.viewers.add(viewer);
      viewer.on("close", () => lease.viewers.delete(viewer));
      return true;
    },
    close: () => {
      for (const leaseId of leases.keys()) {
        give(leaseId);
      }
    },
  };
}

export type DesktopControl = ReturnType<typeof createDesktopControl>;

// Relays raw RFB bytes between the viewer and one of the box's VNC servers. Only a lease's control
// server takes input; the view-only one ignores whatever a viewer sends. 4404 tells the viewer the
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
    if (!stream.write(data) && !client.isPaused) {
      client.pause();
      stream.once("drain", () => client.resume());
    }
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
