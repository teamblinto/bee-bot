import { type BotAccess, type BotControl, browserGrant, Manifest } from "@beebot/contracts";

// Static per tool, never taken from the model: the Rule of Two legs a call touches.
export type ToolLabels = { readsUntrusted: boolean; readsPrivate: boolean; sideEffect: boolean };

export const noLegs: ToolLabels = { readsUntrusted: false, readsPrivate: false, sideEffect: false };

// A manifest that doesn't parse grants nothing.
export function parseManifest(text: string): Manifest {
  try {
    return Manifest.safeParse(JSON.parse(text)).data ?? [];
  } catch {
    return [];
  }
}

export type ToolRule = {
  labels: ToolLabels;
  // A manifest entry the bot needs. Bee's own tools need none.
  grant?: string;
  // Only a person may do it, such as a payment or a credential change. Bee never runs it.
  humanOnly?: boolean;
  // The input can hold what a person typed or a credential, so not even its digest is audited.
  typed?: boolean;
};

const legs = (...names: Array<keyof ToolLabels>): ToolLabels => ({
  readsUntrusted: names.includes("readsUntrusted"),
  readsPrivate: names.includes("readsPrivate"),
  sideEffect: names.includes("sideEffect"),
});

// Talking to the owner is how any bot reports back, so `notify`, `ask_user` and
// `request_takeover` touch no leg. Anything another bot or the outside world acts on is a side
// effect.
const beeRules: Record<string, ToolRule> = {
  send_message: { labels: legs("sideEffect") },
  notify: { labels: noLegs },
  ask_user: { labels: noLegs },
  request_takeover: { labels: noLegs },
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

export const computerGrant = "computer";
const controlGrants: Record<BotControl, string[]> = {
  browser: [browserGrant],
  computer: [browserGrant, computerGrant],
  host: [computerGrant],
  none: [],
};

// The browser and the desktop are granted by the control mode alone, never by the manifest.
export const grantsOf = (manifest: Manifest, control: BotControl) => [
  ...manifest.filter((grant) => grant !== browserGrant && grant !== computerGrant),
  ...controlGrants[control],
];

// Every page is untrusted, and a click, a typed value or the URL itself can send something out.
const browserRules: Record<string, ToolRule> = {
  browser_navigate: { labels: legs("readsUntrusted", "sideEffect"), grant: browserGrant },
  browser_snapshot: { labels: legs("readsUntrusted"), grant: browserGrant },
  browser_click: { labels: legs("readsUntrusted", "sideEffect"), grant: browserGrant },
  browser_type: {
    labels: legs("readsUntrusted", "sideEffect"),
    grant: browserGrant,
    typed: true,
  },
};

// A box desktop or the owner's own one, whichever the bot's control mode names. Every screen is
// untrusted, and any click, key or typed text can send something out.
const consequential = legs("readsUntrusted", "sideEffect");
const computerRules: Record<string, ToolRule> = {
  computer_screenshot: { labels: legs("readsUntrusted"), grant: computerGrant },
  computer_click: { labels: consequential, grant: computerGrant },
  computer_type: { labels: consequential, grant: computerGrant, typed: true },
  computer_key: { labels: consequential, grant: computerGrant },
  computer_scroll: { labels: consequential, grant: computerGrant },
  computer_drag: { labels: consequential, grant: computerGrant },
  // This PC through cua-driver, which reads windows and acts on them in the background.
  computer_windows: { labels: legs("readsUntrusted"), grant: computerGrant },
  computer_open: { labels: consequential, grant: computerGrant },
  computer_look: { labels: legs("readsUntrusted"), grant: computerGrant },
  computer_desktop: { labels: legs("readsUntrusted"), grant: computerGrant },
  computer_window_click: { labels: consequential, grant: computerGrant },
  computer_window_type: { labels: consequential, grant: computerGrant, typed: true },
  computer_window_key: { labels: consequential, grant: computerGrant },
  computer_window_scroll: { labels: consequential, grant: computerGrant },
  computer_window_drag: { labels: consequential, grant: computerGrant },
};

export const toolRules: Record<string, ToolRule> = {
  ...beeRules,
  ...memoryRules,
  ...engineRules,
  ...browserRules,
  ...computerRules,
};

export const ruleFor = (tool: string) =>
  Object.hasOwn(toolRules, tool) ? toolRules[tool] : undefined;

export type ToolCall = { botId: string; runId: string; tool: string } & ToolRule;

export type PolicyContext = {
  access: BotAccess;
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

const screenGrants: ReadonlySet<string | undefined> = new Set([browserGrant, computerGrant]);

// Access decides what asks: below Full access every click, key or page action does. Engine tools
// are left to the approvals, which know the working folder.
//
// With nobody watching, the Rule of Two: a session may read untrusted content or private data,
// never both. Its reply can reach another bot without passing here, so it always counts as acting.
export const decide: Decide = (call, { access, manifest, session, attended }) => {
  if (call.grant !== undefined && !manifest.includes(call.grant)) {
    return { kind: "deny", reason: "not_granted" };
  }
  if (call.humanOnly) {
    return { kind: "hand_off", reason: "human_only" };
  }
  const after = withLegs(session, call.labels);
  const addsRead =
    (call.labels.readsUntrusted && !session.readsUntrusted) ||
    (call.labels.readsPrivate && !session.readsPrivate);
  if (
    !attended &&
    after.readsUntrusted &&
    after.readsPrivate &&
    (addsRead || call.labels.sideEffect)
  ) {
    return { kind: "deny", reason: "nobody_watching" };
  }
  if (access !== "full" && call.labels.sideEffect && screenGrants.has(call.grant)) {
    return { kind: "approve" };
  }
  return { kind: "allow" };
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
