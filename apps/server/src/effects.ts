import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import type { StoreTx } from "./store.ts";

const Effect = z.object({
  id: z.string(),
  runId: z.string(),
  tool: z.string(),
  target: z.string(),
  idempotencyKey: z.string(),
  status: z.enum(["intended", "done", "failed", "uncertain"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Effect = z.infer<typeof Effect>;

const OutboxItem = z.object({
  id: z.string(),
  runId: z.string(),
  kind: z.string(),
  payload: z.string().transform((text): unknown => JSON.parse(text)),
  idempotencyKey: z.string(),
  status: z.enum(["pending", "delivered", "failed"]),
  attempts: z.number(),
  nextAttemptAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OutboxItem = z.infer<typeof OutboxItem>;

// Takes the attempt count so far, failed one included. Null gives up.
export type Backoff = (attempts: number) => number | null;

// An effect is written before the call it describes. One still `intended` after a crash may or
// may not have happened, so it is never retried.
export function openEffects(db: DatabaseSync, { transaction }: StoreTx) {
  const effectColumns = `id, run_id AS runId, tool, target, idempotency_key AS idempotencyKey,
    status, created_at AS createdAt, updated_at AS updatedAt`;
  const insertEffect = db.prepare(
    `INSERT INTO external_effects
     (id, run_id, tool, target, idempotency_key, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'intended', ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`,
  );
  const selectEffectByKey = db.prepare(
    `SELECT ${effectColumns} FROM external_effects WHERE idempotency_key = ?`,
  );
  const settle = db.prepare(
    `UPDATE external_effects SET status = ?, updated_at = ?
     WHERE id = ? AND status = 'intended' RETURNING ${effectColumns}`,
  );
  const selectIntended = db.prepare(
    `SELECT ${effectColumns} FROM external_effects
     WHERE run_id = ? AND status = 'intended' ORDER BY rowid`,
  );

  const outboxColumns = `id, run_id AS runId, kind, payload, idempotency_key AS idempotencyKey,
    status, attempts, next_attempt_at AS nextAttemptAt, created_at AS createdAt,
    updated_at AS updatedAt`;
  const insertOutbox = db.prepare(
    `INSERT INTO outbox (id, run_id, kind, payload, idempotency_key, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`,
  );
  const selectOutbox = db.prepare(`SELECT ${outboxColumns} FROM outbox WHERE id = ?`);
  const selectOutboxByKey = db.prepare(
    `SELECT ${outboxColumns} FROM outbox WHERE idempotency_key = ?`,
  );
  const selectDue = db.prepare(
    `SELECT ${outboxColumns} FROM outbox WHERE status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY rowid`,
  );
  const deliver = db.prepare(
    `UPDATE outbox SET status = 'delivered', updated_at = ?
     WHERE id = ? AND status = 'pending' RETURNING ${outboxColumns}`,
  );
  const retry = db.prepare(
    `UPDATE outbox SET attempts = ?, status = ?, next_attempt_at = ?, updated_at = ?
     WHERE id = ? RETURNING ${outboxColumns}`,
  );

  return {
    // A repeated key returns the first record, whatever its status.
    recordEffect: (input: Pick<Effect, "runId" | "tool" | "target" | "idempotencyKey">) => {
      const now = new Date().toISOString();
      const { runId, tool, target, idempotencyKey } = input;
      insertEffect.run(NodeCrypto.randomUUID(), runId, tool, target, idempotencyKey, now, now);
      return Effect.parse(selectEffectByKey.get(idempotencyKey));
    },
    settleEffect: (id: string, status: Exclude<Effect["status"], "intended">) => {
      const row = settle.get(status, new Date().toISOString(), id);
      return row ? Effect.parse(row) : undefined;
    },
    unsettledEffects: (runId: string) => z.array(Effect).parse(selectIntended.all(runId)),

    enqueueOutbox: (input: {
      runId: string;
      kind: string;
      payload: unknown;
      idempotencyKey: string;
    }) => {
      const now = new Date().toISOString();
      const { runId, kind, payload, idempotencyKey } = input;
      const text = JSON.stringify(payload);
      insertOutbox.run(NodeCrypto.randomUUID(), runId, kind, text, idempotencyKey, now, now);
      return OutboxItem.parse(selectOutboxByKey.get(idempotencyKey));
    },
    duePendingOutbox: (now: string) => z.array(OutboxItem).parse(selectDue.all(now)),
    markDelivered: (id: string) => {
      const row = deliver.get(new Date().toISOString(), id);
      return row ? OutboxItem.parse(row) : undefined;
    },
    markOutboxAttemptFailed: (id: string, backoff: Backoff, now = new Date().toISOString()) =>
      transaction(() => {
        const row = selectOutbox.get(id);
        const item = row ? OutboxItem.parse(row) : undefined;
        if (item?.status !== "pending") {
          return undefined;
        }
        const attempts = item.attempts + 1;
        const delayMs = backoff(attempts);
        const status = delayMs === null ? "failed" : "pending";
        const next = delayMs === null ? null : new Date(Date.parse(now) + delayMs).toISOString();
        return OutboxItem.parse(retry.get(attempts, status, next, now, id));
      }),
  };
}
