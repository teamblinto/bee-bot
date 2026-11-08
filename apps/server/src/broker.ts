import type { BotProfile } from "@beebot/contracts";
import { z } from "zod";

// Static per tool, never taken from the model: the Rule of Two legs a call touches.
export type ToolLabels = { readsUntrusted: boolean; readsPrivate: boolean; sideEffect: boolean };

export const profileLegs: Record<BotProfile, ToolLabels> = {
  reader: { readsUntrusted: true, readsPrivate: true, sideEffect: false },
  researcher: { readsUntrusted: true, readsPrivate: false, sideEffect: true },
  operator: { readsUntrusted: false, readsPrivate: true, sideEffect: true },
};

// Grants as data, such as `gmail.read` or `gmail.send(to-allowlist)`. Egress hosts are kept apart,
// in `bot_egress_hosts`.
export const Manifest = z.array(z.string().trim().min(1).max(200));
export type Manifest = z.infer<typeof Manifest>;

export type ToolCall = { botId: string; runId: string; tool: string; labels: ToolLabels };

export type PolicyContext = {
  profile: BotProfile;
  manifest: Manifest;
  // The legs this session already holds. The broker sets them, never the bot.
  session: ToolLabels;
  attended: boolean;
};

export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "approve" }
  // Only a person may do it, such as a payment or a credential change. Bee never runs it.
  | { kind: "hand_off"; reason: string };

export type Decide = (call: ToolCall, context: PolicyContext) => PolicyDecision;

export const decide: Decide = () => {
  throw new Error("not implemented: the policy broker is M3 workstream 4");
};
