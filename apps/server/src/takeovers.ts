import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { z } from "zod";

import type { StoreTx } from "./store.ts";

export const takeoverTtlMs = 10 * 60_000;

const TakeoverState = z.enum([
  "waiting",
  "taken",
  "completed",
  "cancelled",
  "expired",
  "interrupted",
]);
type TakeoverState = z.infer<typeof TakeoverState>;

const Takeover = z.object({
  id: z.string(),
  botId: z.string(),
  runId: z.string(),
  reason: z.string(),
  state: TakeoverState,
});
export type Takeover = z.infer<typeof Takeover>;

// Where the owner's handback goes: the room of the run that asked, as a reply to the bot's last word.
const Target = z.object({ roomId: z.string(), replyToId: z.string().nullable() });

// A bot asking the owner to drive its desktop: waiting → taken → completed, or cancelled, expired
// or interrupted. At most one is open per bot, and every move is one conditional UPDATE.
export function openTakeovers(db: DatabaseSync, { transaction }: StoreTx) {
  const columns = "id, bot_id AS botId, run_id AS runId, reason, state";
  const insert = db.prepare(
    `INSERT INTO takeovers (id, bot_id, run_id, reason, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'waiting', ?, ?) RETURNING ${columns}`,
  );
  const selectOpen = db.prepare(
    `SELECT ${columns} FROM takeovers WHERE bot_id = ? AND state IN ('waiting', 'taken')`,
  );
  const moveBot = db.prepare(
    `UPDATE takeovers SET state = ?, updated_at = ? WHERE bot_id = ? AND state = ?
     RETURNING ${columns}`,
  );
  const moveOne = db.prepare(
    `UPDATE takeovers SET state = ?, updated_at = ? WHERE id = ? AND state = ? RETURNING ${columns}`,
  );
  const interruptAll = db.prepare(
    `UPDATE takeovers SET state = 'interrupted', updated_at = ? WHERE state IN ('waiting', 'taken')
     RETURNING ${columns}`,
  );
  const selectTarget = db.prepare(
    `SELECT s.room_id AS roomId,
       (SELECT m.id FROM messages m WHERE m.room_id = s.room_id AND m.bot_id = t.bot_id
         ORDER BY m.event_seq DESC LIMIT 1) AS replyToId
     FROM takeovers t JOIN runs r ON r.id = t.run_id JOIN scopes s ON s.id = r.scope_id
     WHERE t.id = ?`,
  );
  const parse = (row: unknown) => (row === undefined ? undefined : Takeover.parse(row));
  const now = () => new Date().toISOString();

  return {
    // Asking again while one is open gets that one back.
    requestTakeover: (botId: string, runId: string, reason: string) =>
      transaction(() => {
        const at = now();
        return (
          parse(selectOpen.get(botId)) ??
          Takeover.parse(insert.get(NodeCrypto.randomUUID(), botId, runId, reason, at, at))
        );
      }),
    moveTakeover: (botId: string, from: TakeoverState, to: TakeoverState) =>
      transaction(() => parse(moveBot.get(to, now(), botId, from))),
    expireTakeover: (id: string) =>
      transaction(() => parse(moveOne.get("expired", now(), id, "waiting"))),
    // `release` runs in the same transaction for each bot, so a crash can't split the two.
    interruptTakeovers: (release: (botId: string) => void) =>
      transaction(() => {
        const interrupted = z.array(Takeover).parse(interruptAll.all(now()));
        for (const { botId } of interrupted) {
          release(botId);
        }
        return interrupted;
      }),
    takeoverTarget: (id: string) => Target.optional().parse(selectTarget.get(id)),
  };
}
