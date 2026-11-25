import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { Continuation, type ContinuationReason } from "@beebot/contracts";
import { z } from "zod";

import { openAudit } from "./audit.ts";
import type { StoreTx } from "./store.ts";

const waitingPrefix = "waiting: ";

// What the broker answers a tool call that now waits on the owner. The engine ends its turn on it.
export const waitingMessage = (id: string) =>
  `${waitingPrefix}${id}. The owner has to answer first. End your turn now: you will be resumed with the outcome.`;

export const isWaitingMessage = (message: string) => message.startsWith(waitingPrefix);

// Anywhere in a text, since an engine can wrap the message in words of its own.
export const waitingPattern = /waiting: [0-9a-f-]{36}\. The owner has to answer first\./;

const ContinuationRow = Continuation.extend({
  sessionId: z.string(),
  toolUseId: z.string(),
  request: z.string(),
  payload: z.string(),
  claimedAt: z.string().nullable(),
  result: z.string().nullable(),
  resumedAt: z.string().nullable(),
  resumeRunId: z.string().nullable(),
});
export type ContinuationRow = z.infer<typeof ContinuationRow>;

// What the bot is told once a continuation is final. An unknown outcome says so, and is never
// retried.
export function outcomeText({ kind, status, reason, shown, result }: ContinuationRow) {
  if (status === "succeeded") {
    return kind === "hand_off"
      ? `The owner did this themselves:\n${shown}`
      : `Approved and done:\n${shown}\n\nResult:\n${result ?? ""}`;
  }
  if (status === "failed") {
    return `Approved, but it failed:\n${shown}\n\n${result ?? ""}`;
  }
  if (status === "unknown") {
    return `Outcome unknown: Bee stopped while running this and did not retry it. Check before trying again:\n${shown}`;
  }
  if (status === "expired") {
    return `No answer in time, so this was not run:\n${shown}`;
  }
  if (reason === "payload_changed") {
    return `Not run, because it changed after the owner saw it:\n${shown}`;
  }
  return kind === "hand_off" ? `The owner did not do this:\n${shown}` : `Denied:\n${shown}`;
}

export type NewContinuation = Pick<
  ContinuationRow,
  "botId" | "runId" | "toolUseId" | "kind" | "tool" | "request" | "payload" | "shown" | "digest"
> & { ttlMs: number };

// Where an outcome goes back: the room of the run that asked, as a reply to the bot's last word.
const DeliveryTarget = z.object({
  scopeId: z.string(),
  roomId: z.string(),
  replyToId: z.string().nullable(),
  attended: z.number().transform(Boolean),
});

export type ContinuationRepository = ReturnType<typeof openContinuations>;

// Every change is one conditional UPDATE, so a decision, a claim or a resume happens at most once.
export function openContinuations(db: DatabaseSync, { transaction, emit }: StoreTx) {
  const columns = `id, bot_id AS botId, run_id AS runId, session_id AS sessionId,
    tool_use_id AS toolUseId, kind, tool, request, payload, shown, digest, status, reason,
    created_at AS createdAt, expires_at AS expiresAt, decided_at AS decidedAt,
    claimed_at AS claimedAt, finished_at AS finishedAt, result, resumed_at AS resumedAt,
    resume_run_id AS resumeRunId`;
  const insert = db.prepare(
    `INSERT INTO continuations (id, bot_id, run_id, session_id, tool_use_id, kind, tool, request,
       payload, shown, digest, status, created_at, expires_at)
     VALUES (?, ?, ?, COALESCE((SELECT s.session_id FROM runs r JOIN scopes s ON s.id = r.scope_id
       WHERE r.id = ?), ''), ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?) RETURNING ${columns}`,
  );
  const selectOne = db.prepare(`SELECT ${columns} FROM continuations WHERE id = ?`);
  const selectOpen = db.prepare(
    `SELECT ${columns} FROM continuations WHERE bot_id = ? AND digest = ?
       AND status IN ('waiting', 'approved', 'claimed') ORDER BY rowid LIMIT 1`,
  );
  const selectWaiting = db.prepare(
    `SELECT ${columns} FROM continuations WHERE status = 'waiting' ORDER BY rowid`,
  );
  // Not before the asking run's turn has ended, or settling that turn would close what the
  // outcome reopens.
  const selectUnresumed = db.prepare(
    `SELECT ${columns} FROM continuations WHERE resumed_at IS NULL
     AND status IN ('denied', 'expired', 'succeeded', 'failed', 'unknown')
     AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = continuations.run_id
       AND r.status IN ('Queued', 'Running'))
     ORDER BY rowid`,
  );
  const selectTarget = db.prepare(
    `SELECT s.id AS scopeId, s.room_id AS roomId, w.attended,
       (SELECT m.id FROM messages m WHERE m.room_id = s.room_id AND m.bot_id = c.bot_id
         ORDER BY m.event_seq DESC LIMIT 1) AS replyToId
     FROM continuations c JOIN runs r ON r.id = c.run_id JOIN scopes s ON s.id = r.scope_id
       JOIN wakes w ON w.id = r.wake_id
     WHERE c.id = ?`,
  );
  // An owner's "approve" on a hand_off means they did it themselves.
  const decideOne = db.prepare(
    `UPDATE continuations SET
       status = CASE WHEN ? = 'deny' THEN 'denied' WHEN kind = 'hand_off' THEN 'succeeded'
         ELSE 'approved' END,
       reason = 'owner', decided_at = ?,
       finished_at = CASE WHEN ? = 'deny' OR kind = 'hand_off' THEN ? END
     WHERE id = ? AND status = 'waiting' AND digest = ? AND expires_at > ? RETURNING ${columns}`,
  );
  const denyOne = db.prepare(
    `UPDATE continuations SET status = 'denied', reason = ?, finished_at = ?
     WHERE id = ? AND status IN ('waiting', 'approved') RETURNING ${columns}`,
  );
  // A stop ends the chain, so nothing is delivered back for these.
  const stopForBot = db.prepare(
    `UPDATE continuations SET status = 'denied', reason = 'stopped', finished_at = ?, resumed_at = ?
     WHERE bot_id = ? AND status IN ('waiting', 'approved') RETURNING ${columns}`,
  );
  const claimOne = db.prepare(
    `UPDATE continuations SET status = 'claimed', claimed_at = ?
     WHERE id = ? AND status = 'approved' RETURNING ${columns}`,
  );
  const finishOne = db.prepare(
    `UPDATE continuations SET status = ?, result = ?, finished_at = ?
     WHERE id = ? AND status = 'claimed' RETURNING ${columns}`,
  );
  const expireDue = db.prepare(
    `UPDATE continuations SET status = 'expired', reason = 'timeout', finished_at = ?
     WHERE status = 'waiting' AND expires_at <= ? RETURNING ${columns}`,
  );
  const claimedToUnknown = db.prepare(
    `UPDATE continuations SET status = 'unknown', reason = 'server_restarted', finished_at = ?
     WHERE status = 'claimed' RETURNING ${columns}`,
  );
  const resumeOne = db.prepare(
    `UPDATE continuations SET resumed_at = ? WHERE id = ? AND resumed_at IS NULL
     RETURNING ${columns}`,
  );
  const { appendAudit } = openAudit(db);

  const parse = (row: unknown) => (row === undefined ? undefined : ContinuationRow.parse(row));

  // The digest only, never the payload or what was shown: both can hold the owner's data.
  function changed(row: unknown) {
    const parsed = ContinuationRow.parse(row);
    const { runId, botId, status, reason, tool, digest } = parsed;
    const initiator = status === "waiting" ? "bot" : reason === "owner" ? "human" : "system";
    appendAudit({
      runId,
      botId,
      status: `continuation_${status}`,
      reason,
      tool,
      digest,
      initiator,
    });
    emit({ type: "continuation.changed", continuation: Continuation.parse(parsed) });
    return parsed;
  }

  const one = (row: unknown) => (row === undefined ? undefined : changed(row));
  const now = () => new Date().toISOString();

  return {
    // A bot asking again for what already waits gets the same one back, so a repeat can't make a
    // second card the owner could also approve.
    openContinuation: ({ ttlMs, ...fields }: NewContinuation) =>
      transaction(() => {
        const open = parse(selectOpen.get(fields.botId, fields.digest));
        if (open) {
          return open;
        }
        const createdAt = now();
        const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
        const { botId, runId, toolUseId, kind, tool, request, payload, shown, digest } = fields;
        const row = insert.get(
          NodeCrypto.randomUUID(),
          botId,
          runId,
          runId,
          toolUseId,
          kind,
          tool,
          request,
          payload,
          shown,
          digest,
          createdAt,
          expiresAt,
        );
        return changed(row);
      }),
    getContinuation: (id: string) => parse(selectOne.get(id)),
    waitingContinuations: () => z.array(Continuation).parse(selectWaiting.all()),
    unresumedContinuations: () => z.array(ContinuationRow).parse(selectUnresumed.all()),
    deliveryTarget: (id: string) => DeliveryTarget.optional().parse(selectTarget.get(id)),
    // Bound to the digest of what the owner saw. Past its expiry it is closed, so a late answer
    // changes nothing.
    decideContinuation: (id: string, digest: string, decision: "approve" | "deny") =>
      transaction(() => {
        const at = now();
        const row = one(decideOne.get(decision, at, decision, at, id, digest, at));
        if (row) {
          return row.status;
        }
        const current = parse(selectOne.get(id));
        if (!current) {
          return "not_found";
        }
        return current.digest === digest ? "closed" : "digest_mismatch";
      }),
    denyContinuation: (
      id: string,
      reason: Extract<ContinuationReason, "no_surface" | "payload_changed" | "stopped">,
    ) => transaction(() => one(denyOne.get(reason, now(), id))),
    stopContinuations: (botId: string) =>
      transaction(() => {
        const at = now();
        return stopForBot.all(at, at, botId).map(changed);
      }),
    // Durable before the action runs: from here a crash means `unknown`, and nothing retries it.
    claimContinuation: (id: string) => transaction(() => one(claimOne.get(now(), id))),
    finishContinuation: (id: string, status: "succeeded" | "failed" | "unknown", result: string) =>
      transaction(() => one(finishOne.get(status, result, now(), id))),
    expireContinuations: () =>
      transaction(() => {
        const at = now();
        return expireDue.all(at, at).map(changed);
      }),
    // Waiting ones survive a restart: the owner can still answer them.
    recoverContinuations: () =>
      transaction(() => {
        const at = now();
        return [...claimedToUnknown.all(at), ...expireDue.all(at, at)].map(changed);
      }),
    markResumed: (id: string) => transaction(() => parse(resumeOne.get(now(), id))),
  };
}
