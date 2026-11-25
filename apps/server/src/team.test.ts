import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { migrate, migrations } from "./store.ts";

let dataDir: string;
let db: DatabaseSync;

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-team-"));
  db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
});

afterEach(() => {
  db.close();
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

const rows = (sql: string) =>
  db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));

const insertBots = () =>
  db.exec(`INSERT INTO bots (id, name, personality, status, created_at)
      VALUES ('ada', 'Ada', '', 'ready', 'then'), ('bo', 'Bo', '', 'ready', 'then');
    INSERT INTO rooms (id, kind, name, created_at) VALUES ('r', 'group', 'Team', 'then');`);

describe("the Phase 3 migrations", () => {
  it("upgrades a database from before bot_lineage without touching its bots or rooms", () => {
    const lineage = migrations.findIndex(({ name }) => name === "bot_lineage");
    expect(lineage).toBeGreaterThan(0);
    migrate(db, lineage);
    insertBots();
    migrate(db);
    expect(rows("SELECT id, parent_bot_id, spawn_key, version FROM bots ORDER BY id")).toEqual([
      { id: "ada", parent_bot_id: null, spawn_key: null, version: 1 },
      { id: "bo", parent_bot_id: null, spawn_key: null, version: 1 },
    ]);
    expect(rows("SELECT responder_mode, lead_bot_id, bulletin, limits_json FROM rooms")).toEqual([
      { responder_mode: "mentions", lead_bot_id: null, bulletin: "", limits_json: "{}" },
    ]);
    expect(rows("SELECT leads_act_without_asking AS on_ FROM settings")).toEqual([{ on_: 0 }]);
    expect(migrations.slice(lineage, lineage + 4).map(({ name }) => name)).toEqual([
      "bot_lineage",
      "team_requests",
      "team_settings",
      "room_modes",
    ]);
  });

  it("refuses a second bot with the same spawn key", () => {
    migrate(db);
    insertBots();
    db.exec("UPDATE bots SET spawn_key = 'k' WHERE id = 'ada'");
    expect(() => db.exec("UPDATE bots SET spawn_key = 'k' WHERE id = 'bo'")).toThrow(/UNIQUE/);
  });

  it("refuses a second team request with the same spawn key, and an unknown kind", () => {
    migrate(db);
    insertBots();
    const insert = db.prepare(
      `INSERT INTO team_requests (id, kind, payload_json, requested_by_bot_id, run_id, spawn_key,
         status, created_at)
       VALUES (?, ?, '{}', 'ada', 'run', ?, 'pending', 'now')`,
    );
    insert.run("t1", "create_bot", "k");
    expect(() => insert.run("t2", "update_bot", "k")).toThrow(/UNIQUE/);
    expect(() => insert.run("t3", "delete_everything", "other")).toThrow(/CHECK/);
    insert.run("t4", "archive_bot", null);
    insert.run("t5", "invite_to_room", null);
    expect(rows("SELECT id FROM team_requests ORDER BY id")).toEqual([
      { id: "t1" },
      { id: "t4" },
      { id: "t5" },
    ]);
  });
});
