import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, expect, it } from "vite-plus/test";

import { storeBrowserDeps } from "./browser.ts";
import { openEventStore } from "./store.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function setup() {
  const dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-takeover-"));
  const store = openEventStore(dataDir);
  cleanups.push(() => {
    store.close();
    NodeFS.rmSync(dataDir, { recursive: true, force: true });
  });
  const bot = store.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
  store.sendMessage({ id: "m", roomId: bot.roomId, body: "sign me in", attended: true });
  const [wake] = store.dueWakes(new Date().toISOString());
  store.queueRun(wake as NonNullable<typeof wake>);
  const runId = store.queuedRuns()[0]?.id ?? "";
  store.claimRun(runId, "boot", new Date().toISOString());
  return { store, bot, run: { id: runId, botId: bot.id, attended: true } };
}

it("answers the bot that asked once the owner hands a taken takeover back", () => {
  const { store, bot, run } = setup();
  const { takeovers } = storeBrowserDeps(store);
  const asked = takeovers.request(run, "sign in");
  expect(takeovers.request(run, "again").id).toBe(asked.id);
  expect(takeovers.complete(bot.id)).toBeUndefined();
  expect(takeovers.take(bot.id)).toMatchObject({ id: asked.id, state: "taken" });
  expect(takeovers.complete(bot.id)).toMatchObject({ state: "completed" });
  const resend = { id: `takeover:${asked.id}`, roomId: bot.roomId, body: "x", attended: true };
  expect(store.sendMessage(resend)).toBe("conflict");
  expect(takeovers.request(run, "next").id).not.toBe(asked.id);
});

it("wakes the bot when nobody took over, once the pause is lifted", () => {
  const { store, bot, run } = setup();
  const { takeovers } = storeBrowserDeps(store);
  const asked = takeovers.request(run, "sign in");
  const order: string[] = [];
  store.onEvent((event) => order.push(event.type));
  expect(takeovers.expire(asked.id, () => order.push("release"))).toMatchObject({
    state: "expired",
  });
  expect(order[0]).toBe("release");
  const resend = { id: `takeover:${asked.id}`, roomId: bot.roomId, body: "x", attended: true };
  expect(store.sendMessage(resend)).toBe("conflict");
  expect(takeovers.expire(asked.id, () => order.push("again"))).toBeUndefined();
  expect(order).not.toContain("again");
});

it("a restart interrupts open takeovers and lifts only the pause they set", () => {
  const { store, bot, run } = setup();
  const other = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
  const { takeovers } = storeBrowserDeps(store);
  const waiting = takeovers.request(run, "sign in");
  store.setBotPause(bot.id, "browser_session");
  takeovers.request({ ...run, botId: other.id }, "solve it");
  takeovers.take(other.id);
  store.setBotPause(other.id, "owner");

  store.recoverTakeovers();
  expect(store.getBot(bot.id)).toMatchObject({ status: "ready", pauseReason: null });
  expect(store.getBot(other.id)).toMatchObject({ status: "paused", pauseReason: "owner" });
  expect(takeovers.take(bot.id)).toBeUndefined();
  expect(takeovers.complete(other.id)).toBeUndefined();
  expect(takeovers.expire(waiting.id, () => {})).toBeUndefined();
});
