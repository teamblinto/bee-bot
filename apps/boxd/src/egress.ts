import type { EgressAttachment, Role } from "./policy.ts";

// The seam for the egress proxy, which runs beside boxd in the Linux host (workstream 3).
// `start` runs once after setup, before boxd serves. `attach` runs when `create` has made a box
// network: the proxy joins that network and says how containers on it reach it. Box networks are
// internal, so whatever the proxy does not provide does not exist.
export type Egress = {
  start: () => Promise<void>;
  attach: (network: { botId: string; role: Role; name: string }) => Promise<EgressAttachment>;
};

// Until a proxy is wired in, boxes have no way out at all.
export const noEgress: Egress = {
  start: async () => {},
  attach: async () => ({ dns: null, env: {} }),
};
