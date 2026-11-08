import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Bot } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { findCandidates, handoffPath } from "./ingest.ts";
import { pruneEvents } from "./retention.ts";
import { type EventStore, openEventStore } from "./store.ts";

let dataDir: string;
let store: EventStore;

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-ingest-"));
  store = openEventStore(dataDir);
});

afterEach(() => {
  store.close();
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

const addBot = () => store.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });

function turn(bot: Bot, body: string, reply = "done") {
  store.sendMessage({ id: NodeCrypto.randomUUID(), roomId: bot.roomId, body, attended: true });
  const now = new Date().toISOString();
  store.dueWakes(now).forEach(store.queueRun);
  const claimed = store.claimRun(store.queuedRuns()[0]?.id ?? "", "boot", now);
  if (!claimed) {
    throw new Error("the run was not claimed");
  }
  store.finishRun(claimed.id, "boot", {
    status: "Completed",
    reason: null,
    reply,
    tools: ["Read", "Read", "Bash"],
  });
  store.ingestRun(claimed.id);
  return claimed.id;
}

const candidates = (botId: string) =>
  store.state().memories.filter((m) => m.botId === botId && m.sourceRef.startsWith("message:"));

describe("candidate memories", () => {
  it("quote the owner's statements and skip questions and tasks", () => {
    const found = findCandidates(
      "Please remember that the repo is on GitLab. Can you check the build? Fix the test.\n" +
        "I prefer short answers! Never force-push to main.",
    );
    expect(found).toEqual([
      { index: 0, type: "user", text: 'Owner said: "Please remember that the repo is on GitLab."' },
      { index: 3, type: "user", text: 'Owner said: "I prefer short answers!"' },
      { index: 4, type: "feedback", text: 'Owner said: "Never force-push to main."' },
    ]);
  });

  it("wait for the owner and are proposed once, however often a turn is ingested", () => {
    const bot = addBot();
    const runId = turn(bot, "My name is Sam. What's the weather?");
    store.ingestRun(runId);
    turn(bot, "thanks");
    expect(candidates(bot.id)).toMatchObject([
      { status: "pending", source: "user", type: "user", text: 'Owner said: "My name is Sam."' },
    ]);
  });
});

describe("the turn summary", () => {
  it("records the turn and survives event pruning", () => {
    const bot = addBot();
    const runId = turn(bot, "list the files", "Here they are.");
    pruneEvents(store, Date.now() + 31 * 24 * 60 * 60_000);
    expect(store.bounds()).toEqual({ oldest: 1, latest: 0 });
    expect(store.turnSummaries(bot.id)).toMatchObject([
      {
        runId,
        status: "Completed",
        asked: "list the files",
        replied: "Here they are.",
        tools: ["Read", "Bash"],
      },
    ]);
    expect(store.state().messages).toHaveLength(2);
  });

  it("keeps events younger than 30 days", () => {
    const bot = addBot();
    turn(bot, "hello");
    const { latest } = store.bounds();
    pruneEvents(store, Date.now() + 29 * 24 * 60 * 60_000);
    expect(store.bounds().latest).toBe(latest);
  });
});

describe("HANDOFF.md", () => {
  it("lists the latest turns newest first and is the same when rebuilt", () => {
    const bot = addBot();
    turn(bot, "first question", "first answer");
    const runId = turn(bot, "second\nquestion", "second answer");
    const path = handoffPath(dataDir, bot.id);
    const text = NodeFS.readFileSync(path, "utf8");
    expect(text.indexOf('Asked: "second question"')).toBeLessThan(text.indexOf("first question"));
    expect(text).toContain('Replied: "second answer". Tools: Read, Bash.');
    store.ingestRun(runId);
    expect(NodeFS.readFileSync(path, "utf8")).toBe(text);
    expect(NodeFS.readdirSync(NodePath.dirname(path))).toEqual(["HANDOFF.md"]);
  });
});
