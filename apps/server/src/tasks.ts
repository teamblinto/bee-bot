import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { Task } from "@beebot/contracts";
import { z } from "zod";

import type { StoreTx } from "./store.ts";

const Count = z.object({ count: z.number() });

export type TaskInput = Pick<
  Task,
  | "kind"
  | "chainId"
  | "hop"
  | "depth"
  | "parentRunId"
  | "requesterBotId"
  | "ownerBotId"
  | "roomId"
  | "goal"
> & { deliveryKey: string };

export function openTasks(db: DatabaseSync, { transaction, emit }: StoreTx) {
  const taskColumns = `id, kind, chain_id AS chainId, hop, depth, parent_run_id AS parentRunId,
    requester_bot_id AS requesterBotId, owner_bot_id AS ownerBotId, room_id AS roomId, goal,
    status, result_message_id AS resultMessageId, created_at AS createdAt,
    updated_at AS updatedAt`;
  const selectTask = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE id = ?`);
  const selectByKey = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE delivery_key = ?`);
  const selectOpen = db.prepare(
    `SELECT ${taskColumns} FROM tasks WHERE status = 'open' ORDER BY rowid`,
  );
  const countForRun = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_run_id = ?");
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, kind, chain_id, hop, depth, parent_run_id, requester_bot_id,
       owner_bot_id, room_id, goal, status, delivery_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?) RETURNING ${taskColumns}`,
  );
  const endTask = db.prepare(
    `UPDATE tasks SET status = ?, result_message_id = ?, updated_at = ?
     WHERE id = ? AND status = 'open' RETURNING ${taskColumns}`,
  );
  const moveOwner = db.prepare(
    `UPDATE tasks SET owner_bot_id = ?, updated_at = ?
     WHERE id = ? AND status = 'open' AND owner_bot_id <> ? RETURNING ${taskColumns}`,
  );

  const getTask = (id: string) => {
    const row = selectTask.get(id);
    return row ? Task.parse(row) : undefined;
  };

  const changed = (row: unknown) => {
    const task = Task.parse(row);
    emit({ type: "task.changed", task });
    return task;
  };

  return {
    getTask,
    openTasks: () => z.array(Task).parse(selectOpen.all()),

    // The count and the insert share one write lock, so parallel calls can't pass the cap together.
    // A repeated delivery key returns its task and spends nothing.
    createTask: (input: TaskInput, maxFanOut: number) =>
      transaction((): Task | { refused: "fan_out" } => {
        const existing = selectByKey.get(input.deliveryKey);
        if (existing) {
          return Task.parse(existing);
        }
        if (Count.parse(countForRun.get(input.parentRunId)).count >= maxFanOut) {
          return { refused: "fan_out" };
        }
        const now = new Date().toISOString();
        const { kind, chainId, hop, depth, parentRunId, requesterBotId, ownerBotId } = input;
        return changed(
          insertTask.get(
            NodeCrypto.randomUUID(),
            kind,
            chainId,
            hop,
            depth,
            parentRunId,
            requesterBotId,
            ownerBotId,
            input.roomId,
            input.goal,
            input.deliveryKey,
            now,
            now,
          ),
        );
      }),

    finishTask: (
      id: string,
      status: Exclude<Task["status"], "open">,
      resultMessageId: string | null = null,
    ) =>
      transaction(() => {
        const row = endTask.get(status, resultMessageId, new Date().toISOString(), id);
        return row ? changed(row) : undefined;
      }),

    handoff: (id: string, toBotId: string) =>
      transaction(() => {
        const row = moveOwner.get(toBotId, new Date().toISOString(), id, toBotId);
        return row ? changed(row) : undefined;
      }),
  };
}
