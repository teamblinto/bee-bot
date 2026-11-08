import type { DatabaseSync } from "node:sqlite";

import { type BoxState, BoxStatus } from "@beebot/contracts";
import { z } from "zod";

import type { BoxRuntime } from "./boxRuntime.ts";
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

// Records every lifecycle step in `boxes`, so clients see a box come up, stop or fail.
export function recordingBoxRuntime(
  runtime: BoxRuntime,
  setBox: (botId: string, state: BoxState, reason?: string | null) => unknown,
): BoxRuntime {
  async function step(botId: string, during: BoxState | null, work: () => Promise<void>) {
    if (during !== null) {
      setBox(botId, during);
    }
    try {
      await work();
    } catch (error) {
      const state = await runtime.snapshot(botId).catch((): BoxState => "failed");
      setBox(
        botId,
        state === "absent" ? "failed" : state,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    setBox(botId, await runtime.snapshot(botId));
  }
  return {
    ...runtime,
    create: (botId) => step(botId, "creating", () => runtime.create(botId)),
    start: (botId) => step(botId, "starting", () => runtime.start(botId)),
    stop: (botId) => step(botId, null, () => runtime.stop(botId)),
  };
}
