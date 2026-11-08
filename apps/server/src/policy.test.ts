import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { initiatorOf } from "./audit.ts";
import { auditQuery } from "./policy.ts";
import { type EventStore, openEventStore } from "./store.ts";

let dataDir: string;
let store: EventStore;
let db: DatabaseSync;

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-policy-"));
  store = openEventStore(dataDir);
  db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"), { timeout: 5000 });
});

afterEach(() => {
  db.close();
  store.close();
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

function startRun(attended = true) {
  const bot = store.createBot({
    name: `Ada ${crypto.randomUUID()}`,
    personality: "",
    engineAccountId: "fake",
  });
  store.sendMessage({ id: crypto.randomUUID(), roomId: bot.roomId, body: "hi", attended });
  const now = new Date().toISOString();
  const wake = store.dueWakes(now).find((due) => due.botId === bot.id);
  if (!wake) {
    throw new Error("no wake");
  }
  store.queueRun(wake);
  const queued = store.queuedRuns().find((run) => run.botId === bot.id);
  const claimed = queued && store.claimRun(queued.id, "boot", now);
  if (!claimed) {
    throw new Error("no run");
  }
  return { bot, run: { id: claimed.id, botId: bot.id, attended } };
}

const legs = (runId: string) =>
  db
    .prepare(
      `SELECT s.legs_untrusted AS a, s.legs_private AS b, s.legs_side_effect AS c, s.tainted
       FROM scopes s JOIN runs r ON r.scope_id = s.id WHERE r.id = ?`,
    )
    .get(runId);

const lastAudit = () => store.policy.auditPage({ unattended: false, limit: 1 }).entries[0];

describe("broker taint", () => {
  it("sets the session's legs from the tool's labels on allow, and not on deny", () => {
    const { bot, run } = startRun();
    expect(store.policy.check(run, "memory_search", { query: "x" }).kind).toBe("allow");
    expect(legs(run.id)).toEqual({ a: 0, b: 1, c: 0, tainted: 0 });
    // Not in the manifest: refused, and the session stays clean of untrusted input.
    expect(store.policy.check(run, "browser_navigate", { url: "https://x" }).kind).toBe("deny");
    expect(legs(run.id)).toMatchObject({ a: 0 });
    db.prepare("UPDATE bots SET manifest = ? WHERE id = ?").run('["browser"]', bot.id);
    expect(store.policy.check(run, "browser_navigate", { url: "https://x" }).kind).toBe("approve");
    expect(legs(run.id)).toEqual({ a: 1, b: 1, c: 1, tainted: 1 });
  });

  it("clears the legs when the session starts over", () => {
    const { run } = startRun();
    store.policy.check(run, "send_message", { text: "x" });
    store.policy.check(run, "Read", { file_path: "a" });
    expect(legs(run.id)).toMatchObject({ b: 1, c: 1 });
    store.restartSession(run.id, false);
    expect(legs(run.id)).toEqual({ a: 0, b: 0, c: 0, tainted: 0 });
    // A new session launched with memory holds it again.
    store.restartSession(run.id, true);
    expect(legs(run.id)).toEqual({ a: 0, b: 1, c: 0, tainted: 0 });
  });

  it("follows a profile change on the next call", () => {
    const { bot, run } = startRun(false);
    expect(store.policy.check(run, "send_message", { text: "x" }).kind).toBe("allow");
    expect(store.policy.setBotProfile(bot.id, "reader")?.profile).toBe("reader");
    expect(store.policy.check(run, "send_message", { text: "x" })).toEqual({
      kind: "deny",
      reason: "nobody_watching",
    });
  });
});

describe("audit", () => {
  it("records who started the run, whether anyone watched, and only a digest of the input", () => {
    const { run } = startRun(false);
    store.policy.check(run, "send_message", { text: "the secret plan" });
    const entry = lastAudit();
    expect(entry).toMatchObject({
      runId: run.id,
      initiator: "human",
      attended: false,
      status: "allow",
      tool: "send_message",
    });
    expect(entry?.digest).toMatch(/^[0-9a-f]{64}$/);
    const raw = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
    expect(raw).not.toContain("secret plan");
  });

  it("keeps no digest of typed input", () => {
    const { bot, run } = startRun();
    db.prepare("UPDATE bots SET manifest = ?, profile = ? WHERE id = ?").run(
      '["browser"]',
      "researcher",
      bot.id,
    );
    store.policy.check(run, "browser_type", { text: "hunter2" });
    expect(lastAudit()).toMatchObject({ tool: "browser_type", digest: null });
  });

  it("filters to rows nobody watched", () => {
    const watched = startRun(true);
    store.policy.check(watched.run, "notify", { text: "x" });
    store.finishRun(watched.run.id, "boot", {
      status: "Completed",
      reason: null,
      reply: "done",
      tools: [],
    });
    const page = store.policy.auditPage({ unattended: true, limit: 200 });
    expect(page.entries.every(({ attended }) => attended === false)).toBe(true);
    const alone = startRun(false);
    store.policy.check(alone.run, "notify", { text: "x" });
    const after = store.policy.auditPage({ unattended: true, limit: 200 });
    expect(after.entries.some(({ runId }) => runId === alone.run.id)).toBe(true);
    expect(after.entries.some(({ runId }) => runId === watched.run.id)).toBe(false);
  });

  it("reports the first row an edit or a delete broke", () => {
    const { run } = startRun();
    store.policy.check(run, "notify", { text: "x" });
    store.policy.check(run, "memory_get", { id: "x" });
    expect(store.policy.auditPage({ unattended: false, limit: 1 }).brokenRowId).toBeNull();
    const ids = store.policy
      .auditPage({ unattended: false, limit: 200 })
      .entries.map(({ id }) => id)
      .reverse();
    const [, second, third] = ids;

    db.prepare("UPDATE audit_log SET status = 'deny' WHERE id = ?").run(second ?? 0);
    expect(store.policy.auditPage({ unattended: false, limit: 1 }).brokenRowId).toBe(second);

    db.prepare("DELETE FROM audit_log WHERE id = ?").run(second ?? 0);
    expect(store.policy.auditPage({ unattended: false, limit: 1 }).brokenRowId).toBe(third);
  });

  it("names the initiator from the wake", () => {
    expect(initiatorOf("human", "message:1")).toBe("human");
    expect(initiatorOf("continue", "continue:1")).toBe("human");
    expect(initiatorOf("continue", "recover:1")).toBe("system");
    expect(initiatorOf("routine", "firing:1")).toBe("routine");
    expect(initiatorOf("task", "task:1")).toBe("bot");
    expect(initiatorOf("mention", "message:1")).toBe("bot");
  });

  it("reads its query from the URL and refuses junk", () => {
    const url = (search: string) => new URL(`http://h/audit${search}`);
    expect(auditQuery(url("?unattended=1"))).toMatchObject({ unattended: true });
    expect(auditQuery(url("?botId=nope"))).toBeUndefined();
    expect(auditQuery(url("?before=-1"))).toBeUndefined();
  });
});
