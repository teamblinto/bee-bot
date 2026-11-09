import { BotProfile } from "@beebot/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decide,
  decideTool,
  noLegs,
  type PolicyContext,
  profileLegs,
  type ToolLabels,
  toolRules,
  withLegs,
} from "./broker.ts";

const ids = { botId: "b", runId: "r" };
const context = (fields: Partial<PolicyContext> = {}): PolicyContext => ({
  profile: "operator",
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
    const researcher = context({ profile: "researcher" });
    expect(decideTool({ ...ids, tool: "browser_navigate" }, researcher)).toEqual({
      kind: "deny",
      reason: "not_granted",
    });
    const granted = { ...researcher, manifest: ["browser"] };
    expect(decideTool({ ...ids, tool: "browser_navigate" }, granted).kind).toBe("allow");
  });

  it("lets a granted Reader read pages, and asks before it opens, clicks or types", () => {
    const reader = context({ profile: "reader", manifest: ["browser"] });
    expect(decideTool({ ...ids, tool: "browser_snapshot" }, reader).kind).toBe("allow");
    expect(decideTool({ ...ids, tool: "browser_navigate" }, reader).kind).toBe("approve");
    expect(decideTool({ ...ids, tool: "browser_click" }, reader).kind).toBe("approve");
    expect(decideTool({ ...ids, tool: "browser_type" }, { ...reader, attended: false })).toEqual({
      kind: "deny",
      reason: "nobody_watching",
    });
  });

  it("lets a granted bot look at its screen, and asks before it acts there unless the profile allows it", () => {
    const actions = [
      "computer_click",
      "computer_type",
      "computer_key",
      "computer_scroll",
      "computer_drag",
    ];
    expect(decideTool({ ...ids, tool: "computer_screenshot" }, context())).toEqual({
      kind: "deny",
      reason: "not_granted",
    });
    const operator = context({ manifest: ["browser"] });
    const reader = context({ profile: "reader", manifest: ["browser"] });
    const researcher = context({ profile: "researcher", manifest: ["browser"] });
    expect(decideTool({ ...ids, tool: "computer_screenshot" }, reader).kind).toBe("allow");
    for (const tool of actions) {
      expect(decideTool({ ...ids, tool }, operator).kind, tool).toBe("approve");
      expect(decideTool({ ...ids, tool }, reader).kind, tool).toBe("approve");
      expect(decideTool({ ...ids, tool }, { ...operator, attended: false }), tool).toEqual({
        kind: "deny",
        reason: "nobody_watching",
      });
      expect(decideTool({ ...ids, tool }, researcher).kind, tool).toBe("allow");
    }
    expect(toolRules.computer_type?.typed).toBe(true);
  });

  it("hands a human-only tool to a person, even when watched", () => {
    const signIn = { ...call("sign_in", noLegs), humanOnly: true };
    expect(decide(signIn, context({ profile: "researcher" })).kind).toBe("hand_off");
  });

  it("lets the default Operator run Bee's own tools and the engine's", () => {
    for (const tool of ["send_message", "delegate", "memory_propose", "Bash", "Edit", "notify"]) {
      expect(decideTool({ ...ids, tool }, context({ attended: false })).kind).toBe("allow");
    }
  });

  it("lets any bot ask for a takeover, watched or not, since asking grants nothing", () => {
    for (const profile of BotProfile.options) {
      for (const session of [noLegs, labels(true, true, true)]) {
        const asked = context({ profile, session, attended: false });
        expect(decideTool({ ...ids, tool: "request_takeover" }, asked).kind).toBe("allow");
      }
    }
  });

  it("labels every untrusted read with a grant, so no profile gets one by default", () => {
    for (const [tool, rule] of Object.entries(toolRules)) {
      if (rule.labels.readsUntrusted) {
        expect(rule.grant, tool).toBeDefined();
      }
    }
  });
});

// Every profile against every label set, from a fresh session.
describe("profile x labels", () => {
  const all = [false, true].flatMap((a) =>
    [false, true].flatMap((b) => [false, true].map((c) => labels(a, b, c))),
  );
  for (const profile of BotProfile.options) {
    for (const l of all) {
      const name = `${profile} ${JSON.stringify(l)}`;
      it(name, () => {
        const allowed = profileLegs[profile];
        const within =
          (!l.readsUntrusted || allowed.readsUntrusted) &&
          (!l.readsPrivate || allowed.readsPrivate) &&
          (!l.sideEffect || allowed.sideEffect);
        const watched = decide(call("t", l), context({ profile }));
        const alone = decide(call("t", l), context({ profile, attended: false }));
        expect(watched.kind).toBe(within ? "allow" : "approve");
        expect(alone).toEqual(
          within ? { kind: "allow" } : { kind: "deny", reason: "nobody_watching" },
        );
      });
    }
  }
});

describe("session taint", () => {
  const read = call("read", labels(true, false, false));
  const secret = call("secret", labels(false, true, false));
  const act = call("act", labels(false, false, true));

  // Applies each call the way the broker does: taint on allow or approve, never on deny.
  function run(profile: BotProfile, attended: boolean, calls: Array<ReturnType<typeof call>>) {
    let session = noLegs;
    return calls.map((next) => {
      const decision = decide(next, context({ profile, session, attended }));
      if (decision.kind === "allow" || decision.kind === "approve") {
        session = withLegs(session, next.labels);
      }
      return { kind: decision.kind, session };
    });
  }

  it("lets a Reader read anything but asks before it acts", () => {
    const steps = run("reader", true, [read, secret, act]);
    expect(steps.map(({ kind }) => kind)).toEqual(["allow", "allow", "approve"]);
    expect(steps[2]?.session).toEqual(labels(true, true, true));
  });

  it("keeps a Researcher off private data once it has read the web", () => {
    expect(run("researcher", true, [read, act, secret]).map(({ kind }) => kind)).toEqual([
      "allow",
      "allow",
      "approve",
    ]);
    expect(run("researcher", false, [read, secret]).map(({ kind }) => kind)).toEqual([
      "allow",
      "deny",
    ]);
  });

  it("asks on every side effect once a session holds all three legs", () => {
    const steps = run("operator", true, [secret, act, read, act, secret, read, act]);
    expect(steps.map(({ kind }) => kind)).toEqual([
      "allow",
      "allow",
      "approve",
      "approve",
      "allow",
      "allow",
      "approve",
    ]);
  });

  it("refuses the third leg with nobody watching, and the session stays as it was", () => {
    const steps = run("operator", false, [secret, act, read, act]);
    expect(steps.map(({ kind }) => kind)).toEqual(["allow", "allow", "deny", "allow"]);
    expect(steps[3]?.session).toEqual(labels(false, true, true));
  });

  it("keeps a leg from before a profile change, so side effects past the new profile ask", () => {
    const session = labels(false, true, true);
    const researcher = context({ profile: "researcher", session });
    expect(decide(act, researcher).kind).toBe("approve");
    expect(decide(act, { ...researcher, attended: false }).kind).toBe("deny");
  });
});
