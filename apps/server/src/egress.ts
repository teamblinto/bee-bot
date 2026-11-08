import type { DatabaseSync } from "node:sqlite";
import type { Duplex } from "node:stream";

import { EngineLane } from "@beebot/contracts";
import { z } from "zod";

import { apiKeyName, type Vault } from "./vault.ts";

// The egress proxy runs beside boxd in the Linux host (apps/boxd/egress). This side decides what
// each bot may reach and pushes it, with the API key, over the proxy's control socket. Vendor
// host names live in the proxy, so server code names no vendor endpoint.

export type Vendor = "anthropic" | "openai";

const vendorByAccount: Record<string, Vendor> = { claude: "anthropic", codex: "openai" };

const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function normalizeEgressHost(raw: string) {
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  const valid =
    host.length <= 253 &&
    labels.length > 1 &&
    labels.every((part) => label.test(part)) &&
    !/^[0-9]+$/.test(labels.at(-1) ?? "");
  return valid ? host : null;
}

// Names that only ever mean something inside a network. The proxy refuses private addresses too,
// once a public name resolves to one.
const privateSuffix = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|arpa)$/;

// The owner's list, normalized, or null when any entry isn't one public DNS name.
export function ownerEgressHosts(raw: readonly string[]) {
  const hosts = raw.map(normalizeEgressHost);
  if (hosts.some((host) => host === null || privateSuffix.test(host))) {
    return null;
  }
  return [...new Set(hosts.filter((host) => host !== null))].sort();
}

export type EgressInput = { engineAccountId: string; lane: EngineLane; hosts: string[] };
export type EgressPolicy = {
  hosts: string[];
  subscription: Vendor | null;
  apiVendor: Vendor | null;
};

// Default deny: a bot reaches the hosts its owner granted, plus, on the subscription lane, its
// vendor's hosts, which the proxy adds. On the API lane the vendor is reached only through the
// key-injecting lane, so CONNECT to the vendor stays closed and cannot become an unauthenticated
// side channel.
export function egressPolicy({ engineAccountId, lane, hosts }: EgressInput): EgressPolicy {
  const vendor = vendorByAccount[engineAccountId] ?? null;
  return {
    hosts: [...new Set(hosts.map(normalizeEgressHost).filter((host) => host !== null))].sort(),
    subscription: lane === "subscription" ? vendor : null,
    apiVendor: lane === "api_key" ? vendor : null,
  };
}

const PolicyRow = z.object({ engineAccountId: z.string(), lane: EngineLane });

export function openEgress(db: DatabaseSync) {
  const selectBot = db.prepare(
    `SELECT b.engine_account_id AS engineAccountId, a.lane FROM bots b
     JOIN engine_accounts a ON a.id = b.engine_account_id WHERE b.id = ?`,
  );
  const selectHosts = db.prepare(
    "SELECT host FROM bot_egress_hosts WHERE bot_id = ? ORDER BY host",
  );
  return {
    egressInput: (botId: string): EgressInput | null => {
      const row = selectBot.get(botId);
      if (row === undefined) {
        return null;
      }
      return {
        ...PolicyRow.parse(row),
        hosts: z
          .array(z.object({ host: z.string() }))
          .parse(selectHosts.all(botId))
          .map(({ host }) => host),
      };
    },
  };
}

const Reply = z.object({ ok: z.boolean(), error: z.string().optional() });

export type EgressControl = {
  apply: (botId: string) => Promise<void>;
  forget: (botId: string) => Promise<void>;
  close: () => void;
};

// `connect` opens a fresh stream to the proxy's control socket; how depends on the host (WS2).
// The proxy drops everything a connection said when it closes, so after a reconnect every bot
// applied before is pushed again. The key travels only on this stream, in memory.
export function createEgressControl({
  connect,
  vault,
  egressInput,
}: {
  connect: () => Promise<Duplex>;
  vault: Vault;
  egressInput: (botId: string) => EgressInput | null;
}): EgressControl {
  const applied = new Set<string>();
  let link: Promise<{ send: (message: object) => Promise<void>; stream: Duplex }> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  async function open() {
    const stream = await connect();
    const waiting: { resolve: () => void; reject: (error: Error) => void }[] = [];
    let buffered = "";
    const fail = () => {
      link = null;
      for (const { reject } of waiting.splice(0)) {
        reject(new Error("egress control closed"));
      }
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Counted as a bad reply below.
        }
        const reply = Reply.safeParse(parsed);
        const next = waiting.shift();
        if (reply.success && reply.data.ok) {
          next?.resolve();
        } else {
          next?.reject(new Error(`egress refused: ${reply.data?.error ?? "bad reply"}`));
        }
      }
    });
    stream.once("close", fail);
    stream.on("error", () => stream.destroy());
    return {
      stream,
      send: (message: object) =>
        new Promise<void>((resolve, reject) => {
          if (stream.destroyed) {
            return reject(new Error("egress control closed"));
          }
          waiting.push({ resolve, reject });
          stream.write(`${JSON.stringify(message)}\n`);
        }),
    };
  }

  async function policyMessage(botId: string) {
    const input = egressInput(botId);
    if (input === null) {
      return { type: "forget", botId };
    }
    const { hosts, subscription, apiVendor } = egressPolicy(input);
    const key = apiVendor === null ? undefined : await vault.get(apiKeyName(input.engineAccountId));
    // No key means no API lane: the proxy then refuses those requests instead of sending them bare.
    return {
      type: "policy",
      botId,
      hosts,
      subscription,
      api: apiVendor !== null && key ? { vendor: apiVendor, key } : null,
    };
  }

  async function current() {
    if (link !== null) {
      return link;
    }
    const opening = open();
    link = opening;
    try {
      const { send } = await opening;
      for (const botId of applied) {
        await send(await policyMessage(botId));
      }
      return opening;
    } catch (error) {
      link = null;
      throw error;
    }
  }

  // One request at a time, so replies match requests in order.
  const serial = <T>(task: () => Promise<T>) => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    apply: (botId) =>
      serial(async () => {
        const { send } = await current();
        const message = await policyMessage(botId);
        await send(message);
        if (message.type === "forget") {
          applied.delete(botId);
        } else {
          applied.add(botId);
        }
      }),
    forget: (botId) =>
      serial(async () => {
        applied.delete(botId);
        const { send } = await current();
        await send({ type: "forget", botId });
      }),
    close: () => {
      applied.clear();
      void link?.then(
        ({ stream }) => stream.destroy(),
        () => undefined,
      );
      link = null;
    },
  };
}
