import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  Bot,
  ChatMessage,
  type ChatState,
  EngineAccount,
  type EventBody,
  Run,
  type RunReason,
  ServerEvent,
} from "@beebot/contracts";
import { z } from "zod";

const migrations = [
  {
    name: "create_events",
    sql: `CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  },
  {
    name: "bots_and_messages",
    // The old diagnostic rows don't parse under the new event contract.
    sql: `DELETE FROM events;
    ALTER TABLE events ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';
    CREATE TABLE bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      personality TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ready', 'paused')),
      pause_reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      default_bot_id TEXT NOT NULL REFERENCES bots (id),
      created_at TEXT NOT NULL
    );
    CREATE TABLE scopes (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms (id),
      bot_id TEXT NOT NULL REFERENCES bots (id),
      acked_event_seq INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      UNIQUE (room_id, bot_id)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms (id),
      author TEXT NOT NULL CHECK (author IN ('human', 'bot')),
      body TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX messages_by_room ON messages (room_id, event_seq);`,
  },
  {
    name: "run_supervisor",
    sql: `CREATE TABLE engine_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      blocked_until TEXT
    );
    INSERT INTO engine_accounts (id, label) VALUES ('fake', 'Test engine');
    ALTER TABLE bots ADD COLUMN engine_account_id TEXT NOT NULL DEFAULT 'fake'
      REFERENCES engine_accounts (id);
    CREATE TABLE wakes (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id),
      scope_id TEXT NOT NULL REFERENCES scopes (id),
      idempotency_key TEXT NOT NULL UNIQUE,
      attended INTEGER NOT NULL,
      not_before TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX wakes_pending ON wakes (scope_id) WHERE status = 'pending';
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id),
      scope_id TEXT NOT NULL REFERENCES scopes (id),
      wake_id TEXT NOT NULL REFERENCES wakes (id),
      engine_account_id TEXT NOT NULL REFERENCES engine_accounts (id),
      status TEXT NOT NULL CHECK (status IN
        ('Queued', 'Refused', 'Running', 'Completed', 'Failed', 'Cancelled', 'Interrupted')),
      reason TEXT,
      input_high_seq INTEGER,
      boot_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT
    );
    CREATE UNIQUE INDEX runs_one_active_per_bot ON runs (bot_id)
      WHERE status IN ('Queued', 'Running');
    CREATE UNIQUE INDEX runs_one_running_per_account ON runs (engine_account_id)
      WHERE status = 'Running';
    CREATE INDEX runs_by_bot ON runs (bot_id, created_at);
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );`,
  },
];

const Migration = z.object({ id: z.number(), name: z.string() });
const Bounds = z.object({ oldest: z.number().nullable(), latest: z.number().nullable() });
const EventRow = z.object({ seq: z.number(), payload: z.string(), createdAt: z.string() });
const Scope = z.object({
  id: z.string(),
  roomId: z.string(),
  botId: z.string(),
  ackedEventSeq: z.number(),
  sessionId: z.string().nullable(),
});
type Scope = z.infer<typeof Scope>;
const Input = z.object({ body: z.string(), seq: z.number() });
const Count = z.object({ count: z.number() });
const IdRow = z.object({ id: z.string() });
const QueuedRun = z.object({ id: z.string(), botId: z.string() });
const RunRow = Run.extend({
  scopeId: z.string(),
  wakeId: z.string(),
  engineAccountId: z.string(),
  inputHighSeq: z.number().nullable(),
});
type RunRow = z.infer<typeof RunRow>;
const WakeRow = z.object({
  id: z.string(),
  botId: z.string(),
  scopeId: z.string(),
  attended: z.number().transform(Boolean),
});
export type Wake = z.infer<typeof WakeRow>;

export type ClaimedRun = { id: string; prompt: string; sessionId: string };

export type FinishedRun = {
  status: "Completed" | "Failed" | "Cancelled";
  reason: RunReason | null;
  reply?: string;
  blockedUntil?: string;
  pauseBot?: boolean;
};

function migrate(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  // IMMEDIATE takes the write lock first, so a concurrent opener can't apply the same migration.
  db.exec("BEGIN IMMEDIATE");
  try {
    const applied = z
      .array(Migration)
      .parse(db.prepare("SELECT id, name FROM migrations ORDER BY id").all());
    applied.forEach((row, index) => {
      if (migrations[index]?.name !== row.name) {
        throw new Error(`Database migration ${row.id} (${row.name}) is unknown to this version`);
      }
    });
    const record = db.prepare("INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)");
    migrations.slice(applied.length).forEach((migration, index) => {
      db.exec(migration.sql);
      record.run(applied.length + index + 1, migration.name, new Date().toISOString());
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export type EventStore = ReturnType<typeof openEventStore>;

export function openEventStore(dataDir: string) {
  NodeFS.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"), { timeout: 5000 });
  try {
    db.exec("PRAGMA journal_mode = WAL");
    // After migrate: ALTER TABLE can't add a defaulted foreign key while this is on.
    migrate(db);
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.close();
    throw error;
  }

  const listeners = new Set<(event: ServerEvent) => void>();
  let uncommitted: ServerEvent[] = [];

  // Synchronous on purpose: no await can land inside a transaction. Listeners run after COMMIT,
  // so nobody hears of an event that could still roll back.
  function transaction<T>(work: () => T) {
    db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = work();
      db.exec("COMMIT");
    } catch (error) {
      uncommitted = [];
      db.exec("ROLLBACK");
      throw error;
    }
    const committed = uncommitted;
    uncommitted = [];
    for (const event of committed) {
      for (const listener of listeners) {
        listener(event);
      }
    }
    return result;
  }

  const eventColumns = "seq, payload, created_at AS createdAt";
  const insertEvent = db.prepare(
    `INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?) RETURNING ${eventColumns}`,
  );
  const selectAfter = db.prepare(`SELECT ${eventColumns} FROM events WHERE seq > ? ORDER BY seq`);
  const selectBounds = db.prepare("SELECT MIN(seq) AS oldest, MAX(seq) AS latest FROM events");
  const deleteOld = db.prepare("DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?");

  const parseEvent = (row: unknown) => {
    const { seq, payload, createdAt } = EventRow.parse(row);
    return ServerEvent.parse({ ...JSON.parse(payload), seq, createdAt });
  };

  function emit(body: EventBody) {
    const event = parseEvent(
      insertEvent.get(body.type, JSON.stringify(body), new Date().toISOString()),
    );
    uncommitted.push(event);
    return event.seq;
  }

  const botColumns = `b.id, b.name, b.personality, b.status, b.pause_reason AS pauseReason,
    r.id AS roomId, b.engine_account_id AS engineAccountId`;
  const selectBots = db.prepare(
    `SELECT ${botColumns} FROM bots b JOIN rooms r ON r.default_bot_id = b.id ORDER BY b.rowid`,
  );
  const selectBot = db.prepare(
    `SELECT ${botColumns} FROM bots b JOIN rooms r ON r.default_bot_id = b.id WHERE b.id = ?`,
  );
  const insertBot = db.prepare(
    "INSERT INTO bots (id, name, personality, status, created_at) VALUES (?, ?, ?, 'ready', ?)",
  );
  const insertRoom = db.prepare(
    "INSERT INTO rooms (id, default_bot_id, created_at) VALUES (?, ?, ?)",
  );
  const insertScope = db.prepare("INSERT INTO scopes (id, room_id, bot_id) VALUES (?, ?, ?)");
  const updateBotFields = db.prepare("UPDATE bots SET name = ?, personality = ? WHERE id = ?");
  const updateBotStatus = db.prepare("UPDATE bots SET status = ?, pause_reason = ? WHERE id = ?");

  const accountColumns = "id, label, blocked_until AS blockedUntil";
  const selectAccounts = db.prepare(`SELECT ${accountColumns} FROM engine_accounts ORDER BY id`);
  const selectAccount = db.prepare(`SELECT ${accountColumns} FROM engine_accounts WHERE id = ?`);
  const blockAccount = db.prepare("UPDATE engine_accounts SET blocked_until = ? WHERE id = ?");
  const unblockExpired = db.prepare(
    `UPDATE engine_accounts SET blocked_until = NULL WHERE blocked_until <= ?
     RETURNING ${accountColumns}`,
  );

  const messageColumns = "id, room_id AS roomId, author, body, created_at AS createdAt";
  const selectMessages = db.prepare(`SELECT ${messageColumns} FROM messages ORDER BY event_seq`);
  const selectMessage = db.prepare(`SELECT ${messageColumns} FROM messages WHERE id = ?`);
  const insertMessage = db.prepare(
    `INSERT INTO messages (id, room_id, author, body, event_seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectInput = db.prepare(
    `SELECT body, event_seq AS seq FROM messages
     WHERE room_id = ? AND author = 'human' AND event_seq > ? ORDER BY event_seq`,
  );

  const scopeColumns = `s.id, s.room_id AS roomId, s.bot_id AS botId,
    s.acked_event_seq AS ackedEventSeq, s.session_id AS sessionId`;
  const selectScope = db.prepare(`SELECT ${scopeColumns} FROM scopes s WHERE s.id = ?`);
  const selectScopeForRoom = db.prepare(
    `SELECT ${scopeColumns} FROM scopes s
     JOIN rooms r ON r.id = s.room_id AND r.default_bot_id = s.bot_id WHERE s.room_id = ?`,
  );
  const saveSession = db.prepare("UPDATE scopes SET session_id = ? WHERE id = ?");
  const advanceAck = db.prepare(
    "UPDATE scopes SET acked_event_seq = MAX(acked_event_seq, ?) WHERE id = ?",
  );

  const wakeColumns = "id, bot_id AS botId, scope_id AS scopeId, attended";
  const insertWake = db.prepare(
    `INSERT OR IGNORE INTO wakes
     (id, bot_id, scope_id, idempotency_key, attended, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  );
  const selectPendingWake = db.prepare(
    "SELECT id FROM wakes WHERE scope_id = ? AND attended = ? AND status = 'pending'",
  );
  const selectDueWakes = db.prepare(
    `SELECT ${wakeColumns} FROM wakes
     WHERE status = 'pending' AND (not_before IS NULL OR not_before <= ?) ORDER BY rowid`,
  );
  const markWakeDone = db.prepare("UPDATE wakes SET status = 'done' WHERE id = ?");
  const setWakeNotBefore = db.prepare("UPDATE wakes SET not_before = ? WHERE id = ?");
  const reopenWake = db.prepare("UPDATE wakes SET status = 'pending', not_before = ? WHERE id = ?");
  const cancelPendingWakes = db.prepare(
    "UPDATE wakes SET status = 'done' WHERE bot_id = ? AND status = 'pending'",
  );
  const selectAnyPendingWake = db.prepare(
    "SELECT id FROM wakes WHERE scope_id = ? AND status = 'pending'",
  );

  const runColumns = `id, bot_id AS botId, status, reason, created_at AS createdAt,
    scope_id AS scopeId, wake_id AS wakeId, engine_account_id AS engineAccountId,
    input_high_seq AS inputHighSeq`;
  const selectRun = db.prepare(`SELECT ${runColumns} FROM runs WHERE id = ?`);
  const selectLatestRuns = db.prepare(
    `SELECT ${runColumns} FROM runs
     WHERE rowid IN (SELECT MAX(rowid) FROM runs GROUP BY bot_id) ORDER BY rowid`,
  );
  const selectLatestRunId = db.prepare(
    "SELECT id FROM runs WHERE bot_id = ? ORDER BY rowid DESC LIMIT 1",
  );
  const selectQueuedRuns = db.prepare(
    "SELECT id, bot_id AS botId FROM runs WHERE status = 'Queued' ORDER BY rowid",
  );
  const selectActiveRun = db.prepare(
    `SELECT ${runColumns} FROM runs WHERE bot_id = ? AND status IN ('Queued', 'Running')`,
  );
  const countRecentRuns = db.prepare(
    `SELECT COUNT(*) AS count FROM runs
     WHERE bot_id = ? AND status != 'Refused' AND created_at > ?`,
  );
  const insertRun = db.prepare(
    `INSERT OR IGNORE INTO runs
     (id, bot_id, scope_id, wake_id, engine_account_id, status, reason, created_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const claim = db.prepare(
    `UPDATE runs SET status = 'Running', boot_id = ?, started_at = ?
     WHERE id = ? AND status = 'Queued'
       AND NOT EXISTS (SELECT 1 FROM runs other WHERE other.status = 'Running'
         AND other.engine_account_id = runs.engine_account_id)
       AND NOT EXISTS (SELECT 1 FROM engine_accounts a WHERE a.id = runs.engine_account_id
         AND a.blocked_until > ?)
     RETURNING ${runColumns}`,
  );
  const pinInput = db.prepare("UPDATE runs SET input_high_seq = ? WHERE id = ?");
  // The status guards make a second finalizer a no-op, so a late result can't overwrite a stop.
  const endRunningRun = db.prepare(
    `UPDATE runs SET status = ?, reason = ?, ended_at = ?
     WHERE id = ? AND status = 'Running' AND boot_id = ? RETURNING ${runColumns}`,
  );
  const endQueuedRun = db.prepare(
    `UPDATE runs SET status = ?, reason = ?, ended_at = ?
     WHERE id = ? AND status = 'Queued' RETURNING ${runColumns}`,
  );
  const interruptRuns = db.prepare(
    `UPDATE runs SET status = 'Interrupted', reason = 'server_restarted', ended_at = ?
     WHERE status = 'Running' AND boot_id != ? RETURNING ${runColumns}`,
  );
  const insertAudit = db.prepare(
    "INSERT INTO audit_log (run_id, bot_id, status, reason, created_at) VALUES (?, ?, ?, ?, ?)",
  );

  const getBot = (id: string) => {
    const row = selectBot.get(id);
    return row ? Bot.parse(row) : undefined;
  };
  const getRun = (id: string) => {
    const row = selectRun.get(id);
    return row ? RunRow.parse(row) : undefined;
  };
  const getScope = (id: string) => Scope.parse(selectScope.get(id));
  const unackedInput = (scope: Scope) =>
    z.array(Input).parse(selectInput.all(scope.roomId, scope.ackedEventSeq));

  function recordRun(run: RunRow) {
    insertAudit.run(run.id, run.botId, run.status, run.reason, new Date().toISOString());
    emit({ type: "run.changed", run: Run.parse(run) });
  }

  function addWake(scope: Scope, key: string, attended: boolean) {
    insertWake.run(
      NodeCrypto.randomUUID(),
      scope.botId,
      scope.id,
      key,
      attended ? 1 : 0,
      new Date().toISOString(),
    );
  }

  function addRun(wake: Wake, status: "Queued" | "Refused", reason: RunReason | null) {
    const { engineAccountId } = Bot.parse(selectBot.get(wake.botId));
    const id = NodeCrypto.randomUUID();
    const now = new Date().toISOString();
    const endedAt = status === "Refused" ? now : null;
    const { changes } = insertRun.run(
      id,
      wake.botId,
      wake.scopeId,
      wake.id,
      engineAccountId,
      status,
      reason,
      now,
      endedAt,
    );
    if (changes > 0) {
      markWakeDone.run(wake.id);
      recordRun(RunRow.parse(selectRun.get(id)));
    }
  }

  function addMessage(message: ChatMessage) {
    const seq = emit({ type: "message.created", message });
    insertMessage.run(
      message.id,
      message.roomId,
      message.author,
      message.body,
      seq,
      message.createdAt,
    );
  }

  function setPause(botId: string, reason: Bot["pauseReason"]) {
    updateBotStatus.run(reason ? "paused" : "ready", reason, botId);
    const bot = getBot(botId);
    if (bot) {
      emit({ type: "bot.changed", bot });
    }
    return bot;
  }

  return {
    onEvent: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener);
    },
    eventsAfter: (seq: number) => selectAfter.all(seq).map(parseEvent),
    // seq has no gaps, so MIN(seq) alone tells how far events were pruned.
    bounds: () => {
      const { oldest, latest } = Bounds.parse(selectBounds.get());
      return { oldest: oldest ?? 1, latest: latest ?? 0 };
    },
    prune: (keep: number) => {
      deleteOld.run(keep);
    },
    // shortcut: sends the whole history, page it once rooms get long.
    state: (): ChatState => ({
      bots: z.array(Bot).parse(selectBots.all()),
      accounts: z.array(EngineAccount).parse(selectAccounts.all()),
      messages: z.array(ChatMessage).parse(selectMessages.all()),
      runs: z.array(Run).parse(selectLatestRuns.all()),
    }),

    createBot: (fields: Pick<Bot, "name" | "personality">) =>
      transaction(() => {
        const [id, roomId] = [NodeCrypto.randomUUID(), NodeCrypto.randomUUID()];
        const now = new Date().toISOString();
        insertBot.run(id, fields.name, fields.personality, now);
        insertRoom.run(roomId, id, now);
        insertScope.run(NodeCrypto.randomUUID(), roomId, id);
        const bot = Bot.parse(selectBot.get(id));
        emit({ type: "bot.changed", bot });
        return bot;
      }),
    updateBot: (id: string, fields: Pick<Bot, "name" | "personality">) =>
      transaction(() => {
        updateBotFields.run(fields.name, fields.personality, id);
        const bot = getBot(id);
        if (bot) {
          emit({ type: "bot.changed", bot });
        }
        return bot;
      }),
    setBotPause: (id: string, reason: Bot["pauseReason"]) =>
      transaction(() => setPause(id, reason)),

    // The first message of a burst makes the wake and the rest coalesce into it, so input that
    // lands during a run already has its one durable follow-up, even if the server dies.
    sendMessage: (input: { id: string; roomId: string; body: string; attended: boolean }) =>
      transaction(() => {
        const existing = selectMessage.get(input.id);
        if (existing) {
          const { roomId, body } = ChatMessage.parse(existing);
          return roomId === input.roomId && body === input.body ? "duplicate" : "conflict";
        }
        const row = selectScopeForRoom.get(input.roomId);
        if (!row) {
          return "not_found";
        }
        const scope = Scope.parse(row);
        addMessage({
          id: input.id,
          roomId: input.roomId,
          author: "human",
          body: input.body,
          createdAt: new Date().toISOString(),
        });
        if (!selectPendingWake.get(scope.id, input.attended ? 1 : 0)) {
          addWake(scope, `message:${input.id}`, input.attended);
        }
        return "sent";
      }),

    continueRun: (runId: string, attended: boolean) =>
      transaction(() => {
        const run = getRun(runId);
        if (!run) {
          return "not_found";
        }
        const latest = IdRow.parse(selectLatestRunId.get(run.botId));
        const scope = getScope(run.scopeId);
        const unanswered = (run.inputHighSeq ?? 0) > scope.ackedEventSeq;
        if (run.status !== "Interrupted" || latest.id !== run.id || !unanswered) {
          return "not_continuable";
        }
        if (getBot(run.botId)?.status === "paused") {
          return "bot_paused";
        }
        // A repeat click finds the pending wake or a newer run. Once stopped, the wake is gone,
        // so a fixed key would stop the owner continuing again.
        if (!selectAnyPendingWake.get(scope.id)) {
          addWake(scope, `continue:${run.id}:${NodeCrypto.randomUUID()}`, attended);
        }
        return "continued";
      }),

    dueWakes: (now: string) => z.array(WakeRow).parse(selectDueWakes.all(now)),
    queuedRuns: () => z.array(QueuedRun).parse(selectQueuedRuns.all()),
    botIds: () =>
      z
        .array(Bot)
        .parse(selectBots.all())
        .map(({ id }) => id),
    botStatus: (id: string) => getBot(id)?.status,

    wakeContext: (wake: Wake, now: string) => {
      const bot = Bot.parse(selectBot.get(wake.botId));
      const account = EngineAccount.parse(selectAccount.get(bot.engineAccountId));
      const dayAgo = new Date(Date.parse(now) - 86_400_000).toISOString();
      return {
        hasActiveRun: selectActiveRun.get(wake.botId) !== undefined,
        hasInput: unackedInput(getScope(wake.scopeId)).length > 0,
        botStatus: bot.status,
        runsInLastDay: Count.parse(countRecentRuns.get(wake.botId, dayAgo)).count,
        blockedUntil: account.blockedUntil,
      };
    },
    closeWake: (id: string) => {
      markWakeDone.run(id);
    },
    deferWake: (id: string, until: string) => {
      setWakeNotBefore.run(until, id);
    },
    refuseWake: (wake: Wake, reason: RunReason) =>
      transaction(() => addRun(wake, "Refused", reason)),
    queueRun: (wake: Wake) => transaction(() => addRun(wake, "Queued", null)),
    refuseQueuedRun: (id: string, reason: RunReason) =>
      transaction(() => {
        const row = endQueuedRun.get("Refused", reason, new Date().toISOString(), id);
        if (row) {
          recordRun(RunRow.parse(row));
        }
      }),

    // The input is pinned here: a message landing mid-turn is above the pin, so it is never acked
    // unseen. The session ID is durable before the engine can start.
    claimRun: (id: string, bootId: string, now: string) =>
      transaction((): ClaimedRun | undefined => {
        const row = claim.get(bootId, now, id, now);
        if (!row) {
          return undefined;
        }
        const run = RunRow.parse(row);
        const scope = getScope(run.scopeId);
        const input = unackedInput(scope);
        const sessionId = scope.sessionId ?? NodeCrypto.randomUUID();
        saveSession.run(sessionId, scope.id);
        pinInput.run(input.at(-1)?.seq ?? scope.ackedEventSeq, id);
        recordRun(run);
        return { id, sessionId, prompt: input.map(({ body }) => body).join("\n\n") };
      }),

    finishRun: (id: string, bootId: string, finished: FinishedRun) =>
      transaction(() => {
        const now = new Date().toISOString();
        const row = endRunningRun.get(finished.status, finished.reason, now, id, bootId);
        if (!row) {
          return;
        }
        const run = RunRow.parse(row);
        if (finished.status === "Completed") {
          addMessage({
            id: NodeCrypto.randomUUID(),
            roomId: getScope(run.scopeId).roomId,
            author: "bot",
            body: finished.reply ?? "",
            createdAt: now,
          });
          advanceAck.run(run.inputHighSeq, run.scopeId);
        }
        recordRun(run);
        if (finished.blockedUntil) {
          blockAccount.run(finished.blockedUntil, run.engineAccountId);
          reopenWake.run(finished.blockedUntil, run.wakeId);
          emit({
            type: "account.changed",
            account: EngineAccount.parse(selectAccount.get(run.engineAccountId)),
          });
        }
        if (finished.pauseBot) {
          setPause(run.botId, "auth_failed");
        }
      }),

    clearExpiredBlocks: (now: string) =>
      transaction(() => {
        for (const row of unblockExpired.all(now)) {
          emit({ type: "account.changed", account: EngineAccount.parse(row) });
        }
      }),

    // Pending wakes go too, or a follow-up would start right after the stop. Their input stays
    // unacked, so the next message still carries it. Returns a Running run for the caller to abort.
    stopBot: (botId: string) =>
      transaction(() => {
        cancelPendingWakes.run(botId);
        const row = selectActiveRun.get(botId);
        if (!row) {
          return undefined;
        }
        const active = RunRow.parse(row);
        if (active.status === "Running") {
          return active.id;
        }
        const ended = endQueuedRun.get("Cancelled", "stopped", new Date().toISOString(), active.id);
        recordRun(RunRow.parse(ended));
        return undefined;
      }),

    // Restart never creates a wake, and Queued runs are left alone. An interrupted bot's pending
    // wakes are closed: firing one would resend the interrupted input with no human deciding.
    // That input stays unacked, so Continue or the next message carries all of it.
    recover: (bootId: string) =>
      transaction(() => {
        for (const row of interruptRuns.all(new Date().toISOString(), bootId)) {
          const run = RunRow.parse(row);
          cancelPendingWakes.run(run.botId);
          recordRun(run);
        }
      }),

    close: () => db.close(),
  };
}
