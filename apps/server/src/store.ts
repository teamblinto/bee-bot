import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  Approval,
  type ApprovalTool,
  Bot,
  type BotAccess,
  ChatMessage,
  type ChatState,
  defaultBotModel,
  EngineAccount,
  type EngineLane,
  type EventBody,
  maxAvatarSeed,
  MemoryItem,
  memoryRequest,
  type PauseReason,
  Routine,
  RoutineFiring,
  Run,
  type RunReason,
  ServerEvent,
  type WakeSource,
  UsageLimits,
  UsageWindow,
} from "@beebot/contracts";
import { z } from "zod";

import { openEffects } from "./effects.ts";
import type { BotLaunch } from "./engine.ts";
import { openRooms } from "./rooms.ts";
import { openTasks } from "./tasks.ts";
import { catchUpWindowMs, dueSlot, nextSlot } from "./routines.ts";
import { mergeWindows, type UsageProbe, type WindowUpdate } from "./usage.ts";
import {
  buildMemory,
  ftsQuery,
  memoryLine,
  oneLine,
  readMemoryFiles,
  writeMemoryFile,
} from "./memory.ts";

const fnvPrime = 16777619;
const fnvOffset = 2166136261;

// FNV-1a, so a bot from before avatars gets the same face on every install of this migration.
export function seedFromId(id: string) {
  let hash = fnvOffset;
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), fnvPrime);
  }
  return hash >>> 0;
}

const IdRow = z.object({ id: z.string() });

export const migrations: Array<{
  name: string;
  sql: string;
  backfill?: (db: DatabaseSync) => void;
}> = [
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
  {
    name: "claude_driver",
    sql: `ALTER TABLE scopes ADD COLUMN delivered_event_seq INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE scopes ADD COLUMN session_started INTEGER NOT NULL DEFAULT 0;
    UPDATE scopes SET delivered_event_seq = acked_event_seq,
      session_started = session_id IS NOT NULL;
    INSERT INTO engine_accounts (id, label) VALUES ('claude', 'Claude');`,
  },
  {
    name: "tools_and_approvals",
    // Stored events lack the new required fields, so they would not parse. Clients get a snapshot.
    sql: `DELETE FROM events;
    ALTER TABLE bots ADD COLUMN model TEXT NOT NULL DEFAULT 'sonnet';
    ALTER TABLE messages ADD COLUMN tools TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE audit_log ADD COLUMN tool TEXT;
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs (id),
      bot_id TEXT NOT NULL REFERENCES bots (id),
      tool TEXT NOT NULL,
      digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'expired')),
      reason TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX approvals_pending ON approvals (status) WHERE status = 'pending';
    CREATE TABLE bot_tool_grants (
      bot_id TEXT NOT NULL REFERENCES bots (id),
      tool TEXT NOT NULL,
      PRIMARY KEY (bot_id, tool)
    );
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      notice_acknowledged_at TEXT
    );
    INSERT INTO settings (id) VALUES (1);`,
  },
  {
    name: "bot_memory",
    // An old session's tool history is unknown, so it starts tainted. messages has no integer
    // primary key, so a VACUUM could renumber the rowids messages_fts points at: nothing may run one.
    sql: `ALTER TABLE scopes ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0;
    UPDATE scopes SET tainted = session_started;
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id),
      type TEXT NOT NULL CHECK (type IN ('user', 'feedback', 'project', 'reference')),
      source TEXT NOT NULL CHECK (source IN ('user', 'agent')),
      source_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'superseded', 'forgotten')),
      created TEXT NOT NULL,
      superseded_by TEXT,
      text TEXT NOT NULL
    );
    CREATE INDEX memory_by_bot ON memory_items (bot_id, status);
    CREATE VIRTUAL TABLE memory_fts USING fts5(text);
    CREATE VIRTUAL TABLE messages_fts USING fts5(body, content = 'messages', content_rowid = 'rowid');
    CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
    END;
    CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
    END;
    CREATE TRIGGER messages_fts_update AFTER UPDATE OF body ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
      INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
    END;
    INSERT INTO messages_fts (messages_fts) VALUES ('rebuild');`,
  },
  {
    name: "run_timing",
    // Stored events lack the new required fields, so they would not parse. Clients get a snapshot.
    sql: `DELETE FROM events;
    ALTER TABLE messages ADD COLUMN worked_ms INTEGER;`,
  },
  {
    name: "usage_limits",
    sql: `CREATE TABLE usage_checks (
      account_id TEXT PRIMARY KEY REFERENCES engine_accounts (id),
      checked_at TEXT NOT NULL,
      unavailable TEXT
    );
    CREATE TABLE usage_windows (
      account_id TEXT NOT NULL REFERENCES engine_accounts (id),
      window_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      window_duration_mins INTEGER,
      used_percent REAL,
      resets_at TEXT,
      status TEXT,
      PRIMARY KEY (account_id, window_id)
    );`,
  },
  {
    name: "bot_engine",
    // Stored events lack the new required fields, so they would not parse. Clients get a snapshot.
    sql: `DELETE FROM events;
    ALTER TABLE bots ADD COLUMN effort TEXT;
    ALTER TABLE bots ADD COLUMN mode TEXT NOT NULL DEFAULT 'build'
      CHECK (mode IN ('build', 'plan'));
    ALTER TABLE bots ADD COLUMN access TEXT NOT NULL DEFAULT 'supervised'
      CHECK (access IN ('supervised', 'auto-edits', 'full'));`,
  },
  {
    name: "bot_avatars",
    // Stored events lack the new required fields, so they would not parse. Clients get a snapshot.
    sql: `DELETE FROM events;
    ALTER TABLE bots ADD COLUMN avatar_seed INTEGER NOT NULL DEFAULT 0;`,
    backfill: (db: DatabaseSync) => {
      const update = db.prepare("UPDATE bots SET avatar_seed = ? WHERE id = ?");
      for (const { id } of z.array(IdRow).parse(db.prepare("SELECT id FROM bots").all())) {
        update.run(seedFromId(id), id);
      }
    },
  },
  {
    name: "bot_project_path",
    // Stored events lack the new required fields, so they would not parse. Clients get a snapshot.
    sql: `DELETE FROM events;
    ALTER TABLE bots ADD COLUMN project_path TEXT;`,
  },
  {
    name: "codex_account",
    sql: "INSERT INTO engine_accounts (id, label) VALUES ('codex', 'Codex');",
  },
  {
    name: "routines",
    sql: `CREATE TABLE routines (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id),
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      skip_if_later_mins INTEGER,
      next_fire_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX routines_due ON routines (next_fire_at) WHERE enabled = 1;
    CREATE TABLE routine_firings (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL REFERENCES routines (id),
      slot TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ready', 'ran', 'skipped', 'missed')),
      reason TEXT,
      missed_before INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      UNIQUE (routine_id, slot)
    );`,
  },
  {
    name: "environment_id",
    sql: "ALTER TABLE settings ADD COLUMN environment_id TEXT NOT NULL DEFAULT '';",
    backfill: (db: DatabaseSync) => {
      db.prepare("UPDATE settings SET environment_id = ?").run(NodeCrypto.randomUUID());
    },
  },
  {
    name: "account_lane",
    sql: `ALTER TABLE engine_accounts ADD COLUMN lane TEXT NOT NULL DEFAULT 'subscription'
      CHECK (lane IN ('subscription', 'api_key'));
    UPDATE events SET payload = json_set(payload, '$.account.lane', 'subscription')
      WHERE type = 'account.changed';`,
  },
  {
    name: "coordination",
    // Stored events lack the new required fields, so they would not parse. Clients get a snapshot.
    // Rebuilds copy rowid, which orders bots' latest runs. Foreign keys are off here, so approvals
    // and scopes keep pointing at the rebuilt tables by name.
    sql: `DELETE FROM events;
    CREATE TABLE rooms_new (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'dm' CHECK (kind IN ('dm', 'group')),
      name TEXT,
      default_bot_id TEXT REFERENCES bots (id),
      created_at TEXT NOT NULL,
      CHECK (kind = 'group' OR default_bot_id IS NOT NULL)
    );
    INSERT INTO rooms_new (rowid, id, kind, default_bot_id, created_at)
      SELECT rowid, id, 'dm', default_bot_id, created_at FROM rooms;
    DROP TABLE rooms;
    ALTER TABLE rooms_new RENAME TO rooms;
    CREATE UNIQUE INDEX rooms_one_dm_per_bot ON rooms (default_bot_id) WHERE kind = 'dm';
    ALTER TABLE messages ADD COLUMN bot_id TEXT REFERENCES bots (id);
    ALTER TABLE messages ADD COLUMN reply_to_id TEXT;
    ALTER TABLE messages ADD COLUMN chain_id TEXT;
    ALTER TABLE messages ADD COLUMN hop INTEGER NOT NULL DEFAULT 0;
    UPDATE messages SET bot_id = (SELECT default_bot_id FROM rooms WHERE rooms.id = messages.room_id)
      WHERE author = 'bot';
    ALTER TABLE wakes ADD COLUMN source TEXT NOT NULL DEFAULT 'human'
      CHECK (source IN ('human', 'routine', 'task', 'approval', 'continue'));
    ALTER TABLE wakes ADD COLUMN chain_id TEXT;
    ALTER TABLE wakes ADD COLUMN hop INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE wakes ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
    UPDATE wakes SET source = 'continue' WHERE idempotency_key LIKE 'continue:%';
    UPDATE wakes SET source = 'routine'
      WHERE substr(idempotency_key, 9) IN (SELECT id FROM routine_firings);
    ALTER TABLE scopes ADD COLUMN no_progress_runs INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE scopes ADD COLUMN left_at TEXT;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('delegate', 'handoff')),
      chain_id TEXT NOT NULL,
      hop INTEGER NOT NULL,
      depth INTEGER NOT NULL,
      parent_run_id TEXT NOT NULL REFERENCES runs (id),
      requester_bot_id TEXT NOT NULL REFERENCES bots (id),
      owner_bot_id TEXT NOT NULL REFERENCES bots (id),
      room_id TEXT NOT NULL REFERENCES rooms (id),
      goal TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'done', 'refused', 'failed', 'cancelled')),
      result_message_id TEXT REFERENCES messages (id),
      delivery_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX tasks_by_parent_run ON tasks (parent_run_id);
    CREATE INDEX tasks_open ON tasks (status) WHERE status = 'open';
    CREATE TABLE runs_new (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots (id),
      scope_id TEXT NOT NULL REFERENCES scopes (id),
      wake_id TEXT NOT NULL REFERENCES wakes (id),
      engine_account_id TEXT NOT NULL REFERENCES engine_accounts (id),
      status TEXT NOT NULL CHECK (status IN ('Queued', 'Refused', 'Running', 'Completed', 'Failed',
        'Cancelled', 'Interrupted', 'WaitingUser', 'WaitingQuota')),
      reason TEXT,
      input_high_seq INTEGER,
      boot_id TEXT,
      chain_id TEXT,
      hop INTEGER NOT NULL DEFAULT 0,
      depth INTEGER NOT NULL DEFAULT 0,
      task_id TEXT REFERENCES tasks (id),
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT
    );
    INSERT INTO runs_new (rowid, id, bot_id, scope_id, wake_id, engine_account_id, status, reason,
        input_high_seq, boot_id, created_at, started_at, ended_at)
      SELECT rowid, id, bot_id, scope_id, wake_id, engine_account_id, status, reason,
        input_high_seq, boot_id, created_at, started_at, ended_at FROM runs;
    DROP TABLE runs;
    ALTER TABLE runs_new RENAME TO runs;
    CREATE UNIQUE INDEX runs_one_active_per_bot ON runs (bot_id)
      WHERE status IN ('Queued', 'Running');
    CREATE UNIQUE INDEX runs_one_running_per_account ON runs (engine_account_id)
      WHERE status = 'Running';
    CREATE INDEX runs_by_bot ON runs (bot_id, created_at);
    CREATE INDEX runs_by_chain ON runs (chain_id) WHERE chain_id IS NOT NULL;
    ALTER TABLE routines ADD COLUMN created_by_run_id TEXT REFERENCES runs (id);
    ALTER TABLE routines ADD COLUMN approved_at TEXT;
    UPDATE routines SET approved_at = created_at;
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs (id),
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX outbox_pending ON outbox (next_attempt_at) WHERE status = 'pending';
    CREATE TABLE external_effects (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs (id),
      tool TEXT NOT NULL,
      target TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('intended', 'done', 'failed', 'uncertain')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX external_effects_intended ON external_effects (run_id)
      WHERE status = 'intended';
    CREATE TABLE room_rounds (
      room_id TEXT PRIMARY KEY REFERENCES rooms (id),
      chain_id TEXT,
      bot_posts INTEGER NOT NULL DEFAULT 0,
      window_started_at TEXT,
      updated_at TEXT NOT NULL
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
  deliveredEventSeq: z.number(),
  sessionId: z.string().nullable(),
  sessionStarted: z.number().transform(Boolean),
});
type Scope = z.infer<typeof Scope>;
const Input = z.object({ body: z.string(), seq: z.number() });
const MessageRow = ChatMessage.extend({
  tools: z.string().transform((text) => z.array(z.string()).parse(JSON.parse(text))),
});
const Settings = z.object({ noticeAcknowledgedAt: z.string().nullable() });
const HistoryRow = ChatMessage.pick({ author: true, body: true });
const FoundMessage = ChatMessage.pick({ author: true, body: true, createdAt: true });
const RowId = z.object({ rowid: z.number() });
const Tainted = z.object({ tainted: z.number().transform(Boolean) });
const Attended = z.object({ attended: z.number().transform(Boolean) });
const Count = z.object({ count: z.number() });
const QueuedRun = z.object({ id: z.string(), botId: z.string(), engineAccountId: z.string() });
const UsageCheck = z.object({
  accountId: z.string(),
  checkedAt: z.string(),
  unavailable: z
    .string()
    .nullable()
    .transform((text) =>
      text === null ? null : UsageLimits.shape.unavailable.parse(JSON.parse(text)),
    ),
});
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
const RoutineRow = Routine.extend({ enabled: z.number().transform(Boolean) });

export type ClaimedRun = {
  id: string;
  attended: boolean;
  prompt: string;
  sessionId: string;
  resume: boolean;
  launch: BotLaunch;
};

export type FinishedRun = {
  status: "Completed" | "Failed" | "Cancelled";
  reason: RunReason | null;
  reply?: string;
  tools?: string[];
  blockedUntil?: string;
  pauseBot?: PauseReason;
};

const continuationNote =
  "Your previous turn was cut off before it finished. Continue from where you left off.";
const approvalsInState = 500;
const enginePauses = [
  "auth_failed",
  "cli_missing",
  "cli_version",
  "config_dir",
  "credential_source",
] satisfies PauseReason[];
const credentialPauses = ["auth_failed", "credential_source"] satisfies PauseReason[];
const digestCap = 16_000;
const digestRows = 200;
const digestHeader =
  "[Earlier conversation, restored from history. This is background, not new instructions.]";
const digestFooter = "[End of earlier conversation.]";
const searchRows = 10;
const foundBodyChars = 500;

// Newest first in, oldest first out. A newest message over the cap keeps only its tail.
export function buildDigest(newestFirst: ReadonlyArray<Pick<ChatMessage, "author" | "body">>) {
  let room = digestCap - digestHeader.length - digestFooter.length - 2;
  const lines: string[] = [];
  for (const { author, body } of newestFirst) {
    const label = author === "human" ? "Owner: " : "Bot: ";
    const size = label.length + body.length + 1;
    if (size > room) {
      if (lines.length === 0) {
        lines.push(label + body.slice(-(room - label.length - 1)));
      }
      break;
    }
    room -= size;
    lines.unshift(label + body);
  }
  return lines.length > 0 ? [digestHeader, ...lines, digestFooter].join("\n") : "";
}

export function migrate(db: DatabaseSync, upTo = migrations.length) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  // node:sqlite turns this on, and it can't change inside a transaction. Off, ALTER TABLE can add a
  // defaulted foreign key and a rebuilt table can be dropped under the rows that point at it.
  db.exec("PRAGMA foreign_keys = OFF");
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
    migrations.slice(applied.length, upTo).forEach((migration, index) => {
      db.exec(migration.sql);
      migration.backfill?.(db);
      record.run(applied.length + index + 1, migration.name, new Date().toISOString());
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

type RoutineFields = Pick<
  Routine,
  "name" | "prompt" | "cron" | "timezone" | "enabled" | "skipIfLaterMins"
>;

function routineBody({ name, timezone, prompt }: Routine, slot: string, lateMs: number) {
  const lateBy = Math.round(lateMs / 60_000);
  const header = `[Routine "${oneLine(name)}": scheduled_for ${slot} (${timezone}), late_by ${lateBy} minutes]`;
  return `${header}\n\n${prompt}`;
}

// Synchronous, and not re-entrant: a module's write can't run inside another's transaction.
export type StoreTx = {
  transaction: <T>(work: () => T) => T;
  emit: (body: EventBody) => number;
};

export type EventStore = ReturnType<typeof openEventStore>;

export function openEventStore(dataDir: string) {
  NodeFS.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"), { timeout: 5000 });
  try {
    db.exec("PRAGMA journal_mode = WAL");
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
    r.id AS roomId, b.engine_account_id AS engineAccountId, b.model, b.effort, b.mode, b.access,
    b.avatar_seed AS avatarSeed, b.project_path AS projectPath`;
  const selectBots = db.prepare(
    `SELECT ${botColumns} FROM bots b JOIN rooms r ON r.default_bot_id = b.id AND r.kind = 'dm'
     ORDER BY b.rowid`,
  );
  const selectBot = db.prepare(
    `SELECT ${botColumns} FROM bots b JOIN rooms r ON r.default_bot_id = b.id AND r.kind = 'dm'
     WHERE b.id = ?`,
  );
  const insertBot = db.prepare(
    `INSERT INTO bots
     (id, name, personality, status, engine_account_id, model, avatar_seed, project_path, created_at)
     VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?)`,
  );
  const insertRoom = db.prepare(
    "INSERT INTO rooms (id, default_bot_id, created_at) VALUES (?, ?, ?)",
  );
  const insertScope = db.prepare("INSERT INTO scopes (id, room_id, bot_id) VALUES (?, ?, ?)");
  const updateBotFields = db.prepare(
    `UPDATE bots SET name = ?, personality = ?, model = ?, effort = ?, avatar_seed = ?,
       project_path = ? WHERE id = ?`,
  );
  const resetBotAccess = db.prepare("UPDATE bots SET access = 'supervised' WHERE id = ?");
  const deleteGrants = db.prepare("DELETE FROM bot_tool_grants WHERE bot_id = ?");
  // delivered_event_seq stays: it splits the new session's digest from its input.
  const forgetSessions = db.prepare(
    "UPDATE scopes SET session_id = NULL, session_started = 0 WHERE bot_id = ?",
  );
  const updateBotEngine = db.prepare(
    "UPDATE bots SET model = ?, effort = ?, mode = ?, access = ? WHERE id = ?",
  );
  const updateBotStatus = db.prepare("UPDATE bots SET status = ?, pause_reason = ? WHERE id = ?");

  const accountColumns = "id, label, lane, blocked_until AS blockedUntil";
  const selectAccounts = db.prepare(`SELECT ${accountColumns} FROM engine_accounts ORDER BY id`);
  const selectAccount = db.prepare(`SELECT ${accountColumns} FROM engine_accounts WHERE id = ?`);
  const blockAccount = db.prepare("UPDATE engine_accounts SET blocked_until = ? WHERE id = ?");
  const updateLane = db.prepare(
    `UPDATE engine_accounts SET lane = ? WHERE id = ? AND lane <> ? RETURNING ${accountColumns}`,
  );
  const unblockExpired = db.prepare(
    `UPDATE engine_accounts SET blocked_until = NULL WHERE blocked_until <= ?
     RETURNING ${accountColumns}`,
  );

  const messageColumns = `id, room_id AS roomId, author, body, tools, worked_ms AS workedMs,
    bot_id AS botId, reply_to_id AS replyToId, chain_id AS chainId, hop, created_at AS createdAt`;
  const selectMessages = db.prepare(`SELECT ${messageColumns} FROM messages ORDER BY event_seq`);
  const selectMessage = db.prepare(`SELECT ${messageColumns} FROM messages WHERE id = ?`);
  const insertMessage = db.prepare(
    `INSERT INTO messages (id, room_id, author, body, tools, worked_ms, bot_id, reply_to_id,
       chain_id, hop, event_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectInput = db.prepare(
    `SELECT body, event_seq AS seq FROM messages
     WHERE room_id = ? AND author = 'human' AND event_seq > ? ORDER BY event_seq`,
  );
  const selectHistory = db.prepare(
    `SELECT author, body FROM messages WHERE room_id = ? AND (author = 'bot' OR event_seq <= ?)
     ORDER BY event_seq DESC LIMIT ${digestRows}`,
  );

  const scopeColumns = `s.id, s.room_id AS roomId, s.bot_id AS botId,
    s.acked_event_seq AS ackedEventSeq, s.delivered_event_seq AS deliveredEventSeq,
    s.session_id AS sessionId, s.session_started AS sessionStarted`;
  const selectScope = db.prepare(`SELECT ${scopeColumns} FROM scopes s WHERE s.id = ?`);
  const selectScopeForRoom = db.prepare(
    `SELECT ${scopeColumns} FROM scopes s
     JOIN rooms r ON r.id = s.room_id AND r.default_bot_id = s.bot_id WHERE s.room_id = ?`,
  );
  const saveSession = db.prepare(
    "UPDATE scopes SET session_id = ?, session_started = 0, tainted = 0 WHERE id = ?",
  );
  const updateSessionId = db.prepare(
    "UPDATE scopes SET session_id = ? WHERE id = (SELECT scope_id FROM runs WHERE id = ?)",
  );
  const markScopeTainted = db.prepare(
    "UPDATE scopes SET tainted = 1 WHERE id = (SELECT scope_id FROM runs WHERE id = ?)",
  );
  const selectTainted = db.prepare(
    "SELECT s.tainted FROM scopes s JOIN runs r ON r.scope_id = s.id WHERE r.id = ?",
  );
  const advanceDelivered = db.prepare(
    `UPDATE scopes SET delivered_event_seq = MAX(delivered_event_seq, ?), session_started = 1
     WHERE id = ?`,
  );
  const advanceAck = db.prepare(
    "UPDATE scopes SET acked_event_seq = MAX(acked_event_seq, ?) WHERE id = ?",
  );

  const wakeColumns = "id, bot_id AS botId, scope_id AS scopeId, attended";
  const insertWake = db.prepare(
    `INSERT OR IGNORE INTO wakes
     (id, bot_id, scope_id, idempotency_key, attended, source, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
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
  const selectWakeAttended = db.prepare("SELECT attended FROM wakes WHERE id = ?");

  const runColumns = `id, bot_id AS botId, status, reason, created_at AS createdAt,
    started_at AS startedAt, ended_at AS endedAt, scope_id AS scopeId, wake_id AS wakeId, engine_account_id AS engineAccountId,
    input_high_seq AS inputHighSeq, chain_id AS chainId, hop, depth, task_id AS taskId`;
  const selectRun = db.prepare(`SELECT ${runColumns} FROM runs WHERE id = ?`);
  const selectLatestRuns = db.prepare(
    `SELECT ${runColumns} FROM runs
     WHERE rowid IN (SELECT MAX(rowid) FROM runs GROUP BY bot_id) ORDER BY rowid`,
  );
  const selectLatestRunId = db.prepare(
    "SELECT id FROM runs WHERE bot_id = ? ORDER BY rowid DESC LIMIT 1",
  );
  const selectQueuedRuns = db.prepare(
    `SELECT id, bot_id AS botId, engine_account_id AS engineAccountId FROM runs
     WHERE status = 'Queued' ORDER BY rowid`,
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
    `INSERT INTO audit_log (run_id, bot_id, status, reason, tool, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const approvalColumns = `id, run_id AS runId, bot_id AS botId, tool, digest, status, reason,
    created_at AS createdAt, decided_at AS decidedAt`;
  const selectApprovals = db.prepare(
    `SELECT ${approvalColumns} FROM approvals ORDER BY rowid DESC LIMIT ${approvalsInState}`,
  );
  const insertApproval = db.prepare(
    `INSERT INTO approvals (id, run_id, bot_id, tool, digest, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?) RETURNING ${approvalColumns}`,
  );
  const endApproval = db.prepare(
    `UPDATE approvals SET status = ?, reason = ?, decided_at = ?
     WHERE id = ? AND status = 'pending' RETURNING ${approvalColumns}`,
  );
  const expireApprovals = db.prepare(
    `UPDATE approvals SET status = 'expired', reason = 'server_restarted', decided_at = ?
     WHERE status = 'pending' RETURNING ${approvalColumns}`,
  );
  const selectGrant = db.prepare("SELECT 1 FROM bot_tool_grants WHERE bot_id = ? AND tool = ?");
  const insertGrant = db.prepare("INSERT OR IGNORE INTO bot_tool_grants VALUES (?, ?)");
  const selectSettings = db.prepare(
    "SELECT notice_acknowledged_at AS noticeAcknowledgedAt FROM settings",
  );
  const { environmentId } = z
    .object({ environmentId: z.string().min(1) })
    .parse(db.prepare("SELECT environment_id AS environmentId FROM settings").get());
  const acknowledge = db.prepare(
    `UPDATE settings SET notice_acknowledged_at = ? WHERE notice_acknowledged_at IS NULL
     RETURNING notice_acknowledged_at AS noticeAcknowledgedAt`,
  );

  const memoryColumns = `i.id, i.bot_id AS botId, i.type, i.source, i.source_ref AS sourceRef,
    i.status, i.created, i.superseded_by AS supersededBy, i.text`;
  const selectMemory = db.prepare(`SELECT ${memoryColumns} FROM memory_items i WHERE i.id = ?`);
  const selectActiveItem = db.prepare(
    `SELECT ${memoryColumns} FROM memory_items i
     WHERE i.bot_id = ? AND i.id = ? AND i.status = 'active'`,
  );
  const selectActiveItems = db.prepare(
    `SELECT ${memoryColumns} FROM memory_items i WHERE i.bot_id = ? AND i.status = 'active'`,
  );
  const selectStateMemory = db.prepare(
    `SELECT ${memoryColumns} FROM memory_items i
     WHERE i.status IN ('pending', 'active') ORDER BY i.created`,
  );
  // The bot_id guard: a file copied into another bot's folder must not rewrite the first bot's item.
  const upsertMemory = db.prepare(
    `INSERT INTO memory_items
     (id, bot_id, type, source, source_ref, status, created, superseded_by, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET status = excluded.status,
       superseded_by = excluded.superseded_by, text = excluded.text
     WHERE bot_id = excluded.bot_id RETURNING rowid`,
  );
  const deleteMemoryText = db.prepare("DELETE FROM memory_fts WHERE rowid = ?");
  const insertMemoryText = db.prepare("INSERT INTO memory_fts (rowid, text) VALUES (?, ?)");
  const searchItems = db.prepare(
    `SELECT ${memoryColumns} FROM memory_fts f JOIN memory_items i ON i.rowid = f.rowid
     WHERE memory_fts MATCH ? AND i.bot_id = ? AND i.status = 'active'
     ORDER BY f.rank LIMIT ${searchRows}`,
  );
  const searchMessages = db.prepare(
    `SELECT m.author, m.body, m.created_at AS createdAt
     FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
     WHERE messages_fts MATCH ? AND m.room_id IN (SELECT room_id FROM scopes WHERE bot_id = ?)
     ORDER BY f.rank LIMIT ${searchRows}`,
  );

  const routineColumns = `id, bot_id AS botId, name, prompt, cron, timezone, enabled,
    skip_if_later_mins AS skipIfLaterMins, next_fire_at AS nextFireAt, created_at AS createdAt`;
  const selectRoutines = db.prepare(`SELECT ${routineColumns} FROM routines ORDER BY rowid`);
  const selectRoutine = db.prepare(`SELECT ${routineColumns} FROM routines WHERE id = ?`);
  const selectDueRoutines = db.prepare(
    `SELECT ${routineColumns} FROM routines
     WHERE enabled = 1 AND next_fire_at <= ? ORDER BY rowid`,
  );
  const insertRoutine = db.prepare(
    `INSERT INTO routines (id, bot_id, name, prompt, cron, timezone, enabled, skip_if_later_mins,
       next_fire_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateRoutineFields = db.prepare(
    `UPDATE routines SET name = ?, prompt = ?, cron = ?, timezone = ?, enabled = ?,
       skip_if_later_mins = ?, next_fire_at = ? WHERE id = ?`,
  );
  const advanceRoutine = db.prepare("UPDATE routines SET next_fire_at = ? WHERE id = ?");
  const disableRoutine = db.prepare(
    "UPDATE routines SET enabled = 0, next_fire_at = NULL WHERE id = ?",
  );
  const deleteRoutineRow = db.prepare("DELETE FROM routines WHERE id = ?");
  const firingColumns = `id, routine_id AS routineId, slot, status, reason,
    missed_before AS missedBefore, created_at AS createdAt, decided_at AS decidedAt`;
  const selectFiring = db.prepare(`SELECT ${firingColumns} FROM routine_firings WHERE id = ?`);
  const selectSlot = db.prepare("SELECT 1 FROM routine_firings WHERE routine_id = ? AND slot = ?");
  const selectLatestFirings = db.prepare(
    `SELECT ${firingColumns} FROM routine_firings
     WHERE rowid IN (SELECT MAX(rowid) FROM routine_firings GROUP BY routine_id) ORDER BY rowid`,
  );
  const insertFiring = db.prepare(
    `INSERT INTO routine_firings
     (id, routine_id, slot, status, reason, missed_before, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${firingColumns}`,
  );
  const closeFiring = db.prepare(
    `UPDATE routine_firings SET status = ?, reason = ?, decided_at = ?
     WHERE routine_id = ? AND status = 'ready' RETURNING ${firingColumns}`,
  );
  const deleteFirings = db.prepare("DELETE FROM routine_firings WHERE routine_id = ?");

  const selectAccountRunning = db.prepare(
    "SELECT 1 FROM runs WHERE engine_account_id = ? AND status = 'Running'",
  );
  const selectUsageChecks = db.prepare(
    `SELECT account_id AS accountId, checked_at AS checkedAt, unavailable FROM usage_checks
     ORDER BY account_id`,
  );
  const selectUsageCheck = db.prepare(
    `SELECT account_id AS accountId, checked_at AS checkedAt, unavailable FROM usage_checks
     WHERE account_id = ?`,
  );
  const selectUsageWindows = db.prepare(
    `SELECT window_id AS id, kind, label, window_duration_mins AS windowDurationMins,
       used_percent AS usedPercent, resets_at AS resetsAt, status
     FROM usage_windows WHERE account_id = ? ORDER BY rowid`,
  );
  const upsertUsageCheck = db.prepare(
    `INSERT INTO usage_checks (account_id, checked_at, unavailable) VALUES (?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET checked_at = excluded.checked_at,
       unavailable = excluded.unavailable`,
  );
  const deleteUsageWindows = db.prepare("DELETE FROM usage_windows WHERE account_id = ?");
  const insertUsageWindow = db.prepare(
    `INSERT INTO usage_windows (account_id, window_id, kind, label, window_duration_mins,
       used_percent, resets_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const usageWindows = (accountId: string) =>
    z.array(UsageWindow).parse(selectUsageWindows.all(accountId));

  function usageLimits(accountId: string): UsageLimits {
    const check = selectUsageCheck.get(accountId);
    const { checkedAt = null, unavailable = null } = check ? UsageCheck.parse(check) : {};
    return { accountId, checkedAt, unavailable, windows: usageWindows(accountId) };
  }

  function writeUsage(
    accountId: string,
    windows: UsageWindow[],
    unavailable: UsageLimits["unavailable"],
  ) {
    const stored = unavailable === null ? null : JSON.stringify(unavailable);
    upsertUsageCheck.run(accountId, new Date().toISOString(), stored);
    deleteUsageWindows.run(accountId);
    for (const { id, kind, label, windowDurationMins, usedPercent, resetsAt, status } of windows) {
      insertUsageWindow.run(
        accountId,
        id,
        kind,
        label,
        windowDurationMins,
        usedPercent,
        resetsAt,
        status,
      );
    }
    emit({ type: "usage.changed", limits: usageLimits(accountId) });
  }

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

  // Delivered input is already in the engine's transcript, so it is never sent twice. A new session
  // has no transcript, so it opens with the room history that came before this input.
  function turnPrompt(scope: Scope, highSeq: number) {
    const input = unackedInput(scope).filter(
      ({ seq }) => seq > scope.deliveredEventSeq && seq <= highSeq,
    );
    const text = input.map(({ body }) => body).join("\n\n") || continuationNote;
    if (scope.sessionStarted) {
      return text;
    }
    const history = z
      .array(HistoryRow)
      .parse(selectHistory.all(scope.roomId, scope.deliveredEventSeq));
    const digest = buildDigest(history);
    return digest ? `${digest}\n\n${text}` : text;
  }

  function recordRun(run: RunRow) {
    insertAudit.run(run.id, run.botId, run.status, run.reason, null, new Date().toISOString());
    emit({ type: "run.changed", run: Run.parse(run) });
  }

  // The tool name and the decision only: tool input can hold secrets.
  function recordApproval(row: unknown) {
    const approval = Approval.parse(row);
    const { runId, botId, status, reason, tool } = approval;
    insertAudit.run(runId, botId, status, reason, tool, new Date().toISOString());
    emit({ type: "approval.changed", approval });
  }

  function addWake(scope: Scope, key: string, attended: boolean, source: WakeSource) {
    insertWake.run(
      NodeCrypto.randomUUID(),
      scope.botId,
      scope.id,
      key,
      attended ? 1 : 0,
      source,
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
      JSON.stringify(message.tools),
      message.workedMs,
      message.botId,
      message.replyToId,
      message.chainId,
      message.hop,
      seq,
      message.createdAt,
    );
  }

  // The first message of a burst makes the wake and the rest coalesce into it, so input that
  // lands during a run already has its one durable follow-up, even if the server dies.
  function postMessage(
    input: { id: string; roomId: string; body: string; attended: boolean },
    source: WakeSource = "human",
  ) {
    const existing = selectMessage.get(input.id);
    if (existing) {
      const { roomId, body } = MessageRow.parse(existing);
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
      tools: [],
      workedMs: null,
      botId: null,
      replyToId: null,
      chainId: null,
      hop: 0,
      createdAt: new Date().toISOString(),
    });
    if (!selectPendingWake.get(scope.id, input.attended ? 1 : 0)) {
      addWake(scope, `message:${input.id}`, input.attended, source);
    }
    return "sent";
  }

  const getRoutine = (id: string) => {
    const row = selectRoutine.get(id);
    return row ? RoutineRow.parse(row) : undefined;
  };

  function endOpenFiring(
    routineId: string,
    status: RoutineFiring["status"],
    reason: RoutineFiring["reason"],
  ) {
    for (const row of closeFiring.all(status, reason, new Date().toISOString(), routineId)) {
      emit({ type: "firing.changed", firing: RoutineFiring.parse(row) });
    }
  }

  function recordFiring(
    routine: Routine,
    { slot, passedOver }: { slot: string; passedOver: number },
    now: string,
  ) {
    let outcome: Pick<RoutineFiring, "status" | "reason"> = { status: "ready", reason: null };
    if (Date.parse(now) - Date.parse(slot) > catchUpWindowMs) {
      outcome = { status: "missed", reason: "asleep" };
    } else if (getBot(routine.botId)?.status === "paused") {
      outcome = { status: "skipped", reason: "bot_paused" };
    }
    const { status, reason } = outcome;
    const decidedAt = status === "ready" ? null : now;
    const id = NodeCrypto.randomUUID();
    const firing = RoutineFiring.parse(
      insertFiring.get(id, routine.id, slot, status, reason, passedOver, now, decidedAt),
    );
    emit({ type: "firing.changed", firing });
  }

  function fireRoutine(row: unknown, now: string) {
    const routine = RoutineRow.parse(row);
    const next = nextSlot(routine, now);
    transaction(() => {
      if (next === null) {
        endOpenFiring(routine.id, "skipped", "disabled");
        disableRoutine.run(routine.id);
      } else {
        const due = dueSlot(routine, z.string().parse(routine.nextFireAt), now);
        // A slot on record changes nothing, so a repeat can't close the card it opened.
        if (!selectSlot.get(routine.id, due.slot)) {
          // First, so a client that replaces by routine ends on the new firing.
          endOpenFiring(routine.id, "skipped", "no_boundary");
          recordFiring(routine, due, now);
        }
        advanceRoutine.run(next, routine.id);
      }
      emit({ type: "routine.changed", routine: RoutineRow.parse(selectRoutine.get(routine.id)) });
    });
  }

  const getMemory = (id: string) => {
    const row = selectMemory.get(id);
    return row ? MemoryItem.parse(row) : undefined;
  };
  const getActiveMemory = (botId: string, id: string) => {
    const row = selectActiveItem.get(botId, id);
    return row ? MemoryItem.parse(row) : undefined;
  };
  const isTainted = (runId: string) => Tainted.parse(selectTainted.get(runId)).tainted;

  function indexMemory(item: MemoryItem) {
    const { id, botId, type, source, sourceRef, status, created, supersededBy, text } = item;
    const row = upsertMemory.get(
      id,
      botId,
      type,
      source,
      sourceRef,
      status,
      created,
      supersededBy,
      text,
    );
    if (row) {
      const { rowid } = RowId.parse(row);
      deleteMemoryText.run(rowid);
      insertMemoryText.run(rowid, text);
    }
  }

  // Inside a transaction. File first, then index: a crash or failed commit between them leaves a
  // newer file, and the next boot heals it.
  function saveMemory(item: MemoryItem) {
    writeMemoryFile(dataDir, item);
    indexMemory(item);
    emit({ type: "memory.changed", memory: item });
  }

  const newMemory = (
    fields: Pick<MemoryItem, "botId" | "type" | "source" | "sourceRef" | "status" | "text">,
  ): MemoryItem => ({
    ...fields,
    id: NodeCrypto.randomUUID(),
    created: new Date().toISOString(),
    supersededBy: null,
  });

  const retired = (old: MemoryItem, next: MemoryItem): MemoryItem => ({
    ...old,
    status: "superseded",
    supersededBy: next.id,
  });

  // After the new item is saved, and that item's source_ref names the old one: a crash between
  // loses nothing, and the rebuild finishes the job.
  const retire = (old: MemoryItem, next: MemoryItem) => saveMemory(retired(old, next));

  function finishSupersede(item: MemoryItem) {
    const [kind, targetId = ""] = item.sourceRef.split(":");
    const target =
      item.status === "active" && kind === "supersede"
        ? getActiveMemory(item.botId, targetId)
        : undefined;
    if (!target) {
      return;
    }
    const old = retired(target, item);
    indexMemory(old);
    try {
      writeMemoryFile(dataDir, old);
    } catch (error) {
      // The index is right for this boot, and the next rebuild tries the file again.
      console.error(
        `beebotd: memory ${old.id} not retired: ${(error as NodeJS.ErrnoException).code}`,
      );
    }
  }

  function setPause(botId: string, reason: Bot["pauseReason"]) {
    updateBotStatus.run(reason ? "paused" : "ready", reason, botId);
    const bot = getBot(botId);
    if (bot) {
      emit({ type: "bot.changed", bot });
    }
    return bot;
  }

  function clearEnginePauses(engineAccountId: string, reasons: PauseReason[] = enginePauses) {
    for (const bot of z.array(Bot).parse(selectBots.all())) {
      const paused = bot.pauseReason && reasons.includes(bot.pauseReason);
      if (bot.engineAccountId === engineAccountId && paused) {
        setPause(bot.id, null);
      }
    }
  }

  // The files are the truth, so the index is rebuilt at every boot. No events: a client from before
  // this boot gets a snapshot instead (`catchUp`).
  transaction(() => {
    db.exec("DELETE FROM memory_items; DELETE FROM memory_fts;");
    for (const { id } of z.array(Bot).parse(selectBots.all())) {
      const items = readMemoryFiles(dataDir, id);
      items.forEach(indexMemory);
      items.forEach(finishSupersede);
    }
  });

  const tx: StoreTx = { transaction, emit };
  const rooms = openRooms(db, tx);
  const tasks = openTasks(db, tx);

  return {
    rooms,
    tasks,
    effects: openEffects(db, tx),
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
      messages: z.array(MessageRow).parse(selectMessages.all()),
      runs: z.array(Run).parse(selectLatestRuns.all()),
      approvals: z.array(Approval).parse(selectApprovals.all()).reverse(),
      memories: z.array(MemoryItem).parse(selectStateMemory.all()),
      usageLimits: z
        .array(UsageCheck)
        .parse(selectUsageChecks.all())
        .map(({ accountId }) => usageLimits(accountId)),
      routines: z.array(RoutineRow).parse(selectRoutines.all()),
      firings: z.array(RoutineFiring).parse(selectLatestFirings.all()),
      rooms: rooms.listRooms(),
      tasks: tasks.openTasks(),
      noticeAcknowledgedAt: Settings.parse(selectSettings.get()).noticeAcknowledgedAt,
    }),

    createBot: ({
      name,
      personality,
      engineAccountId,
      model = defaultBotModel,
      avatarSeed = NodeCrypto.randomInt(maxAvatarSeed + 1),
      projectPath = null,
    }: Pick<Bot, "name" | "personality" | "engineAccountId"> &
      Partial<Pick<Bot, "model" | "avatarSeed" | "projectPath">>) =>
      transaction(() => {
        const [id, roomId] = [NodeCrypto.randomUUID(), NodeCrypto.randomUUID()];
        const now = new Date().toISOString();
        insertBot.run(id, name, personality, engineAccountId, model, avatarSeed, projectPath, now);
        insertRoom.run(roomId, id, now);
        insertScope.run(NodeCrypto.randomUUID(), roomId, id);
        const bot = Bot.parse(selectBot.get(id));
        emit({ type: "bot.changed", bot });
        return bot;
      }),
    getBot,
    updateBot: (
      id: string,
      fields: Pick<Bot, "name" | "personality" | "model" | "effort" | "avatarSeed" | "projectPath">,
    ) =>
      transaction(() => {
        const { name, personality, model, effort, avatarSeed, projectPath } = fields;
        const moved = getBot(id)?.projectPath !== projectPath;
        updateBotFields.run(name, personality, model, effort, avatarSeed, projectPath, id);
        // What the owner allowed was allowed for the old folder, and a session can't change folder.
        if (moved) {
          deleteGrants.run(id);
          resetBotAccess.run(id);
          forgetSessions.run(id);
        }
        const bot = getBot(id);
        if (bot) {
          emit({ type: "bot.changed", bot });
        }
        return bot;
      }),
    setBotEngine: (id: string, fields: Pick<Bot, "model" | "effort" | "mode" | "access">) =>
      transaction(() => {
        const { model, effort, mode, access } = fields;
        updateBotEngine.run(model, effort, mode, access, id);
        const bot = getBot(id);
        if (bot) {
          emit({ type: "bot.changed", bot });
        }
        return bot;
      }),
    botAccess: (id: string) => getBot(id)?.access,
    botBusy: (id: string) => selectActiveRun.get(id) !== undefined,
    setBotPause: (id: string, reason: Bot["pauseReason"]) =>
      transaction(() => setPause(id, reason)),
    // An owner's pause is left alone: its reason says what the owner has to undo.
    pauseReadyBots: (engineAccountId: string, reason: PauseReason) =>
      transaction(() => {
        for (const bot of z.array(Bot).parse(selectBots.all())) {
          if (bot.engineAccountId === engineAccountId && bot.status === "ready") {
            setPause(bot.id, reason);
          }
        }
      }),
    clearEnginePauses: (engineAccountId: string) =>
      transaction(() => clearEnginePauses(engineAccountId)),
    accountLane: (id: string) => EngineAccount.parse(selectAccount.get(id)).lane,
    // Credential pauses are lifted so the next run's gate checks the CLI against the new lane.
    setAccountLane: (id: string, lane: EngineLane) =>
      transaction(() => {
        const changed = updateLane.get(lane, id, lane);
        if (changed) {
          emit({ type: "account.changed", account: EngineAccount.parse(changed) });
          clearEnginePauses(id, credentialPauses);
        }
      }),

    sendMessage: (input: { id: string; roomId: string; body: string; attended: boolean }) =>
      transaction(() => postMessage(input)),

    getRoutine,
    createRoutine: (fields: RoutineFields & Pick<Routine, "botId">) =>
      transaction(() => {
        const now = new Date().toISOString();
        const { botId, name, prompt, cron, timezone, enabled, skipIfLaterMins } = fields;
        const id = NodeCrypto.randomUUID();
        const next = enabled ? nextSlot(fields, now) : null;
        insertRoutine.run(
          id,
          botId,
          name,
          prompt,
          cron,
          timezone,
          enabled ? 1 : 0,
          skipIfLaterMins,
          next,
          now,
        );
        const routine = RoutineRow.parse(selectRoutine.get(id));
        emit({ type: "routine.changed", routine });
        return routine;
      }),
    updateRoutine: (id: string, fields: RoutineFields) =>
      transaction(() => {
        const current = getRoutine(id);
        if (!current) {
          return undefined;
        }
        const { name, prompt, cron, timezone, enabled, skipIfLaterMins } = fields;
        const rescheduled =
          cron !== current.cron || timezone !== current.timezone || enabled !== current.enabled;
        let next = current.nextFireAt;
        if (rescheduled) {
          next = enabled ? nextSlot(fields, new Date().toISOString()) : null;
          endOpenFiring(id, "skipped", "disabled");
        }
        updateRoutineFields.run(
          name,
          prompt,
          cron,
          timezone,
          enabled ? 1 : 0,
          skipIfLaterMins,
          next,
          id,
        );
        const routine = RoutineRow.parse(selectRoutine.get(id));
        emit({ type: "routine.changed", routine });
        return routine;
      }),
    deleteRoutine: (id: string) =>
      transaction(() => {
        deleteFirings.run(id);
        const { changes } = deleteRoutineRow.run(id);
        if (changes > 0) {
          emit({ type: "routine.deleted", routineId: id });
        }
        return changes > 0;
      }),

    // Row by row, so one bad row can't block the others. A slot is decided only by comparing the
    // wall clock with the stored time, so a laptop's sleep is just a catch-up on the next tick.
    fireDueRoutines: (now: string) => {
      for (const row of selectDueRoutines.all(now)) {
        try {
          fireRoutine(row, now);
        } catch (error) {
          console.error(`beebotd: routine ${IdRow.safeParse(row).data?.id} failed`, error);
        }
      }
    },

    // Only a person's click reaches this. `attended` can't stand in for one: it says a client is
    // connected, not that anybody decided anything.
    startFiring: (id: string, attended: boolean) =>
      transaction(() => {
        const row = selectFiring.get(id);
        if (!row) {
          return "not_found";
        }
        const firing = RoutineFiring.parse(row);
        if (firing.status !== "ready") {
          return "firing_closed";
        }
        if (!attended) {
          return "not_attended";
        }
        const routine = RoutineRow.parse(selectRoutine.get(firing.routineId));
        const lateMs = Math.max(Date.now() - Date.parse(firing.slot), 0);
        const { skipIfLaterMins } = routine;
        if (skipIfLaterMins !== null && lateMs > skipIfLaterMins * 60_000) {
          endOpenFiring(routine.id, "skipped", "too_late");
          return "too_late";
        }
        const { id: botId, roomId, status } = Bot.parse(selectBot.get(routine.botId));
        if (status === "paused") {
          return "bot_paused";
        }
        if (selectActiveRun.get(botId)) {
          return "bot_busy";
        }
        endOpenFiring(routine.id, "ran", null);
        const body = routineBody(routine, firing.slot, lateMs);
        if (postMessage({ id, roomId, body, attended }, "routine") !== "sent") {
          throw new Error(`firing ${id} could not post its message`);
        }
        return "started";
      }),
    skipFiring: (id: string) =>
      transaction(() => {
        const row = selectFiring.get(id);
        if (!row) {
          return "not_found";
        }
        const firing = RoutineFiring.parse(row);
        if (firing.status !== "ready") {
          return "firing_closed";
        }
        endOpenFiring(firing.routineId, "skipped", null);
        return "skipped";
      }),

    continueRun: (runId: string, attended: boolean) =>
      transaction(() => {
        const run = getRun(runId);
        if (!run) {
          return "not_found";
        }
        const latest = IdRow.parse(selectLatestRunId.get(run.botId));
        const scope = getScope(run.scopeId);
        const unanswered = unackedInput(scope).length > 0;
        const cutOff = run.status === "Interrupted" || run.status === "Cancelled";
        if (!cutOff || latest.id !== run.id || !unanswered) {
          return "not_continuable";
        }
        if (getBot(run.botId)?.status === "paused") {
          return "bot_paused";
        }
        // A repeat click finds the pending wake or a newer run. Once stopped, the wake is gone,
        // so a fixed key would stop the owner continuing again.
        if (!selectAnyPendingWake.get(scope.id)) {
          addWake(scope, `continue:${run.id}:${NodeCrypto.randomUUID()}`, attended, "continue");
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
        const sessionId = scope.sessionId ?? NodeCrypto.randomUUID();
        if (!scope.sessionId) {
          saveSession.run(sessionId, scope.id);
        }
        const highSeq = unackedInput(scope).at(-1)?.seq ?? scope.ackedEventSeq;
        pinInput.run(highSeq, id);
        recordRun(run);
        const { name, personality, model, effort, mode, projectPath } = Bot.parse(
          selectBot.get(run.botId),
        );
        return {
          id,
          attended: Attended.parse(selectWakeAttended.get(run.wakeId)).attended,
          sessionId,
          resume: scope.sessionStarted,
          prompt: turnPrompt(scope, highSeq),
          launch: {
            botId: run.botId,
            name,
            personality,
            engineAccountId: run.engineAccountId,
            lane: EngineAccount.parse(selectAccount.get(run.engineAccountId)).lane,
            model,
            effort,
            mode,
            projectPath,
            memory: buildMemory(z.array(MemoryItem).parse(selectActiveItems.all(run.botId))),
          },
        };
      }),

    // Only the ID: a Codex thread replaces the placeholder, and the scope's taint still stands.
    setSessionId: (runId: string, sessionId: string) => {
      updateSessionId.run(sessionId, runId);
    },

    markDelivered: (id: string) => {
      const { inputHighSeq, scopeId } = RunRow.parse(selectRun.get(id));
      advanceDelivered.run(inputHighSeq, scopeId);
    },

    // The new ID is durable before the engine starts. If this turn dies first, the next one still
    // finds an unstarted session and sends the digest.
    restartSession: (id: string) =>
      transaction(() => {
        const { inputHighSeq, scopeId } = RunRow.parse(selectRun.get(id));
        const sessionId = NodeCrypto.randomUUID();
        saveSession.run(sessionId, scopeId);
        return { sessionId, prompt: turnPrompt(getScope(scopeId), inputHighSeq ?? 0) };
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
            tools: finished.tools ?? [],
            workedMs: run.startedAt ? Date.parse(now) - Date.parse(run.startedAt) : null,
            botId: run.botId,
            replyToId: null,
            chainId: run.chainId,
            hop: run.hop,
            createdAt: now,
          });
          advanceAck.run(run.inputHighSeq, run.scopeId);
          advanceDelivered.run(run.inputHighSeq, run.scopeId);
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
          setPause(run.botId, finished.pauseBot);
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

    openApproval: (fields: Pick<Approval, "runId" | "botId" | "tool" | "digest">) =>
      transaction(() => {
        const { runId, botId, tool, digest } = fields;
        const id = NodeCrypto.randomUUID();
        const now = new Date().toISOString();
        const approval = Approval.parse(insertApproval.get(id, runId, botId, tool, digest, now));
        emit({ type: "approval.changed", approval });
        return approval;
      }),
    closeApproval: (id: string, status: Approval["status"], reason: Approval["reason"]) =>
      transaction(() => {
        const row = endApproval.get(status, reason, new Date().toISOString(), id);
        if (row) {
          recordApproval(row);
        }
      }),
    // For calls settled without a card.
    auditTool: (
      runId: string,
      botId: string,
      tool: ApprovalTool,
      status: "allowed" | "refused",
      reason: "always" | `access:${BotAccess}` | null,
    ) => {
      insertAudit.run(runId, botId, status, reason, tool, new Date().toISOString());
    },
    toolGranted: (botId: string, tool: ApprovalTool) => selectGrant.get(botId, tool) !== undefined,
    grantTool: (botId: string, tool: ApprovalTool) => {
      insertGrant.run(botId, tool);
    },

    // One autocommit statement, so the mark is durable before the caller goes on.
    markTainted: (runId: string) => {
      markScopeTainted.run(runId);
    },

    activeMemory: getActiveMemory,
    searchMemory: (botId: string, query: string) => {
      const match = ftsQuery(query);
      if (!match) {
        return [];
      }
      const items = z.array(MemoryItem).parse(searchItems.all(match, botId));
      const messages = z.array(FoundMessage).parse(searchMessages.all(match, botId));
      return [
        ...items.map(memoryLine),
        ...messages.map(({ author, body, createdAt }) => {
          const who = author === "human" ? "owner" : "bot";
          const text = oneLine(body).slice(0, foundBodyChars);
          return `[room | ${who} | ${createdAt.slice(0, 10)}] ${text}`;
        }),
      ];
    },

    // A tainted session only asks: the request is a new pending item and the target stays as it is
    // until the owner decides. Taint is read in the transaction that writes.
    proposeMemory: (
      run: { id: string; botId: string },
      input: Pick<MemoryItem, "text" | "type"> & { supersedes?: string | undefined },
    ) =>
      transaction(() => {
        const { text, type, supersedes } = input;
        const target =
          supersedes === undefined ? undefined : getActiveMemory(run.botId, supersedes);
        if (supersedes !== undefined && !target) {
          return undefined;
        }
        const tainted = isTainted(run.id);
        const item = newMemory({
          botId: run.botId,
          type,
          source: "agent",
          sourceRef: target ? `supersede:${target.id}` : `run:${run.id}`,
          status: tainted ? "pending" : "active",
          text,
        });
        saveMemory(item);
        if (target && !tainted) {
          retire(target, item);
        }
        return item;
      }),
    // A clean forget's reason has nowhere to live, and it stays out of the audit log.
    forgetMemoryAsBot: (run: { id: string; botId: string }, id: string, reason: string) =>
      transaction(() => {
        const target = getActiveMemory(run.botId, id);
        if (!target) {
          return undefined;
        }
        if (isTainted(run.id)) {
          const { botId, type } = target;
          const sourceRef = `forget:${target.id}`;
          saveMemory(
            newMemory({ botId, type, source: "agent", sourceRef, status: "pending", text: reason }),
          );
          return "requested";
        }
        saveMemory({ ...target, status: "forgotten" });
        return "forgotten";
      }),

    addMemory: (
      input: Pick<MemoryItem, "botId" | "text" | "type"> & { supersedes?: string | undefined },
    ) =>
      transaction(() => {
        const { botId, text, type, supersedes } = input;
        const target = supersedes === undefined ? undefined : getActiveMemory(botId, supersedes);
        if (!getBot(botId) || (supersedes !== undefined && !target)) {
          return undefined;
        }
        const sourceRef = target ? `supersede:${target.id}` : "owner";
        const item = newMemory({ botId, type, source: "user", sourceRef, status: "active", text });
        saveMemory(item);
        if (target) {
          retire(target, item);
        }
        return item;
      }),
    decideMemory: (id: string, decision: "approve" | "reject") =>
      transaction(() => {
        const item = getMemory(id);
        if (item?.status !== "pending") {
          return false;
        }
        const request = memoryRequest(item);
        const target = request && getActiveMemory(item.botId, request.targetId);
        if (decision === "reject" || request?.kind === "forget") {
          if (decision === "approve" && target) {
            saveMemory({ ...target, status: "forgotten" });
          }
          saveMemory({ ...item, status: "forgotten" });
          return true;
        }
        const approved: MemoryItem = { ...item, status: "active" };
        saveMemory(approved);
        if (target) {
          retire(target, approved);
        }
        return true;
      }),
    forgetMemory: (id: string) =>
      transaction(() => {
        const item = getMemory(id);
        if (item?.status !== "active" && item?.status !== "pending") {
          return false;
        }
        saveMemory({ ...item, status: "forgotten" });
        return true;
      }),

    accountRunning: (accountId: string) => selectAccountRunning.get(accountId) !== undefined,
    // A failed check keeps the last good rows: the stream may still move them, and the client shows
    // the notice in their place.
    saveUsage: (accountId: string, { windows, unavailable }: UsageProbe) =>
      transaction(() =>
        writeUsage(accountId, unavailable ? usageWindows(accountId) : windows, unavailable),
      ),
    mergeUsage: (accountId: string, updates: WindowUpdate[]) =>
      transaction(() => {
        const current = usageLimits(accountId);
        const merged = mergeWindows(current.windows, updates);
        if (JSON.stringify(merged) !== JSON.stringify(current.windows)) {
          writeUsage(accountId, merged, current.unavailable);
        }
      }),

    environmentId,

    acknowledgeNotice: () =>
      transaction(() => {
        const row = acknowledge.get(new Date().toISOString());
        if (row) {
          const acknowledgedAt = z.string().parse(Settings.parse(row).noticeAcknowledgedAt);
          emit({ type: "notice.acknowledged", acknowledgedAt });
        }
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
        // Their tool calls died with the old process, so no decision can reach them.
        expireApprovals.all(new Date().toISOString()).forEach(recordApproval);
      }),

    close: () => db.close(),
  };
}
