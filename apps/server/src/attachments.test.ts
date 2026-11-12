import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { attachmentName, attachmentPath, receiveAttachment } from "./attachments.ts";
import { type EventStore, openEventStore } from "./store.ts";

let dataDir: string;
let store: EventStore;

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-attachments-"));
  store = openEventStore(dataDir);
});

afterEach(() => {
  store.close();
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

const newBot = (name: string) =>
  store.createBot({ name, personality: "", engineAccountId: "fake" });

function upload(roomId: string, name = "notes.txt") {
  const id = NodeCrypto.randomUUID();
  store.addAttachment({ id, roomId, name, mime: "text/plain", size: 5, sha256: "x" });
  return id;
}

const send = (roomId: string, attachmentIds: string[], id = NodeCrypto.randomUUID()) =>
  store.sendMessage({ id, roomId, body: "see attached", attended: true, attachmentIds });

describe("sending attachments", () => {
  it("claims only uploads still pending in the message's own room", () => {
    const ada = newBot("Ada");
    const bob = newBot("Bob");
    const mine = upload(ada.roomId);
    const theirs = upload(bob.roomId);

    expect(send(ada.roomId, [mine, theirs])).toBe("attachment_not_found");
    expect(send(ada.roomId, [NodeCrypto.randomUUID()])).toBe("attachment_not_found");
    expect(store.state().messages).toEqual([]);

    expect(send(ada.roomId, [mine])).toBe("sent");
    expect(store.state().messages).toMatchObject([
      { roomId: ada.roomId, attachments: [{ id: mine, name: "notes.txt" }] },
    ]);
    expect(send(ada.roomId, [mine])).toBe("attachment_not_found");
  });

  it("names the file's inbox path in the turn and taints the session", () => {
    const ada = newBot("Ada");
    const id = upload(ada.roomId, "plan.md");
    send(ada.roomId, [id]);
    const [wake] = store.dueWakes("2999-01-01T00:00:00.000Z");
    if (!wake) {
      throw new Error("no wake");
    }
    store.queueRun(wake);
    const [run] = store.queuedRuns();

    const claimed = store.claimRun(run?.id ?? "", "boot", new Date().toISOString());

    const file = `${id.slice(0, 8)}-plan.md`;
    expect(claimed?.inbox).toEqual([{ id, roomId: ada.roomId, file }]);
    expect(claimed?.prompt).toContain(NodePath.join("workspace", "inbox", file));
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    const scope = db
      .prepare("SELECT tainted, legs_untrusted AS untrusted FROM scopes WHERE room_id = ?")
      .get(ada.roomId);
    db.close();
    expect(scope).toEqual({ tainted: 1, untrusted: 1 });
  });
});

describe("unsent uploads", () => {
  it("are swept, and sent ones are kept", () => {
    const ada = newBot("Ada");
    const sent = upload(ada.roomId);
    const unsent = upload(ada.roomId);
    send(ada.roomId, [sent]);

    const swept = store.sweepAttachments("2999-01-01T00:00:00.000Z");

    expect(swept.map(({ id }) => id)).toEqual([unsent]);
    expect(store.sweepAttachments("2999-01-01T00:00:00.000Z")).toEqual([]);
    expect(send(ada.roomId, [unsent])).toBe("attachment_not_found");
  });

  it("are kept until they are a day old", () => {
    const ada = newBot("Ada");
    upload(ada.roomId);
    expect(store.sweepAttachments(new Date(Date.now() - 60_000).toISOString())).toEqual([]);
  });
});

describe("receiving an upload", () => {
  it("refuses a file over the limit and leaves nothing behind", async () => {
    const result = await receiveAttachment(
      Readable.from([Buffer.alloc(600), Buffer.alloc(600)]),
      dataDir,
      "room",
      "big",
      1000,
    );

    expect(result).toBe("too_large");
    expect(NodeFS.readdirSync(NodePath.dirname(attachmentPath(dataDir, "room", "big")))).toEqual(
      [],
    );
  });

  it("keeps a file within the limit, with its size and hash", async () => {
    const result = await receiveAttachment(
      Readable.from([Buffer.from("hello")]),
      dataDir,
      "r",
      "f",
    );

    expect(result).toEqual({
      size: 5,
      sha256: NodeCrypto.createHash("sha256").update("hello").digest("hex"),
    });
    expect(NodeFS.readFileSync(attachmentPath(dataDir, "r", "f"), "utf8")).toBe("hello");
  });

  it("keeps a name with no path, hidden dot or reserved device", () => {
    expect(attachmentName("..\\..\\secret/../report final.pdf")).toBe("report final.pdf");
    expect(attachmentName(".bashrc")).toBe("bashrc");
    expect(attachmentName("CON.txt")).toBe("file");
    expect(attachmentName("résumé.pdf")).toBe("re_sume_.pdf");
  });
});
