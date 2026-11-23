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
const Attended = z.object({ attended: z.number().transform(Boolean) });
const NextRow = Task.extend({ pendingJson: z.string() });

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
const viaNames = [
  "delegate",
  "handoff",
  "result",
  "message",
  "notify",
  "question",
  "follow_up",
] as const;
export type Via = (typeof viaNames)[number];
const vias = new Set<string>(viaNames);
// What a queued task posts when it opens.
const Pending = z.object({ from: z.string(), via: z.enum(viaNames), body: z.string() });

export type ChainPoint = { chainId: string | null; hop: number; depth: number };

// Store writes that can run inside a transaction the caller already holds.
export type TaskDelivery = {
  post: (message: { id: string; roomId: string; botId: string; body: string } & ChainPoint) => void;
  wake: (scopeId: string, key: string, attended: boolean, chain: ChainPoint) => void;
};

export type Refused = { refused: "fan_out" };
export type FollowUpKind = "ask" | "answer" | "rework" | "cancel";
type FollowUpRefused = { refused: "not_found" | "not_party" | "wrong_state" | "not_reachable" };
type EndStatus = "done" | "failed" | "cancelled" | "refused";

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
  const active = "('queued', 'open', 'waiting', 'needs_input')";
  const selectTask = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE id = ?`);
  const selectByKey = db.prepare(`SELECT ${taskColumns} FROM tasks WHERE delivery_key = ?`);
  const selectActive = db.prepare(
    `SELECT ${taskColumns} FROM tasks WHERE status IN ${active} ORDER BY rowid`,
  );
  const countForRun = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE parent_run_id = ?");
  // A parked or boot-held run answers its scope's unacked input when it resumes. A task opened
  // into that scope would ride the same turn and carry the owner's input out as its result.
  const selectBusy = db.prepare(
    `SELECT 1 FROM tasks WHERE owner_bot_id = ? AND status = 'open'
     UNION ALL SELECT 1 FROM runs WHERE bot_id = ? AND status IN ('Queued', 'Running')
     UNION ALL SELECT 1 FROM runs r JOIN scopes s ON s.id = r.scope_id
       WHERE r.bot_id = ? AND r.status IN ('WaitingUser', 'WaitingQuota', 'Interrupted')
         AND r.rowid = (SELECT MAX(rowid) FROM runs WHERE scope_id = r.scope_id)
         AND EXISTS (SELECT 1 FROM messages m WHERE m.room_id = s.room_id
           AND m.event_seq > s.acked_event_seq AND (m.author = 'human' OR m.bot_id <> s.bot_id))`,
  );
  const selectWaiting = db.prepare(
    `SELECT 1 FROM tasks WHERE requester_bot_id = ? AND status IN ${active}`,
  );
  // A chain is human-origin when its first wake came from the owner.
  const selectNext = db.prepare(
    `SELECT ${taskColumns}, pending_json AS pendingJson FROM tasks t
     WHERE owner_bot_id = ? AND status = 'queued'
     ORDER BY (SELECT w.source FROM wakes w WHERE w.chain_id = t.chain_id
         ORDER BY w.rowid LIMIT 1) = 'human' DESC,
       created_at, rowid
     LIMIT 1`,
  );
  const selectQueued = db.prepare(
    `SELECT ${taskColumns} FROM tasks WHERE owner_bot_id = ? AND status = 'queued' ORDER BY rowid`,
  );
  const selectUnstarted = db.prepare(
    `SELECT ${taskColumns} FROM tasks WHERE owner_bot_id = ? AND status = 'open'
       AND id NOT IN (SELECT task_id FROM runs WHERE task_id IS NOT NULL
         AND bot_id = tasks.owner_bot_id
         AND status IN ('Queued', 'Running', 'WaitingUser', 'WaitingQuota'))
     ORDER BY rowid`,
  );
  const openQueued = db.prepare(
    `UPDATE tasks SET status = 'open', pending_json = NULL, updated_at = ?
     WHERE id = ? RETURNING ${taskColumns}`,
  );
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, kind, chain_id, hop, depth, parent_run_id, requester_bot_id,
       owner_bot_id, room_id, goal, status, delivery_key, pending_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?) RETURNING ${taskColumns}`,
  );
  const endTask = db.prepare(
    `UPDATE tasks SET status = ?, result_message_id = ?, updated_at = ?
     WHERE id = ? AND status IN ${active} RETURNING ${taskColumns}`,
  );
  const moveOwner = db.prepare(
    `UPDATE tasks SET owner_bot_id = ?, hop = ?, status = 'queued', pending_json = ?,
       updated_at = ?
     WHERE id = ? AND status IN ('queued', 'open') AND owner_bot_id = ? AND owner_bot_id <> ?
     RETURNING ${taskColumns}`,
  );
  const selectMine = db.prepare(
    `SELECT ${taskColumns} FROM tasks
     WHERE (requester_bot_id = ? OR owner_bot_id = ?) AND status IN ${active} ORDER BY rowid`,
  );
  const setStatus = db.prepare(
    `UPDATE tasks SET status = ?, pending_json = ?, updated_at = ? WHERE id = ?
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
  // Bots the owner picked from the @ menu anywhere in this chain.
  const selectMentioned = db.prepare(
    `SELECT DISTINCT b.id, b.name FROM messages m JOIN json_each(m.mentions) j
       JOIN bots b ON b.id = j.value AND b.archived_at IS NULL
     WHERE m.chain_id = ? AND m.author = 'human'`,
  );
  const selectInChain = db.prepare("SELECT DISTINCT bot_id AS id FROM runs WHERE chain_id = ?");

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
  // its room, where the new owner answers.
  const ownerScope = (task: Pick<Task, "kind" | "ownerBotId" | "roomId">) =>
    ScopeRow.safeParse(
      task.kind === "delegate"
        ? selectDmScope.get(task.ownerBotId)
        : selectRoomScope.get(task.roomId, task.ownerBotId),
    ).data;

  const parentAttended = (task: Task) =>
    Attended.parse(selectRunAttended.get(task.parentRunId)).attended;

  const noResult = (status: EndStatus) => `The task ended without a result (${status}).`;

  // The owner posts the outcome where the task was asked, and the requester wakes to read it.
  function endWithResult(task: Task, status: EndStatus, body: string, attended: boolean) {
    const resultId = messageId("result");
    const { chainId, hop, roomId } = task;
    deliver.post({ id: resultId, roomId, botId: task.ownerBotId, body, chainId, hop, depth: 0 });
    const scope = ScopeRow.safeParse(selectRoomScope.get(roomId, task.requesterBotId)).data;
    if (scope) {
      const back = { chainId, hop, depth: Math.max(task.depth - 1, 0) };
      deliver.wake(scope.scopeId, `result:${task.id}`, attended, back);
    }
    changed(endTask.get(status, resultId, new Date().toISOString(), task.id));
  }

  // Inside the caller's transaction. A task never opens on a busy bot, so its message is never
  // steered into an unrelated live run, and an owner keeps at most one open task. One whose owner
  // has no scope to receive it any more fails, and the next is tried.
  function promoteNextTask(botId: string): Task | undefined {
    if (selectBusy.get(botId, botId, botId)) {
      return undefined;
    }
    const row = selectNext.get(botId);
    if (!row) {
      return undefined;
    }
    const { pendingJson, ...queued } = NextRow.parse(row);
    const attended = parentAttended(queued);
    const scope = ownerScope(queued);
    if (!scope) {
      endWithResult(queued, "failed", noResult("failed"), attended);
      return promoteNextTask(botId);
    }
    const { from, via, body } = Pending.parse(JSON.parse(pendingJson));
    const task = changed(openQueued.get(new Date().toISOString(), queued.id));
    const id = messageId(via);
    const { chainId, hop, depth } = task;
    deliver.post({ id, roomId: scope.roomId, botId: from, body, chainId, hop, depth });
    deliver.wake(scope.scopeId, `task:${id}`, attended, { chainId, hop, depth });
    return task;
  }

  // A delegate's outcome goes back once, with no acknowledgment turn. A run with its own
  // delegations still active leaves its task to the run their results wake.
  function endRunTask(run: Pick<Run, "id" | "botId" | "taskId">, status: EndStatus, text: string) {
    const task = run.taskId ? getTask(run.taskId) : undefined;
    if (task?.status !== "open" || task.ownerBotId !== run.botId) {
      return;
    }
    if (status === "done" && selectWaiting.get(run.botId)) {
      return;
    }
    if (task.kind !== "delegate") {
      changed(endTask.get(status, null, new Date().toISOString(), task.id));
      return;
    }
    const { attended } = Attended.parse(selectRunAttended.get(run.id));
    endWithResult(task, status, status === "done" ? text : noResult(status), attended);
  }

  return {
    getTask,
    activeTasks: () => z.array(Task).parse(selectActive.all()),
    promoteNextTask,

    // The count and the insert share one write lock, so parallel calls can't pass the cap
    // together. A repeated delivery key returns its task and spends nothing. A busy owner gets the
    // task queued.
    createTask: (input: TaskInput, maxFanOut: number) =>
      transaction((): Task | Refused => {
        const existing = selectByKey.get(input.deliveryKey);
        if (existing) {
          return Task.parse(existing);
        }
        if (Count.parse(countForRun.get(input.parentRunId)).count >= maxFanOut) {
          return { refused: "fan_out" };
        }
        const now = new Date().toISOString();
        const { kind, chainId, hop, depth, parentRunId, requesterBotId, ownerBotId } = input;
        if (!ownerScope(input)) {
          throw new Error(`${ownerBotId} has nowhere to receive the task`);
        }
        const pending = { from: requesterBotId, via: kind, body: input.goal };
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
            JSON.stringify(pending),
            now,
            now,
          ),
        );
        promoteNextTask(ownerBotId);
        return getTask(task.id) ?? task;
      }),

    finishTask: (
      id: string,
      status: Exclude<Task["status"], "open" | "queued">,
      resultMessageId: string | null = null,
    ) =>
      transaction(() => {
        const row = endTask.get(status, resultMessageId, new Date().toISOString(), id);
        return row ? changed(row) : undefined;
      }),

    // Only the current owner can hand off, so two racing handoffs can't both win. The task waits
    // in the new owner's queue like any other.
    handoff: (
      id: string,
      move: { fromBotId: string; toBotId: string; hop: number; note: string },
    ) =>
      transaction((): Task | undefined => {
        const { fromBotId, toBotId } = move;
        const goal = getTask(id)?.goal ?? "";
        const pending = { from: fromBotId, via: "handoff", body: `${goal}\n\n${move.note}` };
        const row = moveOwner.get(
          toBotId,
          move.hop,
          JSON.stringify(pending),
          new Date().toISOString(),
          id,
          fromBotId,
          toBotId,
        );
        if (!row) {
          return undefined;
        }
        if (!ownerScope(Task.parse(row))) {
          throw new Error(`${toBotId} has nowhere to receive the task`);
        }
        const task = changed(row);
        promoteNextTask(toBotId);
        return getTask(task.id) ?? task;
      }),

    // Who may follow up, and when: the owner asks while the task is open; the requester asks,
    // answers a question, sends finished work back, or cancels.
    followUp: (input: {
      taskId: string;
      botId: string;
      kind: FollowUpKind;
      message: string;
      attended: boolean;
    }) =>
      transaction((): Task | FollowUpRefused => {
        const task = getTask(input.taskId);
        if (!task) {
          return { refused: "not_found" };
        }
        const { kind, botId, message, attended } = input;
        const asOwner = kind === "ask" && botId === task.ownerBotId;
        if (!asOwner && botId !== task.requesterBotId) {
          return { refused: "not_party" };
        }
        const allowed = {
          ask: ["open"],
          answer: ["needs_input"],
          rework: ["done"],
          cancel: ["queued", "open", "needs_input"],
        }[kind];
        if (!allowed.includes(task.status)) {
          return { refused: "wrong_state" };
        }
        const { chainId, hop, depth } = task;
        const now = new Date().toISOString();
        if (kind === "ask") {
          const id = messageId("follow_up");
          if (asOwner) {
            const scope = ScopeRow.safeParse(
              selectRoomScope.get(task.roomId, task.requesterBotId),
            ).data;
            if (!scope) {
              return { refused: "not_reachable" };
            }
            const back = { chainId, hop, depth: Math.max(depth - 1, 0) };
            deliver.post({ id, roomId: task.roomId, botId, body: message, ...back });
            deliver.wake(scope.scopeId, `follow_up:${id}`, attended, back);
            return changed(setStatus.get("needs_input", null, now, task.id));
          }
          const scope = ownerScope(task);
          if (!scope) {
            return { refused: "not_reachable" };
          }
          deliver.post({ id, roomId: scope.roomId, botId, body: message, chainId, hop, depth });
          deliver.wake(scope.scopeId, `task:${id}`, attended, { chainId, hop, depth });
          return task;
        }
        const pending =
          kind === "cancel"
            ? null
            : JSON.stringify({ from: botId, via: "follow_up", body: message });
        changed(setStatus.get(kind === "cancel" ? "cancelled" : "queued", pending, now, task.id));
        promoteNextTask(task.ownerBotId);
        return getTask(task.id) ?? task;
      }),

    tasksOf: (botId: string, taskId?: string) =>
      taskId === undefined
        ? z.array(Task).parse(selectMine.all(botId, botId))
        : [getTask(taskId)].filter(
            (task): task is Task =>
              task !== undefined && (task.requesterBotId === botId || task.ownerBotId === botId),
          ),

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
        mentioned: z.array(BotRef).parse(selectMentioned.all(chainId)),
        inChain: z
          .array(z.object({ id: z.string() }))
          .parse(selectInChain.all(chainId))
          .map(({ id }) => id),
        owns: (taskId: string) => getTask(taskId)?.ownerBotId === run.botId,
        inRoom: (roomId: string, botId: string) => selectRoomScope.get(roomId, botId) !== undefined,
      };
    },

    postFrom: (
      from: { botId: string } & ChainPoint,
      roomId: string,
      via: Exclude<Via, "delegate" | "handoff" | "result" | "message" | "follow_up">,
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

    // Inside the store's transaction that stops the bot, before its runs settle, so none opens.
    refuseQueued: (botId: string) => {
      for (const task of z.array(Task).parse(selectQueued.all(botId))) {
        endWithResult(task, "refused", noResult("refused"), parentAttended(task));
      }
    },

    // A task opened by a wake the stop cancelled has no run to settle it.
    cancelUnstarted: (botId: string) => {
      for (const task of z.array(Task).parse(selectUnstarted.all(botId))) {
        endWithResult(task, "cancelled", noResult("cancelled"), parentAttended(task));
      }
    },

    // Inside the store's transaction that ends the run. Every end frees the bot for its next task.
    settleRun: (run: Pick<Run, "id" | "botId" | "taskId">, status: EndStatus, text: string) => {
      endRunTask(run, status, text);
      promoteNextTask(run.botId);
    },
  };
}
