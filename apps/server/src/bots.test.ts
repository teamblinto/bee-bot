import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
