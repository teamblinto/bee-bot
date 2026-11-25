import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { protocolVersion } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { RunTurn } from "./engine.ts";
import { startServer } from "./server.ts";
import { type EventStore, migrate, migrations, openEventStore } from "./store.ts";

let dataDir: string;
let db: DatabaseSync;
let store: EventStore | undefined;

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-team-"));
  db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
});

afterEach(() => {
  store?.close();
  store = undefined;
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

describe("lineage and versioned edits", () => {
  const open = () => (store = openEventStore(dataDir));
  const newBot = (s: EventStore, extra: { parentBotId?: string; spawnKey?: string } = {}) =>
    s.createBot({ name: "Ada", personality: "Kind", engineAccountId: "fake", ...extra });

  it("bumps a bot's version on every edit and refuses a stale expected version", () => {
    const s = open();
    const bot = newBot(s);
    expect(bot.version).toBe(1);
    const fields = { ...bot, name: "Ada 2" };
    expect(s.updateBot(bot.id, fields)).toMatchObject({ name: "Ada 2", version: 2 });
    expect(s.updateBot(bot.id, { ...fields, name: "Stale" }, 1)).toBe("version_conflict");
    expect(s.getBot(bot.id)).toMatchObject({ name: "Ada 2", version: 2 });
    expect(s.updateBot(bot.id, { ...fields, name: "Fresh" }, 2)).toMatchObject({ version: 3 });
  });

  it("returns the same bot for a repeated spawn key", () => {
    const s = open();
    const first = newBot(s, { spawnKey: "k" });
    const again = newBot(s, { spawnKey: "k" });
    expect(again.id).toBe(first.id);
    expect(s.botIds()).toHaveLength(1);
  });

  it("deleting a lead keeps its children, unparented, and drops its requests", () => {
    const s = open();
    const lead = newBot(s);
    const child = newBot(s, { parentBotId: lead.id });
    expect(s.childrenOf(lead.id)).toEqual([{ id: child.id, name: "Ada" }]);
    expect(s.spawnedBotCount()).toBe(1);
    db.prepare(
      `INSERT INTO team_requests (id, kind, payload_json, requested_by_bot_id, run_id, status,
         created_at) VALUES ('t1', 'update_bot', '{}', ?, 'run', 'pending', 'now'),
         ('t2', 'archive_bot', '{}', ?, 'run', 'applied', 'now')`,
    ).run(lead.id, lead.id);
    const changed: unknown[] = [];
    s.onEvent((event) => {
      if (event.type === "team-request.changed") {
        changed.push(event.request);
      }
    });
    expect(s.deleteBot(lead.id)).toBe("deleted");
    expect(s.getBot(child.id)?.parentBotId).toBeNull();
    expect(s.spawnedBotCount()).toBe(0);
    expect(rows("SELECT id FROM team_requests")).toEqual([]);
    expect(changed).toMatchObject([{ id: "t1", status: "declined" }]);
  });
});

describe("the team.manage grant", () => {
  const token = "t".repeat(43);
  const teamTools = ["create_bot", "update_bot", "archive_bot", "create_room", "invite_to_room"];
  const createArgs = { name: "Cy", personality: "Helpful" };
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function rpc(url: string, bearer: string, method: string, params: object) {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await response.text();
    const json = text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? "null");
    return JSON.parse(json).result;
  }

  const listed = async (url: string, bearer: string) =>
    ((await rpc(url, bearer, "tools/list", {})).tools as Array<{ name: string }>)
      .map(({ name }) => name)
      .filter((name) => teamTools.includes(name));

  const called = async (url: string, bearer: string, name: string) =>
    JSON.parse(
      (await rpc(url, bearer, "tools/call", { name, arguments: createArgs })).content[0].text,
    ) as Record<string, unknown>;

  // One turn for the lead, running `turn` against its MCP endpoint.
  async function leadTurn(
    manifest: string[],
    turn: (url: string, bearer: string, base: string) => Promise<void>,
  ) {
    const s = (store = openEventStore(dataDir));
    const lead = s.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
    s.policy.setBotManifest(lead.id, manifest);
    let done = false;
    let failure: unknown;
    let base = "";
    const runTurn: RunTurn = async ({ permissions, onDelivered }) => {
      onDelivered();
      await turn(permissions.url, permissions.token, base).catch((error: unknown) => {
        failure = error;
      });
      done = true;
      return { kind: "completed", text: "done" };
    };
    const server = await startServer({
      port: 0,
      token,
      dataDir,
      allowedOrigins: [],
      store: s,
      runTurn,
      probeEngine: async () => ({
        cliFound: true,
        version: "2.1.318",
        auth: "authenticated" as const,
        email: null,
        pauseReason: null,
      }),
    });
    close = () => server.close();
    base = `http://127.0.0.1:${server.port}`;
    s.sendMessage({ id: crypto.randomUUID(), roomId: lead.roomId, body: "Go", attended: true });
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 10_000 });
    if (failure) {
      throw failure;
    }
    return lead;
  }

  it("hides team tools from a bot without team.manage and refuses its calls", async () => {
    await leadTurn([], async (url, bearer) => {
      expect(await listed(url, bearer)).toEqual([]);
      expect(await called(url, bearer, "create_bot")).toMatchObject({
        status: "refused",
        reason: "not_granted",
      });
    });
    expect(rows("SELECT COUNT(*) AS n FROM team_requests")).toEqual([{ n: 0 }]);
  });

  it("lists team tools once the owner grants team.manage", async () => {
    await leadTurn(["team.manage"], async (url, bearer) => {
      expect(await listed(url, bearer)).toEqual(teamTools);
    });
  });

  it("refuses the next team call once the grant is taken away mid-turn", async () => {
    await leadTurn(["team.manage"], async (url, bearer, base) => {
      expect(await called(url, bearer, "create_bot")).toMatchObject({ reason: "unknown_tool" });
      const botId = store?.botIds()[0];
      const response = await fetch(`${base}/commands?protocolVersion=${protocolVersion}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: "set-bot-manifest", botId, manifest: [] }),
      });
      expect(response.status).toBe(200);
      expect(await called(url, bearer, "create_bot")).toMatchObject({
        status: "refused",
        reason: "not_granted",
      });
    });
    expect(rows("SELECT COUNT(*) AS n FROM team_requests")).toEqual([{ n: 0 }]);
  });
});
