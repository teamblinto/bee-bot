import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { AuditInitiator } from "@beebot/contracts";
import { z } from "zod";

const AuditRow = z.object({
  id: z.number(),
  runId: z.string().nullable(),
  botId: z.string().nullable(),
  initiator: AuditInitiator.nullable(),
  attended: z.number().nullable(),
  status: z.string(),
  reason: z.string().nullable(),
  tool: z.string().nullable(),
  digest: z.string().nullable(),
  createdAt: z.string(),
  prevHash: z.string(),
  hash: z.string(),
});
type Hashed = Omit<z.infer<typeof AuditRow>, "id" | "prevHash" | "hash">;

const columns = `id, run_id AS runId, bot_id AS botId, initiator, attended, status, reason, tool,
  digest, created_at AS createdAt, prev_hash AS prevHash, hash`;

export const auditHash = (prevHash: string, row: Hashed) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        prevHash,
        row.runId,
        row.botId,
        row.initiator,
        row.attended,
        row.status,
        row.reason,
        row.tool,
        row.digest,
        row.createdAt,
      ]),
    )
    .digest("hex");

function allRows(db: DatabaseSync) {
  return z.array(AuditRow).parse(db.prepare(`SELECT ${columns} FROM audit_log ORDER BY id`).all());
}

// For the migration that adds the chain: hashes the rows already there, oldest first.
export function chainAudit(db: DatabaseSync) {
  const update = db.prepare("UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = ?");
  let prevHash = "";
  for (const row of allRows(db)) {
    const hash = auditHash(prevHash, row);
    update.run(prevHash, hash, row.id);
    prevHash = hash;
  }
}

export type AuditRecord = {
  runId: string | null;
  botId: string | null;
  status: string;
  reason: string | null;
  tool?: string | null;
  initiator?: AuditInitiator | null;
  attended?: boolean | null;
  digest?: string | null;
};

// Tamper evidence, not prevention: a deleted tail goes unnoticed without checkpoints kept elsewhere.
export function openAudit(db: DatabaseSync) {
  const selectLastHash = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1");
  const insert = db.prepare(
    `INSERT INTO audit_log (run_id, bot_id, initiator, attended, status, reason, tool, digest,
       created_at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    // Synchronous with one connection, so nothing can land between reading the last hash and
    // inserting after it.
    appendAudit: ({
      tool = null,
      initiator = null,
      attended = null,
      digest = null,
      ...rest
    }: AuditRecord) => {
      const row: Hashed = {
        ...rest,
        tool,
        initiator,
        attended: attended === null ? null : Number(attended),
        digest,
        createdAt: new Date().toISOString(),
      };
      const last = z.object({ hash: z.string() }).optional().parse(selectLastHash.get());
      const prevHash = last?.hash ?? "";
      const { runId, botId, status, reason, createdAt } = row;
      insert.run(
        runId,
        botId,
        initiator,
        row.attended,
        status,
        reason,
        tool,
        digest,
        createdAt,
        prevHash,
        auditHash(prevHash, row),
      );
    },
    // The first row that doesn't follow from the one before it, or null for an intact chain.
    brokenAuditRow: () => {
      let prevHash = "";
      for (const row of allRows(db)) {
        if (row.prevHash !== prevHash || row.hash !== auditHash(prevHash, row)) {
          return row.id;
        }
        prevHash = row.hash;
      }
      return null;
    },
  };
}
