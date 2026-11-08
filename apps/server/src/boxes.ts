import type { DatabaseSync } from "node:sqlite";

import { BoxStatus } from "@beebot/contracts";
import { z } from "zod";

import type { StoreTx } from "./store.ts";

// The last state the box runtime reported for each bot. A bot with no row has no box.
export function openBoxes(db: DatabaseSync, { transaction, emit }: StoreTx) {
  const columns = "bot_id AS botId, state, reason, updated_at AS updatedAt";
  const upsert = db.prepare(
    `INSERT INTO boxes (bot_id, state, reason, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (bot_id) DO UPDATE SET state = excluded.state, reason = excluded.reason,
       updated_at = excluded.updated_at
     RETURNING ${columns}`,
  );
  const selectAll = db.prepare(`SELECT ${columns} FROM boxes ORDER BY rowid`);

  return {
    setBox: (botId: string, state: BoxStatus["state"], reason: string | null = null) =>
      transaction(() => {
        const box = BoxStatus.parse(upsert.get(botId, state, reason, new Date().toISOString()));
        emit({ type: "box.changed", box });
        return box;
      }),
    listBoxes: () => z.array(BoxStatus).parse(selectAll.all()),
  };
}
