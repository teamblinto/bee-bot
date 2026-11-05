import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ServerEvent } from "@beebot/contracts";
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
];

const Migration = z.object({ id: z.number(), name: z.string() });
const Bounds = z.object({ oldest: z.number().nullable(), latest: z.number().nullable() });

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
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const columns = "seq, type, created_at AS createdAt";
  const insert = db.prepare(
    `INSERT INTO events (type, created_at) VALUES (?, ?) RETURNING ${columns}`,
  );
  const selectAfter = db.prepare(`SELECT ${columns} FROM events WHERE seq > ? ORDER BY seq`);
  const selectBounds = db.prepare("SELECT MIN(seq) AS oldest, MAX(seq) AS latest FROM events");
  const deleteOld = db.prepare("DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?");

  return {
    append: (type: ServerEvent["type"]) =>
      ServerEvent.parse(insert.get(type, new Date().toISOString())),
    eventsAfter: (seq: number) => z.array(ServerEvent).parse(selectAfter.all(seq)),
    // seq has no gaps, so MIN(seq) alone tells how far events were pruned.
    bounds: () => {
      const { oldest, latest } = Bounds.parse(selectBounds.get());
      return { oldest: oldest ?? 1, latest: latest ?? 0 };
    },
    prune: (keep: number) => {
      deleteOld.run(keep);
    },
    close: () => db.close(),
  };
}
