import * as NodeCrypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import * as NodeHttps from "node:https";
import type { DatabaseSync } from "node:sqlite";

import { isDeniedAddress } from "@beebot/egress/policy";
import { z } from "zod";

import { type Lookup, systemLookup } from "./connectors.ts";
import type { EventStore, StoreTx } from "./store.ts";

export const WaitCondition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task_done"), task_id: z.string() }),
  z.object({ kind: z.literal("bot_idle"), bot_id: z.string() }),
  z.object({ kind: z.literal("url_status"), url: z.string(), status: z.number().int() }),
  z.object({ kind: z.literal("url_changes"), url: z.string(), baseline: z.string().optional() }),
  z.object({ kind: z.literal("file_exists"), path: z.string() }),
]);
export type WaitCondition = z.infer<typeof WaitCondition>;

const Wait = z.object({
  id: z.string(),
  botId: z.string(),
  taskId: z.string().nullable(),
  condition: z.string().transform((text) => WaitCondition.parse(JSON.parse(text))),
  note: z.string(),
  status: z.enum(["pending", "met", "expired", "cancelled"]),
  nextCheckAt: z.string(),
  expiresAt: z.string(),
  createdByRunId: z.string().nullable(),
  createdAt: z.string(),
});
export type Wait = z.infer<typeof Wait>;
const Count = z.object({ count: z.number() });

// `null` means "couldn't check now".
export type WaitProbes = {
  url: (botId: string, url: string) => Promise<{ status: number; sha256: string } | null>;
  file: (botId: string, path: string) => Promise<"present" | "absent" | "outside" | null>;
};

type Outcome = "met" | "expired" | "gone";

const minutesBetween = (from: string, to: number) =>
  Math.max(Math.round((to - Date.parse(from)) / 60_000), 0);

export function openWaits(
  db: DatabaseSync,
  { transaction }: StoreTx,
  deliver: {
    notice: (botId: string, id: string, body: string, taskId: string | null) => "sent" | "gone";
  },
) {
  const columns = `id, bot_id AS botId, task_id AS taskId, condition_json AS condition, note, status,
    next_check_at AS nextCheckAt, expires_at AS expiresAt, created_by_run_id AS createdByRunId,
    created_at AS createdAt`;
  const countPending = db.prepare(
    "SELECT COUNT(*) AS count FROM waits WHERE bot_id = ? AND status = 'pending'",
  );
  const insertWait = db.prepare(
    `INSERT INTO waits (id, bot_id, task_id, condition_json, note, status, next_check_at,
       expires_at, created_by_run_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) RETURNING ${columns}`,
  );
  const selectDue = db.prepare(
    `SELECT ${columns} FROM waits WHERE status = 'pending' AND next_check_at <= ? ORDER BY rowid`,
  );
  const selectPending = db.prepare(
    `SELECT ${columns} FROM waits WHERE id = ? AND status = 'pending'`,
  );
  const setNextCheck = db.prepare("UPDATE waits SET next_check_at = ? WHERE id = ?");
  const setCondition = db.prepare("UPDATE waits SET condition_json = ? WHERE id = ?");
  const setStatus = db.prepare("UPDATE waits SET status = ? WHERE id = ? AND status = 'pending'");
  const cancelForBot = db.prepare(
    "UPDATE waits SET status = 'cancelled' WHERE status = 'pending' AND (? IS NULL OR bot_id = ?)",
  );
  const selectForTask = db.prepare(
    "SELECT 1 FROM waits WHERE task_id = ? AND status = 'pending' LIMIT 1",
  );

  function body(wait: Wait, outcome: Outcome, summary: string) {
    if (outcome === "met") {
      return `[Wait met after ${minutesBetween(wait.createdAt, Date.now())} minutes: ${summary}]\n\n${wait.note}`;
    }
    if (outcome === "expired") {
      const timeout = minutesBetween(wait.createdAt, Date.parse(wait.expiresAt));
      return `[Wait timed out after ${timeout} minutes: ${summary} didn't happen]\n\n${wait.note}`;
    }
    return `[Wait ended: ${summary} no longer exists]\n\n${wait.note}`;
  }

  return {
    // The count and the insert share one transaction, so parallel calls can't pass the cap.
    createWait: (
      input: {
        botId: string;
        taskId: string | null;
        condition: WaitCondition;
        note: string;
        timeoutMinutes: number;
        createdByRunId: string;
      },
      max: number,
    ) =>
      transaction(() => {
        if (Count.parse(countPending.get(input.botId)).count >= max) {
          return { refused: "too_many_waits" } as const;
        }
        const now = new Date();
        const expiresAt = new Date(now.getTime() + input.timeoutMinutes * 60_000).toISOString();
        return Wait.parse(
          insertWait.get(
            NodeCrypto.randomUUID(),
            input.botId,
            input.taskId,
            JSON.stringify(input.condition),
            input.note,
            now.toISOString(),
            expiresAt,
            input.createdByRunId,
            now.toISOString(),
          ),
        );
      }),
    dueWaits: (now: string) => z.array(Wait).parse(selectDue.all(now)),
    deferCheck: (id: string, at: string) => {
      setNextCheck.run(at, id);
    },
    setBaseline: (id: string, sha256: string) =>
      transaction(() => {
        const row = selectPending.get(id);
        if (row) {
          const { condition } = Wait.parse(row);
          setCondition.run(JSON.stringify({ ...condition, baseline: sha256 }), id);
        }
      }),
    settleWait: (id: string, outcome: Outcome, summary: string) =>
      transaction(() => {
        const row = selectPending.get(id);
        if (!row) {
          return false;
        }
        const wait = Wait.parse(row);
        const sent = deliver.notice(wait.botId, wait.id, body(wait, outcome, summary), wait.taskId);
        const status = sent === "gone" ? "cancelled" : outcome === "met" ? "met" : "expired";
        return setStatus.run(status, id).changes > 0;
      }),
    // Not wrapped, so a store write that already holds the transaction can call it.
    cancelWaits: (botId: string | null) => {
      cancelForBot.run(botId, botId);
    },
    pendingForTask: (taskId: string) => selectForTask.get(taskId) !== undefined,
  };
}

const maxProbeBytes = 2 * 1024 * 1024;

// Connects to the address it checked, so a name that answers differently the second time (DNS
// rebinding) can't reach a private one. Nothing is followed: a redirect is just its status.
export async function probeUrl(url: string, lookup: Lookup = systemLookup) {
  try {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.port !== "") {
      return null;
    }
    const addresses = await lookup(target.hostname);
    const [address] = addresses;
    if (!address || addresses.some(isDeniedAddress)) {
      return null;
    }
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      NodeHttps.get(
        {
          host: address,
          servername: target.hostname,
          path: `${target.pathname}${target.search}`,
          headers: { host: target.hostname },
          signal: AbortSignal.timeout(20_000),
        },
        resolve,
      ).on("error", reject);
    });
    const hash = NodeCrypto.createHash("sha256");
    let read = 0;
    for await (const chunk of response) {
      const part = Buffer.from(chunk).subarray(0, maxProbeBytes - read);
      hash.update(part);
      read += part.length;
      if (read >= maxProbeBytes) {
        break;
      }
    }
    return { status: response.statusCode ?? 0, sha256: hash.digest("hex") };
  } catch {
    return null;
  }
}

export const terminalTask = new Set(["done", "refused", "failed", "cancelled"]);
const probeGapMs = 30_000;

export function createWaitEvaluator(store: EventStore, probes: WaitProbes, onSettled: () => void) {
  const inFlight = new Map<string, Promise<void>>();

  function settle(wait: Wait, outcome: Outcome, summary: string) {
    if (store.waits.settleWait(wait.id, outcome, summary)) {
      onSettled();
    }
  }

  async function probe(wait: Wait) {
    const { condition } = wait;
    if (condition.kind === "file_exists") {
      const found = await probes.file(wait.botId, condition.path);
      if (found === "present") {
        settle(wait, "met", `${condition.path} exists`);
      } else if (found === "outside") {
        settle(wait, "gone", `${condition.path} is outside your workspace`);
      }
      return;
    }
    if (condition.kind !== "url_status" && condition.kind !== "url_changes") {
      return;
    }
    const answer = await probes.url(wait.botId, condition.url);
    if (!answer) {
      return;
    }
    if (condition.kind === "url_status") {
      if (answer.status === condition.status) {
        settle(wait, "met", `${condition.url} answered ${condition.status}`);
      }
    } else if (condition.baseline === undefined) {
      store.waits.setBaseline(wait.id, answer.sha256);
    } else if (answer.sha256 !== condition.baseline) {
      settle(wait, "met", `${condition.url} changed`);
    }
  }

  function expected({ condition }: Wait) {
    switch (condition.kind) {
      case "task_done":
        return `task ${condition.task_id} finished`;
      case "bot_idle":
        return `@${store.getBot(condition.bot_id)?.name ?? condition.bot_id} is idle`;
      case "url_status":
        return `${condition.url} answered ${condition.status}`;
      case "url_changes":
        return `${condition.url} changed`;
      case "file_exists":
        return `${condition.path} exists`;
    }
  }

  function check(wait: Wait, now: string) {
    const { condition } = wait;
    if (wait.expiresAt <= now) {
      settle(wait, "expired", expected(wait));
      return;
    }
    if (condition.kind === "task_done") {
      const task = store.tasks.getTask(condition.task_id);
      if (!task) {
        settle(wait, "gone", `task ${condition.task_id}`);
      } else if (terminalTask.has(task.status)) {
        settle(wait, "met", `task ${task.id} finished (${task.status})`);
      }
      return;
    }
    if (condition.kind === "bot_idle") {
      const bot = store.getBot(condition.bot_id);
      if (!bot || bot.archivedAt) {
        settle(wait, "gone", `@${bot?.name ?? condition.bot_id}`);
      } else if (store.botIdle(bot.id)) {
        settle(wait, "met", `@${bot.name} is idle`);
      }
      return;
    }
    if (inFlight.has(wait.id)) {
      return;
    }
    store.waits.deferCheck(wait.id, new Date(Date.parse(now) + probeGapMs).toISOString());
    const running = probe(wait)
      .catch((error: unknown) => console.error(`beebotd: wait ${wait.id} probe failed`, error))
      .finally(() => inFlight.delete(wait.id));
    inFlight.set(wait.id, running);
  }

  return {
    // Synchronous: the probes settle on their own after it returns.
    tick(now: string) {
      for (const wait of store.waits.dueWaits(now)) {
        try {
          check(wait, now);
        } catch (error) {
          console.error(`beebotd: wait ${wait.id} failed`, error);
        }
      }
    },
    idle: async () => {
      await Promise.all(inFlight.values());
    },
  };
}
