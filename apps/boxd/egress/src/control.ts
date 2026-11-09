import * as NodeNet from "node:net";

import { connectHosts, normalizeHost, type Vendor, vendors } from "./policy.ts";

export type BotPolicy = {
  hosts: string[];
  // Every public site besides `hosts`; a name that resolves to a private address is still refused.
  anySite: boolean;
  api: { vendor: Vendor; key: string } | null;
};

// One JSON object per line on the control socket. `bind` ties a box's source address to a bot;
// `policy` says where that bot may go and holds the API key in memory. `listen` adds an address
// the proxy serves on, when it joins a new box network; listeners outlive the connection.
export type ControlMessage =
  | { type: "listen"; address: string }
  | { type: "bind"; address: string; botId: string }
  | { type: "unbind"; address: string }
  | ({ type: "policy"; botId: string } & BotPolicy)
  | { type: "forget"; botId: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;

export const unmapAddress = (address: string) => address.replace(/^::ffff:(?=[0-9.]+$)/i, "");

// Errors name the field, never echo the value: a policy line carries a key.
export function parseControl(line: string): ControlMessage | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "not JSON";
  }
  if (!isRecord(value)) {
    return "not an object";
  }
  const address = typeof value.address === "string" ? unmapAddress(value.address) : "";
  switch (value.type) {
    case "listen":
      return NodeNet.isIP(address) === 0 ? "listen needs address" : { type: "listen", address };
    case "bind":
      if (NodeNet.isIP(address) === 0 || !isId(value.botId)) {
        return "bind needs address and botId";
      }
      return { type: "bind", address, botId: value.botId };
    case "unbind":
      return NodeNet.isIP(address) === 0 ? "unbind needs address" : { type: "unbind", address };
    case "forget":
      return isId(value.botId) ? { type: "forget", botId: value.botId } : "forget needs botId";
    case "policy": {
      const { botId, hosts, subscription, api } = value;
      const anySite = value.anySite === true;
      if (!isId(botId) || !Array.isArray(hosts) || hosts.length > 1000) {
        return "policy needs botId and hosts";
      }
      const normalized = hosts.map((host) =>
        typeof host === "string" ? normalizeHost(host) : null,
      );
      if (normalized.some((host) => host === null)) {
        return "policy has a bad host";
      }
      // The vendor whose CLI logs in by itself in the box: its hosts come from this side.
      const lane = vendors.find((name) => name === subscription);
      if (subscription !== null && lane === undefined) {
        return "policy subscription needs a vendor or null";
      }
      const allowed = connectHosts(
        normalized.filter((host) => host !== null),
        lane ?? null,
      );
      if (api === null) {
        return { type: "policy", botId, hosts: allowed, anySite, api };
      }
      const vendor = isRecord(api) ? vendors.find((name) => name === api.vendor) : undefined;
      if (!isRecord(api) || vendor === undefined || typeof api.key !== "string" || api.key === "") {
        return "policy api needs vendor and key";
      }
      return { type: "policy", botId, hosts: allowed, anySite, api: { vendor, key: api.key } };
    }
    default:
      return "unknown type";
  }
}

// What each control connection told the proxy, dropped with that connection: when the channel is
// down nothing is allowed and no key stays in memory.
export function createPolicyTable() {
  const bindings = new Map<string, { botId: string; owner: object }>();
  const policies = new Map<string, { policy: BotPolicy; owner: object }>();

  return {
    // Returns the bots whose open connections must end.
    apply(owner: object, message: ControlMessage): string[] {
      switch (message.type) {
        case "listen":
          return [];
        case "bind": {
          const previous = bindings.get(message.address)?.botId;
          bindings.set(message.address, { botId: message.botId, owner });
          return previous === undefined || previous === message.botId ? [] : [previous];
        }
        case "unbind": {
          const previous = bindings.get(message.address)?.botId;
          bindings.delete(message.address);
          return previous === undefined ? [] : [previous];
        }
        case "policy":
          policies.set(message.botId, {
            policy: { hosts: message.hosts, anySite: message.anySite, api: message.api },
            owner,
          });
          return [message.botId];
        case "forget":
          policies.delete(message.botId);
          return [message.botId];
      }
    },
    dropOwner(owner: object) {
      const dropped = new Set<string>();
      for (const [address, binding] of bindings) {
        if (binding.owner === owner) {
          bindings.delete(address);
          dropped.add(binding.botId);
        }
      }
      for (const [botId, entry] of policies) {
        if (entry.owner === owner) {
          policies.delete(botId);
          dropped.add(botId);
        }
      }
      return [...dropped];
    },
    lookup(remoteAddress: string | undefined) {
      const botId = bindings.get(unmapAddress(remoteAddress ?? ""))?.botId ?? null;
      return { botId, policy: botId === null ? null : (policies.get(botId)?.policy ?? null) };
    },
  };
}

export type PolicyTable = ReturnType<typeof createPolicyTable>;
