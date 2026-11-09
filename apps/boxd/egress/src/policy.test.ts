import { describe, expect, it } from "vite-plus/test";

import {
  apiTarget,
  connectHosts,
  decideConnect,
  decideResolved,
  hostAllowed,
  isDeniedAddress,
  keyHeader,
} from "./policy.ts";

describe("allowlist matching", () => {
  const allow = ["api.anthropic.com", "pypi.org"];
  it.each([
    ["api.anthropic.com", true],
    ["API.Anthropic.COM", true],
    ["api.anthropic.com.", true],
    ["pypi.org", true],
    ["evilapi.anthropic.com", false],
    ["api.anthropic.com.attacker", false],
    ["evilapi.anthropic.com.attacker", false],
    ["api.anthropic.com.attacker.example", false],
    ["x.api.anthropic.com", false],
    ["anthropic.com", false],
    ["api-anthropic.com", false],
    ["api.anthropic.com..", false],
    [".api.anthropic.com", false],
    ["api.anthropic.com@evil.example", false],
    ["evil.example#api.anthropic.com", false],
    ["api.anthropic.com:443", false],
    ["api%2eanthropic.com", false],
    ["аpi.anthropic.com", false],
    ["api.anthropic.com\u0000.evil.example", false],
    ["*.anthropic.com", false],
    ["", false],
  ])("%j -> %s", (host, allowed) => {
    expect(hostAllowed(allow, host)).toBe(allowed);
  });
});

describe("CONNECT targets", () => {
  const allow = ["api.anthropic.com", "localtest.me"];
  it.each([
    ["api.anthropic.com:443", "allow"],
    ["API.ANTHROPIC.COM.:443", "allow"],
    ["api.anthropic.com:80", "port not 443"],
    ["api.anthropic.com:0443", "allow"],
    ["api.anthropic.com:22", "port not 443"],
    ["api.anthropic.com", "bad target"],
    ["api.anthropic.com:443:443", "bad target"],
    ["github.com:443", "host not allowlisted"],
    ["evilapi.anthropic.com.attacker:443", "host not allowlisted"],
    ["160.79.104.10:443", "IP literal"],
    ["127.0.0.1:443", "IP literal"],
    ["[::1]:443", "IP literal"],
    ["[::ffff:10.89.173.10]:443", "IP literal"],
    ["2130706433:443", "bad host"],
    ["0x7f.1:443", "bad host"],
    ["localhost:443", "bad host"],
    ["beebot-browser:9222", "port not 443"],
    ["beebot-browser:443", "bad host"],
    ["user@api.anthropic.com:443", "bad host"],
  ])("%j -> %s", (authority, expected) => {
    const decision = decideConnect(allow, authority);
    expect(decision.allow ? "allow" : decision.reason).toBe(expected);
  });
});

describe("CONNECT by lane", () => {
  // The owner granted pypi.org, and also tried vendor hosts, which only a lane can open.
  const granted = ["pypi.org", "api.anthropic.com", "platform.claude.com", "chatgpt.com"];
  const lanes = {
    subscription: connectHosts(granted, "anthropic"),
    api: connectHosts(granted, null),
  };
  it.each([
    ["subscription", "platform.claude.com:443", "allow"],
    ["subscription", "api.anthropic.com:443", "allow"],
    ["subscription", "pypi.org:443", "allow"],
    ["subscription", "claude.ai:443", "host not allowlisted"],
    ["subscription", "claude.com:443", "host not allowlisted"],
    ["subscription", "chatgpt.com:443", "host not allowlisted"],
    ["subscription", "github.com:443", "host not allowlisted"],
    ["api", "api.anthropic.com:443", "host not allowlisted"],
    ["api", "platform.claude.com:443", "host not allowlisted"],
    ["api", "chatgpt.com:443", "host not allowlisted"],
    ["api", "pypi.org:443", "allow"],
    ["api", "github.com:443", "host not allowlisted"],
  ] as const)("%s lane: %s -> %s", (lane, authority, expected) => {
    const decision = decideConnect(lanes[lane], authority);
    expect(decision.allow ? "allow" : decision.reason).toBe(expected);
  });

  it.each([
    ["www.wikipedia.org:443", "allow"],
    ["platform.claude.com:443", "allow"],
    ["api.anthropic.com:443", "allow"],
    ["chatgpt.com:443", "host not allowlisted"],
    ["www.wikipedia.org:80", "port not 443"],
    ["169.254.169.254:443", "IP literal"],
    ["localhost:443", "bad host"],
  ] as const)("any site on the subscription lane: %s -> %s", (authority, expected) => {
    const decision = decideConnect(lanes.subscription, authority, true);
    expect(decision.allow ? "allow" : decision.reason).toBe(expected);
  });

  it("keeps the vendor closed to any site on the API lane", () => {
    expect(decideConnect(lanes.api, "api.anthropic.com:443", true)).toMatchObject({ allow: false });
    expect(hostAllowed(lanes.api, "api.anthropic.com", true)).toBe(false);
    expect(hostAllowed(lanes.api, "www.wikipedia.org", true)).toBe(true);
  });

  it("adds a key only on the API lane's own host, never to a login host", () => {
    expect(keyHeader("anthropic", new URL("https://platform.claude.com/v1/oauth/token"), "k")).toBe(
      null,
    );
    expect(apiTarget("anthropic", "/anthropic//platform.claude.com/v1/oauth/token")).toBeNull();
  });
});

describe("SSRF deny ranges", () => {
  it.each([
    ["0.0.0.0", true],
    ["10.89.173.10", true],
    ["100.64.0.1", true],
    ["100.100.100.200", true],
    ["127.0.0.1", true],
    ["127.255.255.254", true],
    ["169.254.169.254", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.0.0.170", true],
    ["192.0.2.1", true],
    ["192.168.1.1", true],
    ["198.18.0.1", true],
    ["224.0.0.1", true],
    ["255.255.255.255", true],
    ["::", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["::FFFF:169.254.169.254", true],
    ["::ffff:10.0.0.1", true],
    ["::127.0.0.1", true],
    ["64:ff9b::a9fe:a9fe", true],
    ["64:ff9b:1::1", true],
    ["100::1", true],
    ["fc00::1", true],
    ["fd00:ec2::254", true],
    ["fe80::1", true],
    ["fe80::1%eth0", true],
    ["fec0::1", true],
    ["ff02::1", true],
    ["2001::1", true],
    ["2001:db8::1", true],
    ["2002:7f00:1::1", true],
    ["not an address", true],
    ["", true],
    ["160.79.104.10", false],
    ["8.8.8.8", false],
    ["172.32.0.1", false],
    ["100.128.0.1", false],
    ["11.0.0.1", false],
    ["::ffff:160.79.104.10", false],
    ["2607:6bc0::10", false],
    ["2a00:1450:4001:80b::200e", false],
  ])("%s denied: %s", (address, denied) => {
    expect(isDeniedAddress(address)).toBe(denied);
  });

  it("refuses a name when any of its addresses is denied, and prefers IPv4", () => {
    expect(decideResolved(["160.79.104.10", "10.0.0.1"])).toEqual({
      allow: false,
      reason: "resolved to denied range",
    });
    expect(decideResolved([])).toEqual({ allow: false, reason: "no address" });
    expect(decideResolved(["2607:6bc0::10", "160.79.104.10"])).toEqual({
      allow: true,
      address: "160.79.104.10",
    });
  });
});

describe("API lane target and key injection", () => {
  it.each([
    ["/anthropic/v1/messages", "https://api.anthropic.com/v1/messages"],
    ["/anthropic/v1/messages?beta=true", "https://api.anthropic.com/v1/messages?beta=true"],
    ["/anthropic/v1/../v1/messages", "https://api.anthropic.com/v1/messages"],
    ["/anthropic/%2F%2Fexample.com/x", "https://api.anthropic.com/%2F%2Fexample.com/x"],
    ["/anthropic/@example.com/x", "https://api.anthropic.com/@example.com/x"],
    ["/anthropic/https://example.com/", "https://api.anthropic.com/https://example.com/"],
    ["/anthropic/..//example.com/", "https://api.anthropic.com//example.com/"],
    // S1's bug: `new URL("/" + rest, upstream)` sent these, with the key, to example.com.
    ["/anthropic//example.com/", null],
    ["/anthropic//10.89.173.10:9222/json", null],
    ["/anthropic/\\\\example.com/", null],
    ["/anthropic/\\example.com", null],
    ["/anthropic/", null],
    ["/anthropic", null],
    ["/openai/v1/responses", null],
    ["//example.com/anthropic/v1", null],
    ["http://example.com/anthropic/v1", null],
  ])("%j -> %s", (path, expected) => {
    expect(apiTarget("anthropic", path)?.href ?? null).toBe(expected);
  });

  it("builds the OpenAI target on its own host", () => {
    expect(apiTarget("openai", "/openai/v1/responses")?.href).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(apiTarget("openai", "/openai//api.anthropic.com/v1/messages")).toBeNull();
  });

  it.each([
    ["anthropic", "https://api.anthropic.com/v1/messages", ["x-api-key", "k"]],
    ["openai", "https://api.openai.com/v1/responses", ["authorization", "Bearer k"]],
    ["anthropic", "https://api.openai.com/v1/responses", null],
    ["openai", "https://api.anthropic.com/v1/messages", null],
    ["anthropic", "http://api.anthropic.com/v1/messages", null],
    ["anthropic", "https://api.anthropic.com:8443/v1/messages", null],
    ["anthropic", "https://example.com/v1/messages", null],
    ["anthropic", "https://evilapi.anthropic.com/v1", null],
    ["anthropic", "https://api.anthropic.com.attacker/v1", null],
    ["anthropic", "https://user@api.anthropic.com/v1", null],
    ["anthropic", "https://10.89.173.10/v1", null],
  ] as const)("%s key for %s -> %j", (vendor, url, expected) => {
    expect(keyHeader(vendor, new URL(url), "k")).toEqual(expected);
  });

  it("never makes a header from an empty key", () => {
    expect(keyHeader("anthropic", new URL("https://api.anthropic.com/v1"), "")).toBeNull();
  });
});
