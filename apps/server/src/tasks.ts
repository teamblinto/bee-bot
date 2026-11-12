import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { type Run, Task, WakeSource } from "@beebot/contracts";
import { z } from "zod";

import type { StoreTx } from "./store.ts";

const Count = z.object({ count: z.number() });
const ScopeRow = z.object({ scopeId: z.string(), roomId: z.string() });
const BotRef = z.object({ id: z.string(), name: z.string() });
const GrantRow = z.object({
  botId: z.string(),
  roomId: z.string(),
  chainId: z.string().nullable(),
  hop: z.number(),
  depth: z.number(),
  taskId: z.string().nullable(),
  source: WakeSource,
  attended: z.number().transform(Boolean),
});
const ChainRow = z.object({ turns: z.number(), startedAt: z.string() });

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
> & { deliveryKey: string; attended: boolean };

// How a bot-written message was sent. Its id starts with this, and the provenance label reads it back.
export type Via = "delegate" | "handoff" | "result" | "message" | "notify" | "question";
const vias = new Set<string>(["delegate", "handoff", "result", "message", "notify", "question"]);

export type ChainPoint = { chainId: string | null; hop: number; depth: number };

// Store writes that can run inside a transaction the caller already holds.
export type TaskDelivery = {
  post: (message: { id: string; roomId: string; botId: string; body: string } & ChainPoint) => void;
  wake: (scopeId: string, key: string, attended: boolean, chain: ChainPoint) => void;
};

export type Refused = { refused: "fan_out" | "target_busy" };

export function provenanceLabel(message: {
  id: string;
  botName: string;
  chainId: string | null;
  hop: number;
}) {
  const prefix = message.id.split(":")[0] ?? "";
  const via = vias.has(prefix) ? ` via ${prefix}` : "";
  const chain = message.chainId ? `, chain ${message.chainId.slice(0, 8)} hop ${message.hop}` : "";
  return `[from @${message.botName}${via}${chain}]`;
}

// Another bot's text is data. A line that looks like a label can't pass for one.
export const inboundText = (message: Parameters<typeof provenanceLabel>[0] & { body: string }) =>
  `${provenanceLabel(message)}\n${message.body.replace(/^\[from /gm, "\\[from ")}`;

export function openTasks(db: DatabaseSync, { transaction, emit }: StoreTx, deliver: TaskDelivery) {
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
  const selectOwning = db.prepare("SELECT 1 FROM tasks WHERE owner_bot_id = ? AND status = 'open'");
  const selectWaiting = db.prepare(
    "SELECT 1 FROM tasks WHERE requester_bot_id = ? AND status = 'open'",
  );
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
    `UPDATE tasks SET owner_bot_id = ?, hop = ?, updated_at = ?
     WHERE id = ? AND status = 'open' AND owner_bot_id = ? AND owner_bot_id <> ?
     RETURNING ${taskColumns}`,
  );
  const selectDmScope = db.prepare(
    `SELECT s.id AS scopeId, s.room_id AS roomId FROM scopes s
     JOIN rooms r ON r.id = s.room_id AND r.kind = 'dm' AND r.default_bot_id = s.bot_id
     WHERE s.bot_id = ?`,
  );
  const selectRoomScope = db.prepare(
    `SELECT id AS scopeId, room_id AS roomId FROM scopes
     WHERE room_id = ? AND bot_id = ? AND left_at IS NULL`,
  );
  const selectRunAttended = db.prepare(
    "SELECT w.attended FROM runs r JOIN wakes w ON w.id = r.wake_id WHERE r.id = ?",
  );
  const selectGrant = db.prepare(
    `SELECT r.bot_id AS botId, s.room_id AS roomId, r.chain_id AS chainId, r.hop, r.depth,
       r.task_id AS taskId, w.source, w.attended
     FROM runs r JOIN scopes s ON s.id = r.scope_id JOIN wakes w ON w.id = r.wake_id
     WHERE r.id = ? AND r.status = 'Running'`,
  );
  const selectChain = db.prepare(
    `SELECT COUNT(*) AS turns, MIN(created_at) AS startedAt FROM runs
     WHERE chain_id = ? OR id = ?`,
  );
  // Each step goes from a task to the run that asked for it, and from that run to its own task.
  const selectAncestors = db.prepare(
    `WITH RECURSIVE up (task_id) AS (
       SELECT ?
       UNION SELECT r.task_id FROM up
         JOIN tasks t ON t.id = up.task_id JOIN runs r ON r.id = t.parent_run_id
         WHERE r.task_id IS NOT NULL
     )
     SELECT DISTINCT b.id, b.name FROM up
       JOIN tasks t ON t.id = up.task_id JOIN bots b ON b.id = t.requester_bot_id`,
  );
  const selectRoommates = db.prepare(
    `SELECT DISTINCT b.id, b.name FROM scopes mine
       JOIN scopes other ON other.room_id = mine.room_id AND other.bot_id <> mine.bot_id
         AND other.left_at IS NULL
       JOIN bots b ON b.id = other.bot_id AND b.archived_at IS NULL
     WHERE mine.bot_id = ? AND mine.left_at IS NULL ORDER BY b.rowid`,
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

  const messageId = (via: Via) => `${via}:${NodeCrypto.randomUUID()}`;

  // A delegate goes to the owner's DM, so the child starts from the task alone. A handoff stays in
  // its room, where the new owner answers. Throws if the owner has no such scope.
  function deliverTask(
    task: Task,
    via: Task["kind"],
    from: string,
    body: string,
    attended: boolean,
  ) {
    const row =
      task.kind === "delegate"
        ? selectDmScope.get(task.ownerBotId)
        : selectRoomScope.get(task.roomId, task.ownerBotId);
    const { scopeId, roomId } = ScopeRow.parse(row);
    const id = messageId(via);
    const { chainId, hop, depth } = task;
    deliver.post({ id, roomId, botId: from, body, chainId, hop, depth });
    deliver.wake(scopeId, `task:${id}`, attended, { chainId, hop, depth });
  }

  return {
    getTask,
    openTasks: () => z.array(Task).parse(selectOpen.all()),

    // The count, the busy check and the insert share one write lock, so parallel calls can't pass
    // the cap together. A repeated delivery key returns its task and spends nothing. A bot owns at
    // most one open task, which is how a run knows the task it works on.
    createTask: (input: TaskInput, maxFanOut: number) =>
      transaction((): Task | Refused => {
        const existing = selectByKey.get(input.deliveryKey);
        if (existing) {
          return Task.parse(existing);
        }
        if (Count.parse(countForRun.get(input.parentRunId)).count >= maxFanOut) {
          return { refused: "fan_out" };
        }
        if (selectOwning.get(input.ownerBotId)) {
          return { refused: "target_busy" };
        }
        const now = new Date().toISOString();
        const { kind, chainId, hop, depth, parentRunId, requesterBotId, ownerBotId } = input;
        const task = changed(
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
        deliverTask(task, kind, requesterBotId, task.goal, input.attended);
        return task;
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

    // Only the current owner can hand off, so two racing handoffs can't both win.
    handoff: (
      id: string,
      move: { fromBotId: string; toBotId: string; hop: number; note: string; attended: boolean },
    ) =>
      transaction((): Task | Refused | undefined => {
        const { fromBotId, toBotId } = move;
        if (selectOwning.get(toBotId)) {
          return { refused: "target_busy" };
        }
        const row = moveOwner.get(
          toBotId,
          move.hop,
          new Date().toISOString(),
          id,
          fromBotId,
          toBotId,
        );
        if (!row) {
          return undefined;
        }
        const task = changed(row);
        deliverTask(task, "handoff", fromBotId, `${task.goal}\n\n${move.note}`, move.attended);
        return task;
      }),

    // The run's own facts, never the model's: who is asking, from where, and how deep in the chain.
    runGrant: (runId: string) => {
      const row = selectGrant.get(runId);
      if (!row) {
        return undefined;
      }
      const run = GrantRow.parse(row);
      const chainId = run.chainId ?? runId;
      const chain = { ...run, ...ChainRow.parse(selectChain.get(chainId, chainId)), chainId };
      const ancestors = run.taskId ? z.array(BotRef).parse(selectAncestors.all(run.taskId)) : [];
      return {
        ...chain,
        runId,
        tasksInRun: Count.parse(countForRun.get(runId)).count,
        ancestors,
        roommates: z.array(BotRef).parse(selectRoommates.all(run.botId)),
        owns: (taskId: string) => getTask(taskId)?.ownerBotId === run.botId,
        inRoom: (roomId: string, botId: string) => selectRoomScope.get(roomId, botId) !== undefined,
      };
    },

    postFrom: (
      from: { botId: string } & ChainPoint,
      roomId: string,
      via: Exclude<Via, "delegate" | "handoff" | "result">,
      body: string,
    ) =>
      transaction(() => {
        if (!selectRoomScope.get(roomId, from.botId)) {
          return undefined;
        }
        const id = messageId(via);
        deliver.post({ ...from, id, roomId, body });
        return id;
      }),

    dmRoom: (botId: string) => ScopeRow.safeParse(selectDmScope.get(botId)).data?.roomId,

    // Inside the store's transaction that ends the run. A delegate's outcome goes back once, with
    // no acknowledgment turn. A run with its own delegations still open leaves its task to the run
    // their results wake.
    settleRun: (
      run: Pick<Run, "id" | "botId" | "taskId">,
      status: "done" | "failed" | "cancelled" | "refused",
      text: string,
    ) => {
      const task = run.taskId ? getTask(run.taskId) : undefined;
      if (task?.status !== "open" || task.ownerBotId !== run.botId) {
        return;
      }
      if (status === "done" && selectWaiting.get(run.botId)) {
        return;
      }
      let resultId: string | null = null;
      if (task.kind === "delegate") {
        resultId = messageId("result");
        const { chainId, hop, roomId } = task;
        const body = status === "done" ? text : `The task ended without a result (${status}).`;
        deliver.post({ id: resultId, roomId, botId: run.botId, body, chainId, hop, depth: 0 });
        const scope = ScopeRow.safeParse(selectRoomScope.get(roomId, task.requesterBotId)).data;
        if (scope) {
          const { attended } = z
            .object({ attended: z.number().transform(Boolean) })
            .parse(selectRunAttended.get(run.id));
          const back = { chainId, hop, depth: Math.max(task.depth - 1, 0) };
          deliver.wake(scope.scopeId, `result:${task.id}`, attended, back);
        }
      }
      changed(endTask.get(status, resultId, new Date().toISOString(), task.id));
    },
  };
}
