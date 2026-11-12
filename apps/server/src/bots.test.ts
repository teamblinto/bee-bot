import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { type EventStore, openEventStore } from "./store.ts";

let dataDir: string;
let store: EventStore;

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-bots-"));
  store = openEventStore(dataDir);
});

afterEach(() => {
  store.close();
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

const newBot = (name: string) =>
  store.createBot({ name, personality: "", engineAccountId: "fake" });

const send = (roomId: string, body: string) =>
  store.sendMessage({ id: NodeCrypto.randomUUID(), roomId, body, attended: true });

const farFuture = "2999-01-01T00:00:00.000Z";

// One finished turn of the bot's, answering the message just sent to it.
function runOnce(botId: string, reply: string) {
  const wake = store.dueWakes(farFuture).find((row) => row.botId === botId);
  if (!wake) {
    throw new Error("no wake");
  }
  store.queueRun(wake);
  const runId = store.queuedRuns().find((run) => run.botId === botId)?.id ?? "";
  const bootId = "boot";
  store.claimRun(runId, bootId, new Date().toISOString());
  store.finishRun(runId, bootId, { status: "Completed", reason: null, reply });
  store.ingestRun(runId);
  return runId;
}

describe("archiving a bot", () => {
  it("cancels its wakes and refuses its DM until restored", () => {
    const ada = newBot("Ada");
    expect(send(ada.roomId, "hi")).toBe("sent");
    expect(store.dueWakes(farFuture)).toHaveLength(1);

    expect(store.archiveBot(ada.id)?.archivedAt).not.toBeNull();
    expect(store.dueWakes(farFuture)).toHaveLength(0);
    expect(send(ada.roomId, "still there?")).toBe("bot_archived");

    expect(store.restoreBot(ada.id)?.archivedAt).toBeNull();
    expect(send(ada.roomId, "welcome back")).toBe("sent");
    expect(store.dueWakes(farFuture)).toHaveLength(1);
  });

  it("posts a notice instead of waking it from a group mention", () => {
    const ada = newBot("Ada");
    const bob = newBot("Bob");
    const room = store.rooms.createGroupRoom({ name: "Team", memberIds: [ada.id, bob.id] });
    store.archiveBot(ada.id);

    expect(send(room?.id ?? "", "@ada and @bob, look")).toBe("sent");

    expect(store.dueWakes(farFuture).map(({ botId }) => botId)).toEqual([bob.id]);
    const notice = store.state().messages.find(({ id }) => id.startsWith("notice:"));
    expect(notice).toMatchObject({ botId: ada.id, roomId: room?.id });
    expect(notice?.body).toContain("archived");
  });

  it("leaves its routines alone and fires none of them", () => {
    const ada = newBot("Ada");
    const routine = store.createRoutine({
      botId: ada.id,
      name: "Daily",
      prompt: "Go",
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      skipIfLaterMins: null,
    });
    store.archiveBot(ada.id);

    store.fireDueRoutines(farFuture);

    const state = store.state();
    expect(state.firings).toHaveLength(0);
    expect(state.routines).toMatchObject([{ id: routine.id, enabled: true }]);
  });
});

describe("deleting a bot", () => {
  it("is refused while it has a run in progress", () => {
    const ada = newBot("Ada");
    send(ada.roomId, "hi");
    for (const wake of store.dueWakes(farFuture)) {
      store.queueRun(wake);
    }

    expect(store.deleteBot(ada.id)).toBe("bot_busy");
    expect(store.getBot(ada.id)).toBeDefined();
  });

  it("removes everything it owned, and keeps what it said in rooms", () => {
    const ada = newBot("Ada");
    const bob = newBot("Bob");
    const room = store.rooms.createGroupRoom({
      name: "Team",
      memberIds: [ada.id, bob.id],
      defaultBotId: ada.id,
    });
    const roomId = room?.id ?? "";
    send(ada.roomId, "hi");
    const runId = runOnce(ada.id, "hello");
    const approval = store.openApproval({ runId, botId: ada.id, tool: "Bash", digest: "d" });
    store.closeApproval(approval.id, "denied", "owner");
    store.addMemory({ botId: ada.id, text: "Likes tea", type: "user" });
    store.createRoutine({
      botId: ada.id,
      name: "Daily",
      prompt: "Go",
      cron: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      skipIfLaterMins: null,
    });
    store.fireDueRoutines(farFuture);
    store.tasks.createTask(
      {
        kind: "delegate",
        chainId: runId,
        hop: 1,
        depth: 1,
        parentRunId: runId,
        requesterBotId: ada.id,
        ownerBotId: bob.id,
        roomId: ada.roomId,
        goal: "Find the file",
        deliveryKey: "key",
        attended: true,
      },
      3,
    );
    send(roomId, "@ada what's new?");
    runOnce(ada.id, "Nothing much");

    expect(store.deleteBot(ada.id)).toBe("deleted");

    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    try {
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const left = (table: string) =>
        db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE bot_id = ?`).get(ada.id);
      for (const table of ["runs", "wakes", "approvals", "memory_items", "routines", "scopes"]) {
        expect(left(table)).toEqual({ count: 0 });
      }
    } finally {
      db.close();
    }
    const state = store.state();
    expect(state.bots.map(({ id }) => id)).toEqual([bob.id]);
    expect(state.rooms.find(({ id }) => id === ada.roomId)).toBeUndefined();
    expect(state.rooms.find(({ id }) => id === roomId)).toMatchObject({
      defaultBotId: null,
      members: [bob.id],
    });
    expect(state.messages.filter(({ roomId: id }) => id === roomId)).toMatchObject([
      { author: "human", body: "@ada what's new?" },
      { author: "bot", botId: null, body: "Nothing much" },
    ]);
    expect(state.messages.some(({ roomId: id }) => id === ada.roomId)).toBe(false);
    expect(state.routines).toEqual([]);
    expect(state.tasks).toEqual([]);
  });
});
