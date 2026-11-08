import { describe, expect, it } from "vite-plus/test";

import { type ControlMessage, createPolicyTable, parseControl } from "./control.ts";
import { subscriptionHosts } from "./policy.ts";

describe("control messages", () => {
  it.each([
    ['{"type":"bind","address":"10.89.171.5","botId":"b1"}', "bind"],
    ['{"type":"bind","address":"::ffff:10.89.171.5","botId":"b1"}', "bind"],
    ['{"type":"bind","address":"box-1","botId":"b1"}', "bind needs address and botId"],
    ['{"type":"unbind","address":"10.89.171.5"}', "unbind"],
    ['{"type":"listen","address":"10.89.171.2"}', "listen"],
    ['{"type":"listen","address":"proxy"}', "listen needs address"],
    ['{"type":"forget","botId":"b1"}', "forget"],
    [
      '{"type":"policy","botId":"b1","hosts":["PyPI.org."],"subscription":null,"api":null}',
      "policy",
    ],
    [
      '{"type":"policy","botId":"b1","hosts":[],"subscription":null,"api":{"vendor":"anthropic","key":"sk"}}',
      "policy",
    ],
    [
      '{"type":"policy","botId":"b1","hosts":[],"subscription":null,"api":{"vendor":"evil","key":"sk"}}',
      "policy api needs vendor and key",
    ],
    [
      '{"type":"policy","botId":"b1","hosts":[],"subscription":null,"api":{"vendor":"openai","key":""}}',
      "policy api needs vendor and key",
    ],
    [
      '{"type":"policy","botId":"b1","hosts":["10.0.0.1"],"subscription":null,"api":null}',
      "policy has a bad host",
    ],
    [
      '{"type":"policy","botId":"b1","hosts":["*.github.com"],"subscription":null,"api":null}',
      "policy has a bad host",
    ],
    [
      '{"type":"policy","botId":"b1","subscription":null,"api":null}',
      "policy needs botId and hosts",
    ],
    [
      '{"type":"policy","botId":"","hosts":[],"subscription":null,"api":null}',
      "policy needs botId and hosts",
    ],
    ['{"type":"shutdown"}', "unknown type"],
    ["[]", "not an object"],
    ["{", "not JSON"],
  ])("%s -> %s", (line, expected) => {
    const message = parseControl(line);
    expect(typeof message === "string" ? message : message.type).toBe(expected);
  });

  it("normalizes hosts and unmaps addresses", () => {
    expect(
      parseControl(
        '{"type":"policy","botId":"b","hosts":["PyPI.org."],"subscription":null,"api":null}',
      ),
    ).toEqual({
      type: "policy",
      botId: "b",
      hosts: ["pypi.org"],
      api: null,
    });
    expect(parseControl('{"type":"bind","address":"::ffff:10.0.0.5","botId":"b"}')).toEqual({
      type: "bind",
      address: "10.0.0.5",
      botId: "b",
    });
  });

  it("adds the subscription vendor's hosts, and none of them is GitHub", () => {
    const parse = (subscription: unknown) =>
      parseControl(
        JSON.stringify({
          type: "policy",
          botId: "b",
          hosts: ["pypi.org"],
          subscription,
          api: null,
        }),
      );
    expect(parse("anthropic")).toMatchObject({
      hosts: ["api.anthropic.com", "platform.claude.com", "pypi.org"],
    });
    expect(parse("openai")).toMatchObject({
      hosts: ["api.openai.com", "auth.openai.com", "chatgpt.com", "pypi.org"],
    });
    expect(parse(null)).toMatchObject({ hosts: ["pypi.org"] });
    expect(parse("github")).toBe("policy subscription needs a vendor or null");
    expect(parse(undefined)).toBe("policy subscription needs a vendor or null");
    expect(Object.values(subscriptionHosts).flat().join(" ")).not.toMatch(/github/);
  });

  it("never echoes a key in an error", () => {
    const error = parseControl(
      '{"type":"policy","botId":"b","hosts":["bad host"],"subscription":null,"api":{"vendor":"anthropic","key":"sk-secret"}}',
    );
    expect(error).toBe("policy has a bad host");
  });
});

describe("policy table", () => {
  const policy: ControlMessage = { type: "policy", botId: "b1", hosts: ["pypi.org"], api: null };

  it("knows a source only once it is bound and has a policy", () => {
    const table = createPolicyTable();
    const owner = {};
    expect(table.lookup("10.0.0.5")).toEqual({ botId: null, policy: null });
    table.apply(owner, { type: "bind", address: "10.0.0.5", botId: "b1" });
    expect(table.lookup("10.0.0.5")).toEqual({ botId: "b1", policy: null });
    table.apply(owner, policy);
    expect(table.lookup("::ffff:10.0.0.5").policy?.hosts).toEqual(["pypi.org"]);
    expect(table.lookup("10.0.0.6")).toEqual({ botId: null, policy: null });
    expect(table.lookup(undefined)).toEqual({ botId: null, policy: null });
  });

  it("forgets everything a control connection said when it closes", () => {
    const table = createPolicyTable();
    const boxd = {};
    const server = {};
    table.apply(boxd, { type: "bind", address: "10.0.0.5", botId: "b1" });
    table.apply(server, {
      type: "policy",
      botId: "b1",
      hosts: [],
      api: { vendor: "anthropic", key: "sk" },
    });
    expect(table.dropOwner(server)).toEqual(["b1"]);
    expect(table.lookup("10.0.0.5")).toEqual({ botId: "b1", policy: null });
    table.apply(server, policy);
    expect(table.dropOwner(boxd)).toEqual(["b1"]);
    expect(table.lookup("10.0.0.5")).toEqual({ botId: null, policy: null });
  });

  it("ends the old bot's connections when its address moves to another bot", () => {
    const table = createPolicyTable();
    const owner = {};
    table.apply(owner, { type: "bind", address: "10.0.0.5", botId: "b1" });
    expect(table.apply(owner, { type: "bind", address: "10.0.0.5", botId: "b2" })).toEqual(["b1"]);
    expect(table.apply(owner, { type: "unbind", address: "10.0.0.5" })).toEqual(["b2"]);
    expect(table.apply(owner, policy)).toEqual(["b1"]);
    expect(table.apply(owner, { type: "forget", botId: "b1" })).toEqual(["b1"]);
    expect(table.lookup("10.0.0.5")).toEqual({ botId: null, policy: null });
  });
});
