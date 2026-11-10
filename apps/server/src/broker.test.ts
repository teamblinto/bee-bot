import { BotAccess } from "@beebot/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decide,
  decideTool,
  noLegs,
  type PolicyContext,
  type ToolLabels,
  toolRules,
  withLegs,
} from "./broker.ts";

const ids = { botId: "b", runId: "r" };
const context = (fields: Partial<PolicyContext> = {}): PolicyContext => ({
  access: "full",
  manifest: [],
  session: noLegs,
  attended: true,
  ...fields,
});
const labels = (a: boolean, b: boolean, c: boolean): ToolLabels => ({
  readsUntrusted: a,
  readsPrivate: b,
  sideEffect: c,
});
const call = (tool: string, l: ToolLabels) => ({ ...ids, tool, labels: l });

describe("rule table", () => {
  it("refuses a tool it has no rule for", () => {
    expect(decideTool({ ...ids, tool: "rm_rf" }, context())).toEqual({
      kind: "deny",
      reason: "unknown_tool",
    });
    expect(decideTool({ ...ids, tool: "constructor" }, context()).kind).toBe("deny");
  });

  it("refuses a granted tool until the manifest grants it", () => {
    expect(decideTool({ ...ids, tool: "browser_navigate" }, context())).toEqual({
      kind: "deny",
      reason: "not_granted",
    });
    const granted = context({ manifest: ["browser"] });
    expect(decideTool({ ...ids, tool: "browser_navigate" }, granted).kind).toBe("allow");
  });

  it("asks before every screen and page action below Full access, and lets the bot look", () => {
    const actions = [
      "computer_click",
      "computer_type",
      "computer_key",
      "computer_scroll",
      "computer_drag",
      "browser_navigate",
      "browser_click",
      "browser_type",
    ];
    for (const access of ["supervised", "auto-edits"] as const) {
      const watched = context({ access, manifest: ["computer", "browser"] });
      for (const tool of actions) {
        expect(decideTool({ ...ids, tool }, watched).kind, `${access} ${tool}`).toBe("approve");
      }
      for (const tool of ["computer_screenshot", "browser_snapshot"]) {
        expect(decideTool({ ...ids, tool }, watched).kind, `${access} ${tool}`).toBe("allow");
      }
    }
    const full = context({ manifest: ["computer", "browser"] });
    for (const tool of actions) {
      expect(decideTool({ ...ids, tool }, full).kind, tool).toBe("allow");
    }
    expect(toolRules.computer_type?.typed).toBe(true);
  });

  it("leaves the engine's tools and Bee's own to the approvals at every level", () => {
    for (const access of BotAccess.options) {
      for (const tool of ["send_message", "delegate", "memory_propose", "Bash", "Edit", "notify"]) {
        expect(decideTool({ ...ids, tool }, context({ access })).kind, tool).toBe("allow");
      }
    }
  });

  it("hands a human-only tool to a person, even at Full access", () => {
    const signIn = { ...call("sign_in", noLegs), humanOnly: true };
    expect(decide(signIn, context()).kind).toBe("hand_off");
  });

  it("lets any bot ask for a takeover, watched or not, since asking grants nothing", () => {
    for (const session of [noLegs, labels(true, true, true)]) {
      const asked = context({ session, attended: false });
      expect(decideTool({ ...ids, tool: "request_takeover" }, asked).kind).toBe("allow");
    }
  });

  it("labels every untrusted read with a grant, so no bot gets one by default", () => {
    for (const [tool, rule] of Object.entries(toolRules)) {
      if (rule.labels.readsUntrusted) {
        expect(rule.grant, tool).toBeDefined();
      }
    }
  });
});

// With nobody watching, the Rule of Two: untrusted content or private data, never both.
describe("unattended session", () => {
  const read = call("read", labels(true, false, false));
  const secret = call("secret", labels(false, true, false));
  const act = call("act", labels(false, false, true));

  // Applies each call the way the broker does: taint on allow or approve, never on deny.
  function run(attended: boolean, calls: Array<ReturnType<typeof call>>) {
    let session = noLegs;
    return calls.map((next) => {
      const decision = decide(next, context({ session, attended }));
      if (decision.kind === "allow" || decision.kind === "approve") {
        session = withLegs(session, next.labels);
      }
      return { kind: decision.kind, session };
    });
  }

  it.each([
    ["untrusted first", [read, act, secret, act]],
    ["private first", [secret, act, read, act]],
  ])("acts freely on one kind of read and refuses the other: %s", (_, calls) => {
    const steps = run(false, calls);
    expect(steps.map(({ kind }) => kind)).toEqual(["allow", "allow", "deny", "allow"]);
    expect(steps[2]?.session).toEqual(steps[1]?.session);
  });

  it("refuses every side effect once a session holds both, but lets it read on", () => {
    const session = labels(true, true, false);
    expect(decide(act, context({ session, attended: false }))).toEqual({
      kind: "deny",
      reason: "nobody_watching",
    });
    expect(decide(read, context({ session, attended: false })).kind).toBe("allow");
    expect(decide(secret, context({ session, attended: false })).kind).toBe("allow");
  });

  it("doesn't count legs while the owner watches: Access alone decides", () => {
    expect(run(true, [read, secret, act]).map(({ kind }) => kind)).toEqual([
      "allow",
      "allow",
      "allow",
    ]);
  });
});
