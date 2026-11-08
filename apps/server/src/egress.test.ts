import { DatabaseSync } from "node:sqlite";
import { Duplex } from "node:stream";

import { describe, expect, it } from "vite-plus/test";

import { createEgressControl, egressPolicy, type EgressInput, openEgress } from "./egress.ts";
import { migrate } from "./store.ts";
import { apiKeyName, createMemoryVault } from "./vault.ts";

describe("egress policy", () => {
  it.each([
    [{ engineAccountId: "claude", lane: "subscription", hosts: [] }, [], "anthropic", null],
    [{ engineAccountId: "codex", lane: "subscription", hosts: [] }, [], "openai", null],
    [{ engineAccountId: "claude", lane: "api_key", hosts: [] }, [], null, "anthropic"],
    [
      { engineAccountId: "codex", lane: "api_key", hosts: ["PyPI.org."] },
      ["pypi.org"],
      null,
      "openai",
    ],
    [{ engineAccountId: "fake", lane: "subscription", hosts: [] }, [], null, null],
    [{ engineAccountId: "fake", lane: "api_key", hosts: [] }, [], null, null],
    [
      { engineAccountId: "claude", lane: "api_key", hosts: ["github.com", "10.0.0.1", "a b", ""] },
      ["github.com"],
      null,
      "anthropic",
    ],
  ] as [EgressInput, string[], string | null, string | null][])(
    "%j",
    (input, hosts, subscription, apiVendor) => {
      expect(egressPolicy(input)).toEqual({ hosts, subscription, apiVendor });
    },
  );

  it("reads a bot's lane and granted hosts", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    db.prepare(
      `INSERT INTO bots (id, name, personality, status, engine_account_id, created_at)
       VALUES ('b1', 'Bee', '', 'ready', 'codex', '2026-01-01')`,
    ).run();
    db.prepare("UPDATE engine_accounts SET lane = 'api_key' WHERE id = 'codex'").run();
    db.prepare(
      "INSERT INTO bot_egress_hosts (bot_id, host, created_at) VALUES ('b1', 'pypi.org', '2026-01-01')",
    ).run();
    const egress = openEgress(db);
    expect(egress.egressInput("b1")).toEqual({
      engineAccountId: "codex",
      lane: "api_key",
      hosts: ["pypi.org"],
    });
    expect(egress.egressInput("nobody")).toBeNull();
  });
});

// Stands in for the proxy's control socket: records lines and answers each with `reply`.
function fakeProxy(reply: (message: Record<string, unknown>) => object = () => ({ ok: true })) {
  const received: Record<string, unknown>[][] = [];
  const streams: Duplex[] = [];
  const connect = async () => {
    const lines: Record<string, unknown>[] = [];
    received.push(lines);
    const stream: Duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
          const message = JSON.parse(line) as Record<string, unknown>;
          lines.push(message);
          stream.push(`${JSON.stringify(reply(message))}\n`);
        }
        callback();
      },
    });
    streams.push(stream);
    return stream;
  };
  return { connect, received, streams };
}

const inputs: Record<string, EgressInput> = {
  api: { engineAccountId: "claude", lane: "api_key", hosts: ["pypi.org"] },
  sub: { engineAccountId: "claude", lane: "subscription", hosts: [] },
};

describe("egress control", () => {
  it("pushes the vault's key only for an API-lane bot", async () => {
    const vault = createMemoryVault();
    await vault.put(apiKeyName("claude"), "sk-ant-secret");
    const proxy = fakeProxy();
    const control = createEgressControl({
      connect: proxy.connect,
      vault,
      egressInput: (botId) => inputs[botId] ?? null,
    });
    await control.apply("api");
    await control.apply("sub");
    await control.apply("gone");
    expect(proxy.received[0]).toEqual([
      {
        type: "policy",
        botId: "api",
        hosts: ["pypi.org"],
        subscription: null,
        api: { vendor: "anthropic", key: "sk-ant-secret" },
      },
      { type: "policy", botId: "sub", hosts: [], subscription: "anthropic", api: null },
      { type: "forget", botId: "gone" },
    ]);
  });

  it("sends no API lane when the vault has no key", async () => {
    const proxy = fakeProxy();
    const control = createEgressControl({
      connect: proxy.connect,
      vault: createMemoryVault(),
      egressInput: (botId) => inputs[botId] ?? null,
    });
    await control.apply("api");
    expect(proxy.received[0]?.[0]).toMatchObject({ botId: "api", api: null });
  });

  it("pushes every applied bot again after the link drops", async () => {
    const vault = createMemoryVault();
    await vault.put(apiKeyName("claude"), "sk-ant-secret");
    const proxy = fakeProxy();
    const control = createEgressControl({
      connect: proxy.connect,
      vault,
      egressInput: (botId) => inputs[botId] ?? null,
    });
    await control.apply("api");
    await control.apply("sub");
    await control.forget("sub");
    proxy.streams[0]?.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    await control.apply("sub");
    expect(proxy.received[1]?.map(({ botId }) => botId)).toEqual(["api", "sub"]);
    expect(proxy.received[1]?.[0]).toMatchObject({ api: { key: "sk-ant-secret" } });
  });

  it("rejects when the proxy refuses, without putting the key in the error", async () => {
    const vault = createMemoryVault();
    await vault.put(apiKeyName("claude"), "sk-ant-secret");
    const proxy = fakeProxy(() => ({ ok: false, error: "policy has a bad host" }));
    const control = createEgressControl({
      connect: proxy.connect,
      vault,
      egressInput: (botId) => inputs[botId] ?? null,
    });
    const error = await control.apply("api").catch((caught: Error) => caught);
    expect(String(error)).toBe("Error: egress refused: policy has a bad host");
    await expect(
      createEgressControl({
        connect: () => Promise.reject(new Error("no proxy")),
        vault,
        egressInput: (botId) => inputs[botId] ?? null,
      }).apply("api"),
    ).rejects.toThrow("no proxy");
  });
});
