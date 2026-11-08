import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { AuditEntry, AuditInitiator } from "@beebot/contracts";
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

const entryColumns = `id, run_id AS runId, bot_id AS botId, initiator, attended, status, reason,
  tool, digest, created_at AS createdAt`;
const columns = `${entryColumns}, prev_hash AS prevHash, hash`;

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

// Who set the run going, read from the wake that queued it. A recovery wake continues a turn the
// server cut off, so the system started that one, whoever started the first.
export function initiatorOf(source: string, idempotencyKey: string): AuditInitiator {
  if (idempotencyKey.startsWith("recover:")) {
    return "system";
  }
  if (source === "routine") {
    return "routine";
  }
  return source === "task" || source === "mention" ? "bot" : "human";
}

const RunOrigin = z.object({
  source: z.string(),
  idempotencyKey: z.string(),
  attended: z.number(),
});
const EntryRow = AuditEntry.extend({ attended: z.number().nullable() });

export type AuditRecord = {
  runId: string | null;
  botId: string | null;
  status: string;
  reason: string | null;
  tool?: string | null;
  // Left out on a run's row, both come from the run's wake.
  initiator?: AuditInitiator | null;
  attended?: boolean | null;
  digest?: string | null;
};

export type AuditQuery = {
  botId?: string | undefined;
  unattended: boolean;
  before?: number | undefined;
  limit: number;
};

// Tamper evidence, not prevention: a deleted tail goes unnoticed without checkpoints kept elsewhere.
export function openAudit(db: DatabaseSync) {
  const selectLastHash = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1");
  const insert = db.prepare(
    `INSERT INTO audit_log (run_id, bot_id, initiator, attended, status, reason, tool, digest,
       created_at, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectRunOrigin = db.prepare(
    `SELECT w.source, w.idempotency_key AS idempotencyKey, w.attended
     FROM runs r JOIN wakes w ON w.id = r.wake_id WHERE r.id = ?`,
  );
  // Nobody watching means a run known to be unattended: rows from before M3 say nothing.
  const selectPage = db.prepare(
    `SELECT ${entryColumns} FROM audit_log
     WHERE (?1 IS NULL OR bot_id = ?1) AND (?2 = 0 OR attended = 0) AND (?3 IS NULL OR id < ?3)
     ORDER BY id DESC LIMIT ?4`,
  );
  const origin = (runId: string | null) => {
    const row = runId === null ? undefined : selectRunOrigin.get(runId);
    return row ? RunOrigin.parse(row) : undefined;
  };

  return {
    // Synchronous with one connection, so nothing can land between reading the last hash and
    // inserting after it.
    appendAudit: ({ tool = null, digest = null, ...record }: AuditRecord) => {
      const from =
        record.initiator === undefined || record.attended === undefined
          ? origin(record.runId)
          : undefined;
      const {
        initiator = from ? initiatorOf(from.source, from.idempotencyKey) : null,
        attended = from ? from.attended === 1 : null,
        ...rest
      } = record;
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
    auditPage: ({ botId, unattended, before, limit }: AuditQuery) =>
      z
        .array(EntryRow)
        .parse(selectPage.all(botId ?? null, Number(unattended), before ?? null, limit))
        .map((row) => ({ ...row, attended: row.attended === null ? null : row.attended === 1 })),
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
