import type { BotProfile } from "@beebot/contracts";
import { z } from "zod";

// Static per tool, never taken from the model: the Rule of Two legs a call touches.
export type ToolLabels = { readsUntrusted: boolean; readsPrivate: boolean; sideEffect: boolean };

const legNames = ["readsUntrusted", "readsPrivate", "sideEffect"] as const;

export const noLegs: ToolLabels = { readsUntrusted: false, readsPrivate: false, sideEffect: false };

export const profileLegs: Record<BotProfile, ToolLabels> = {
  reader: { readsUntrusted: true, readsPrivate: true, sideEffect: false },
  researcher: { readsUntrusted: true, readsPrivate: false, sideEffect: true },
  operator: { readsUntrusted: false, readsPrivate: true, sideEffect: true },
};

// Grants as data, such as `gmail.read` or `gmail.send(to-allowlist)`. Egress hosts are kept apart,
// in `bot_egress_hosts`.
export const Manifest = z.array(z.string().trim().min(1).max(200));
export type Manifest = z.infer<typeof Manifest>;

export type ToolRule = {
  labels: ToolLabels;
  // A manifest entry the bot needs. Bee's own tools need none: the profile alone bounds them.
  grant?: string;
  // Only a person may do it, such as a payment or a credential change. Bee never runs it.
  humanOnly?: boolean;
  // The input can hold what a person typed or a credential, so not even its digest is audited.
  typed?: boolean;
};

const legs = (...names: Array<(typeof legNames)[number]>): ToolLabels => ({
  readsUntrusted: names.includes("readsUntrusted"),
  readsPrivate: names.includes("readsPrivate"),
  sideEffect: names.includes("sideEffect"),
});

// Talking to the owner is how any profile reports back, so `notify` and `ask_user` touch no leg.
// Anything another bot or the outside world acts on is a side effect.
const beeRules: Record<string, ToolRule> = {
  send_message: { labels: legs("sideEffect") },
  notify: { labels: noLegs },
  ask_user: { labels: noLegs },
  delegate: { labels: legs("sideEffect") },
  handoff: { labels: legs("sideEffect") },
  create_routine: { labels: legs("sideEffect") },
};

// A write from a session that saw untrusted text waits for the owner's review, which is the draft
// a Reader may make, so writes count as private reads only.
const memoryRules: Record<string, ToolRule> = {
  memory_search: { labels: legs("readsPrivate") },
  memory_get: { labels: legs("readsPrivate") },
  memory_propose: { labels: legs("readsPrivate") },
  memory_forget: { labels: legs("readsPrivate") },
};

// The engine's own tools, as they reach the permission prompt. Box egress bounds what Bash can
// fetch, and a Host bot only runs while the owner watches.
const engineRules: Record<string, ToolRule> = {
  Read: { labels: legs("readsPrivate") },
  Glob: { labels: legs("readsPrivate") },
  Grep: { labels: legs("readsPrivate") },
  Write: { labels: legs("readsPrivate", "sideEffect") },
  Edit: { labels: legs("readsPrivate", "sideEffect") },
  Patch: { labels: legs("readsPrivate", "sideEffect") },
  Bash: { labels: legs("readsPrivate", "sideEffect") },
};

// Slot for the browser sidecar (workstream 7), which owns the names. Every page is untrusted.
const browserRules: Record<string, ToolRule> = {
  browser_open: { labels: legs("readsUntrusted"), grant: "browser" },
  browser_read: { labels: legs("readsUntrusted"), grant: "browser" },
  browser_act: { labels: legs("readsUntrusted", "sideEffect"), grant: "browser" },
  browser_type: { labels: legs("readsUntrusted", "sideEffect"), grant: "browser", typed: true },
  browser_sign_in: { labels: legs("readsUntrusted"), grant: "browser", humanOnly: true },
};

export const toolRules: Record<string, ToolRule> = {
  ...beeRules,
  ...memoryRules,
  ...engineRules,
  ...browserRules,
};

export const ruleFor = (tool: string) =>
  Object.hasOwn(toolRules, tool) ? toolRules[tool] : undefined;

export type ToolCall = { botId: string; runId: string; tool: string } & ToolRule;

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

export const withLegs = (session: ToolLabels, labels: ToolLabels): ToolLabels => ({
  readsUntrusted: session.readsUntrusted || labels.readsUntrusted,
  readsPrivate: session.readsPrivate || labels.readsPrivate,
  sideEffect: session.sideEffect || labels.sideEffect,
});

// Within the profile's two legs a call runs. Past them a person must watch: every side effect and
// every new leg asks, and with nobody there it is refused. A read the session already holds goes on.
export const decide: Decide = (call, { profile, manifest, session, attended }) => {
  if (call.grant !== undefined && !manifest.includes(call.grant)) {
    return { kind: "deny", reason: "not_granted" };
  }
  if (call.humanOnly) {
    return { kind: "hand_off", reason: "human_only" };
  }
  const after = withLegs(session, call.labels);
  const allowed = profileLegs[profile];
  if (legNames.every((leg) => !after[leg] || allowed[leg])) {
    return { kind: "allow" };
  }
  const addsLeg = legNames.some((leg) => call.labels[leg] && !session[leg]);
  if (!addsLeg && !call.labels.sideEffect) {
    return { kind: "allow" };
  }
  return attended ? { kind: "approve" } : { kind: "deny", reason: "nobody_watching" };
};

// Default deny: a tool missing from the table is refused.
export function decideTool(
  call: { botId: string; runId: string; tool: string },
  context: PolicyContext,
  decideCall: Decide = decide,
): PolicyDecision {
  const rule = ruleFor(call.tool);
  return rule
    ? decideCall({ ...call, ...rule }, context)
    : { kind: "deny", reason: "unknown_tool" };
}
