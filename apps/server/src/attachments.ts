import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DatabaseSync } from "node:sqlite";

import { AttachmentRef } from "@beebot/contracts";
import { z } from "zod";

export const maxAttachmentBytes = 50 * 1024 * 1024;
export const unclaimedAttachmentMs = 24 * 60 * 60_000;

// Bots can already run anything, so this keeps out only what is plainly a program to launch.
const refusedMimes = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-ms-installer",
  "application/x-msi",
  "application/vnd.microsoft.portable-executable",
  "application/x-executable",
  "application/x-sh",
  "application/x-bat",
]);

// The essence only, lowercased. Null when it isn't a MIME type or is one Bee refuses.
export function attachmentMime(header: string | undefined) {
  const mime = (header?.split(";")[0] ?? "").trim().toLowerCase() || "application/octet-stream";
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime) && !refusedMimes.has(mime)
    ? mime
    : null;
}

// What a box's shell and every file system accept: no path, no hidden or reserved name.
export function attachmentName(raw: string | null | undefined) {
  const base = (raw ?? "").split(/[\\/]/).at(-1) ?? "";
  const name = base
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/^[._ -]+|[. ]+$/g, "")
    .slice(0, 100);
  return name === "" || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ? "file" : name;
}

export const attachmentsDir = (dataDir: string, roomId: string) =>
  NodePath.join(dataDir, "rooms", roomId, "attachments");

export const attachmentPath = (dataDir: string, roomId: string, id: string) =>
  NodePath.join(attachmentsDir(dataDir, roomId), id);

// The name it gets in a bot's inbox. The ID's start keeps two files of one name apart.
export const inboxName = ({ id, name }: { id: string; name: string }) =>
  `${id.slice(0, 8)}-${name}`;

export type InboxFile = { id: string; roomId: string; file: string };

class TooLarge extends Error {}

// Written to a part file and renamed only once whole, so a cut-off upload never looks finished.
export async function receiveAttachment(
  body: Readable,
  dataDir: string,
  roomId: string,
  id: string,
  maxBytes = maxAttachmentBytes,
) {
  const dir = attachmentsDir(dataDir, roomId);
  const part = NodePath.join(dir, `${id}.part`);
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > maxBytes) {
        done(new TooLarge());
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await NodeFS.promises.mkdir(dir, { recursive: true });
  try {
    await pipeline(body, meter, NodeFS.createWriteStream(part));
  } catch (error) {
    await NodeFS.promises.rm(part, { force: true });
    if (error instanceof TooLarge) {
      return "too_large";
    }
    throw error;
  }
  await NodeFS.promises.rename(part, attachmentPath(dataDir, roomId, id));
  return { size, sha256: hash.digest("hex") };
}

const PendingRow = AttachmentRef.extend({ roomId: z.string() });

// Rows join the caller's transaction. An attachment is pending until a message claims it.
export function openAttachments(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO attachments (id, room_id, name, mime, size, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectPending = db.prepare(
    `SELECT id, name, mime, size FROM attachments
     WHERE id = ? AND room_id = ? AND message_id IS NULL`,
  );
  const claim = db.prepare(
    "UPDATE attachments SET message_id = ? WHERE id = ? AND room_id = ? AND message_id IS NULL",
  );
  const selectStale = db.prepare(
    `SELECT id, room_id AS roomId, name, mime, size FROM attachments
     WHERE message_id IS NULL AND created_at < ?`,
  );
  const deleteRow = db.prepare("DELETE FROM attachments WHERE id = ?");

  return {
    addAttachment: (row: AttachmentRef & { roomId: string; sha256: string }) => {
      const { id, roomId, name, mime, size, sha256 } = row;
      insert.run(id, roomId, name, mime, size, sha256, new Date().toISOString());
    },
    // Every ID must be pending in this room, or none is taken.
    claimable: (roomId: string, ids: readonly string[]) => {
      const found = [...new Set(ids)].flatMap((id) => {
        const row = selectPending.get(id, roomId);
        return row ? [AttachmentRef.parse(row)] : [];
      });
      return found.length === new Set(ids).size ? found : undefined;
    },
    claim: (messageId: string, roomId: string, ids: readonly string[]) => {
      for (const id of ids) {
        claim.run(messageId, id, roomId);
      }
    },
    // The rows go first: a file left by a failed delete is harmless, a row without a file isn't.
    sweepAttachments: (cutoff: string) => {
      const stale = z.array(PendingRow).parse(selectStale.all(cutoff));
      for (const { id } of stale) {
        deleteRow.run(id);
      }
      return stale;
    },
  };
}
