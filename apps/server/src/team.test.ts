import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { protocolVersion } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createBoxService } from "./boxSetup.ts";
import { staticClaudeModels } from "./claude.ts";
import type { RunTurn } from "./engine.ts";
import { startServer } from "./server.ts";
import { type EventStore, migrate, migrations, openEventStore } from "./store.ts";
import { createTeam } from "./team.ts";

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
      expect(await called(url, bearer, "create_bot")).toMatchObject({
        reason: "boxes_unavailable",
      });
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

describe("team requests", () => {
  const token = "t".repeat(43);
  const createArgs = { name: "Cy", personality: "Helpful" };
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  type Call = (name: string, args: object) => Promise<Record<string, unknown>>;
  type Setup = { boxesUp?: () => boolean; before?: (s: EventStore, leadId: string) => void };

  const fakeBoxes = (up: () => boolean) => {
    const refuse = async () => Promise.reject(new Error("no boxes"));
    const service = createBoxService({
      machine: () => "beebot-test",
      probe: async () => ({
        found: false,
        running: false,
        boxdInstalled: false,
        imageBuilt: false,
      }),
      initMachine: refuse,
      startMachine: refuse,
      stopMachine: refuse,
      buildImage: refuse,
      startHost: refuse,
      setUpBefore: () => false,
      markSetUp: () => {},
    });
    return { ...service, ready: up };
  };

  // One turn for a granted lead, running `turn` against its MCP endpoint. Later turns, such as the
  // one a decision's DM line wakes, end at once.
  async function leadTurn(turn: (call: Call, runId: string) => Promise<void>, setup: Setup = {}) {
    const s = (store = openEventStore(dataDir));
    const lead = s.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
    s.policy.setBotManifest(lead.id, ["team.manage"]);
    setup.before?.(s, lead.id);
    let pending: typeof turn | undefined = turn;
    let done = false;
    let failure: unknown;
    const runTurn: RunTurn = async ({ permissions, onDelivered }) => {
      onDelivered();
      const current = pending;
      pending = undefined;
      if (current) {
        const runId = String(
          rows(`SELECT id FROM runs WHERE bot_id = '${lead.id}' AND status = 'Running'`)[0]?.id,
        );
        const call: Call = async (name, args) => {
          const response = await fetch(permissions.url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${permissions.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          });
          const text = await response.text();
          const json = text.startsWith("{") ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? "null");
          return JSON.parse(JSON.parse(json).result.content[0].text);
        };
        await current(call, runId).catch((error: unknown) => {
          failure = error;
        });
        done = true;
      }
      return { kind: "completed", text: "done" };
    };
    const server = await startServer({
      port: 0,
      token,
      dataDir,
      allowedOrigins: [],
      fakeEngine: true,
      store: s,
      runTurn,
      boxes: fakeBoxes(setup.boxesUp ?? (() => true)),
      probeEngine: async () => ({
        cliFound: true,
        version: "2.1.318",
        auth: "authenticated" as const,
        email: null,
        pauseReason: null,
      }),
    });
    close = () => server.close();
    s.sendMessage({ id: crypto.randomUUID(), roomId: lead.roomId, body: "Go", attended: true });
    await vi.waitFor(() => expect(done).toBe(true), { timeout: 10_000 });
    if (failure) {
      throw failure;
    }
    const decide = async (requestId: unknown, decision: "apply" | "decline") => {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/commands?protocolVersion=${protocolVersion}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ type: "decide-team-request", requestId, decision }),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    return { s, lead, decide };
  }

  const botCount = () => rows("SELECT COUNT(*) AS n FROM bots")[0]?.n;
  const dmLine = (requestId: unknown) =>
    rows(`SELECT room_id AS roomId, body FROM messages WHERE id = 'team-request:${requestId}'`);

  it("queues a lead's create_bot for the owner by default, and creates nothing yet", async () => {
    let answer: Record<string, unknown> = {};
    const { s } = await leadTurn(async (call) => {
      answer = await call("create_bot", createArgs);
    });
    expect(answer).toMatchObject({ status: "awaiting_approval" });
    expect(s.state().teamRequests).toMatchObject([
      { id: answer.request_id, kind: "create_bot", payload: createArgs, status: "pending" },
    ]);
    expect(botCount()).toBe(1);
  });

  it("applies on the owner's word: a boxed child of the lead, on the lead's engine, told in the lead's DM", async () => {
    let answer: Record<string, unknown> = {};
    const { s, lead, decide } = await leadTurn(async (call) => {
      answer = await call("create_bot", createArgs);
    });
    const decided = await decide(answer.request_id, "apply");
    expect(decided).toMatchObject({ status: 200, body: { status: "applied" } });
    const child = s.getBot(String(s.team.get(String(answer.request_id))?.result?.botId));
    expect(child).toMatchObject({
      name: "Cy",
      boundary: "box",
      parentBotId: lead.id,
      manifest: [],
      projectPath: null,
      engineAccountId: lead.engineAccountId,
    });
    expect(dmLine(answer.request_id)).toMatchObject([{ roomId: lead.roomId }]);
    expect(s.state().teamRequests).toEqual([]);
  });

  it("declines without creating, and tells the lead", async () => {
    let answer: Record<string, unknown> = {};
    const { lead, decide } = await leadTurn(async (call) => {
      answer = await call("create_bot", createArgs);
    });
    expect(await decide(answer.request_id, "decline")).toMatchObject({
      status: 200,
      body: { status: "declined" },
    });
    expect(botCount()).toBe(1);
    expect(dmLine(answer.request_id)).toMatchObject([{ roomId: lead.roomId }]);
  });

  it("returns the same request for a replayed call", async () => {
    const answers: Array<Record<string, unknown>> = [];
    await leadTurn(async (call) => {
      answers.push(await call("create_bot", createArgs));
      answers.push(await call("create_bot", createArgs));
    });
    expect(answers[1]?.request_id).toBe(answers[0]?.request_id);
    expect(rows("SELECT COUNT(*) AS n FROM team_requests")).toEqual([{ n: 1 }]);
  });

  it("acts at once when leads may act without asking and the run is attended and clean", async () => {
    let answer: Record<string, unknown> = {};
    const { s, lead } = await leadTurn(
      async (call) => {
        answer = await call("create_bot", createArgs);
      },
      { before: (s) => s.setLeadsActWithoutAsking(true) },
    );
    expect(answer).toMatchObject({ status: "applied" });
    expect(s.getBot(String(answer.botId))).toMatchObject({ parentBotId: lead.id, boundary: "box" });
  });

  it("still waits for the owner from a tainted session or an unattended run, whatever the setting", async () => {
    const answers: Array<Record<string, unknown>> = [];
    const { s } = await leadTurn(
      async (call, runId) => {
        const lead = store?.botIds()[0] ?? "";
        const mustNot = () => ({ status: 500, body: { code: "must_not_apply" } });
        const team = createTeam({
          store: store ?? openEventStore(dataDir),
          apply: {
            createBot: mustNot,
            updateBot: mustNot,
            archiveBot: mustNot,
            createRoom: mustNot,
            addRoomMember: mustNot,
          },
          boxesReady: () => true,
          modelsOf: () => staticClaudeModels,
        });
        const unattended = team.call({ id: runId, botId: lead, attended: false }, "create_bot", {
          ...createArgs,
          name: "Dee",
        });
        answers.push(JSON.parse(unattended));
        store?.markUntrusted(runId);
        answers.push(await call("create_bot", createArgs));
      },
      { before: (s) => s.setLeadsActWithoutAsking(true) },
    );
    expect(answers).toMatchObject([
      { status: "awaiting_approval" },
      { status: "awaiting_approval" },
    ]);
    expect(s.state().teamRequests).toHaveLength(2);
    expect(botCount()).toBe(1);
  });

  it("refuses a 4th create_bot in one turn", async () => {
    const answers: Array<Record<string, unknown>> = [];
    await leadTurn(async (call) => {
      for (const name of ["A", "B", "C", "D"]) {
        answers.push(await call("create_bot", { ...createArgs, name }));
      }
    });
    expect(answers.map(({ status }) => status)).toEqual([
      "awaiting_approval",
      "awaiting_approval",
      "awaiting_approval",
      "refused",
    ]);
    expect(answers[3]).toMatchObject({ reason: "spawn_cap_turn" });
  });

  it("refuses past 20 lead-made bots, counting pending creates", async () => {
    const answers: Array<Record<string, unknown>> = [];
    await leadTurn(
      async (call) => {
        answers.push(await call("create_bot", { ...createArgs, name: "A" }));
        answers.push(await call("create_bot", { ...createArgs, name: "B" }));
      },
      {
        before: (s, leadId) => {
          for (let i = 0; i < 19; i += 1) {
            s.createBot({
              name: `K${i}`,
              personality: "",
              engineAccountId: "fake",
              parentBotId: leadId,
            });
          }
        },
      },
    );
    expect(answers).toMatchObject([
      { status: "awaiting_approval" },
      { status: "refused", reason: "spawn_cap_workspace" },
    ]);
  });

  it("refuses extra arguments such as a manifest", async () => {
    let answer: Record<string, unknown> = {};
    await leadTurn(async (call) => {
      answer = await call("create_bot", { ...createArgs, manifest: ["team.manage"] });
    });
    expect(answer).toMatchObject({ status: "refused", reason: "invalid_arguments" });
    expect(rows("SELECT COUNT(*) AS n FROM team_requests")).toEqual([{ n: 0 }]);
  });

  it("refuses a create_bot when boxes are unavailable", async () => {
    let answer: Record<string, unknown> = {};
    await leadTurn(
      async (call) => {
        answer = await call("create_bot", createArgs);
      },
      { boxesUp: () => false },
    );
    expect(answer).toMatchObject({ status: "refused", reason: "boxes_unavailable" });
  });

  it("lets a lead delegate to its own child with no shared room", async () => {
    let answer: Record<string, unknown> = {};
    await leadTurn(
      async (call) => {
        answer = await call("delegate", { to: "Kid", goal: "Tidy up" });
      },
      {
        before: (s, leadId) => {
          s.createBot({
            name: "Kid",
            personality: "",
            engineAccountId: "fake",
            parentBotId: leadId,
          });
        },
      },
    );
    expect(answer).toMatchObject({ status: "delegated", to: "Kid" });
  });

  it("apply fails cleanly when the world moved", async () => {
    let up = true;
    let answer: Record<string, unknown> = {};
    const { s, lead, decide } = await leadTurn(
      async (call) => {
        answer = await call("create_bot", createArgs);
      },
      { boxesUp: () => up },
    );
    up = false;
    expect(await decide(answer.request_id, "apply")).toMatchObject({
      status: 200,
      body: { status: "failed", result: { code: "boxes_unavailable" } },
    });
    expect(botCount()).toBe(1);
    expect(s.state().teamRequests).toEqual([]);
    expect(dmLine(answer.request_id)).toMatchObject([{ roomId: lead.roomId }]);
  });

  it("refuses a second decision on the same request", async () => {
    let answer: Record<string, unknown> = {};
    const { decide } = await leadTurn(async (call) => {
      answer = await call("create_bot", createArgs);
    });
    expect((await decide(answer.request_id, "decline")).status).toBe(200);
    expect(await decide(answer.request_id, "apply")).toMatchObject({
      status: 409,
      body: { code: "team_request_closed" },
    });
    expect(botCount()).toBe(1);
  });

  const kid = (s: EventStore, parentBotId: string, name = "Kid") =>
    s.createBot({ name, personality: "", engineAccountId: "fake", parentBotId });
  const stranger = (s: EventStore, name: string) =>
    s.createBot({ name, personality: "", engineAccountId: "fake" });

  it("refuses an 11th pending request from one lead", async () => {
    let answer: Record<string, unknown> = {};
    await leadTurn(
      async (call) => {
        answer = await call("archive_bot", { bot_id: "Kid" });
      },
      {
        before: (s, leadId) => {
          kid(s, leadId);
          for (let i = 0; i < 10; i += 1) {
            s.team.insert({
              kind: "archive_bot",
              payload: {},
              requestedByBotId: leadId,
              runId: "earlier",
              spawnKey: `k${i}`,
            });
          }
        },
      },
    );
    expect(answer).toMatchObject({ status: "refused", reason: "too_many_pending" });
    expect(rows("SELECT COUNT(*) AS n FROM team_requests")).toEqual([{ n: 10 }]);
  });

  it("lets a lead edit its own child with the current version", async () => {
    let childId = "";
    let answer: Record<string, unknown> = {};
    const { s, decide } = await leadTurn(
      async (call) => {
        answer = await call("update_bot", { bot_id: "Kid", expected_version: 1, name: "Kiddo" });
      },
      { before: (s, leadId) => void (childId = kid(s, leadId).id) },
    );
    expect(answer).toMatchObject({ status: "awaiting_approval" });
    expect(await decide(answer.request_id, "apply")).toMatchObject({
      status: 200,
      body: { status: "applied", result: { botId: childId } },
    });
    expect(s.getBot(childId)).toMatchObject({ name: "Kiddo", personality: "", version: 2 });
  });

  it("refuses a lead editing or archiving a bot it did not create", async () => {
    const answers: Array<Record<string, unknown>> = [];
    await leadTurn(
      async (call) => {
        for (const bot of ["Own", "Ada", "Grandkid"]) {
          answers.push(await call("update_bot", { bot_id: bot, expected_version: 1, name: "X" }));
          answers.push(await call("archive_bot", { bot_id: bot }));
        }
      },
      {
        before: (s, leadId) => {
          stranger(s, "Own");
          kid(s, kid(s, leadId).id, "Grandkid");
        },
      },
    );
    expect(answers).toMatchObject(
      Array.from({ length: 6 }, () => ({ status: "refused", reason: "not_your_bot" })),
    );
    expect(rows("SELECT COUNT(*) AS n FROM team_requests")).toEqual([{ n: 0 }]);
  });

  it("refuses manifest or engine fields on an edit", async () => {
    let answer: Record<string, unknown> = {};
    await leadTurn(
      async (call) => {
        answer = await call("update_bot", {
          bot_id: "Kid",
          expected_version: 1,
          name: "X",
          manifest: ["team.manage"],
        });
      },
      { before: (s, leadId) => void kid(s, leadId) },
    );
    expect(answer).toMatchObject({ status: "refused", reason: "invalid_arguments" });
  });

  it("refuses a stale expected_version, when asked and when applied", async () => {
    let child: ReturnType<EventStore["createBot"]> | undefined;
    const answers: Array<Record<string, unknown>> = [];
    const { s, decide } = await leadTurn(
      async (call) => {
        answers.push(await call("update_bot", { bot_id: "Kid", expected_version: 2, name: "A" }));
        answers.push(await call("update_bot", { bot_id: "Kid", expected_version: 1, name: "B" }));
      },
      { before: (s, leadId) => void (child = kid(s, leadId)) },
    );
    expect(answers).toMatchObject([
      { status: "refused", reason: "version_conflict" },
      { status: "awaiting_approval" },
    ]);
    const childId = child?.id ?? "";
    expect(child && s.updateBot(childId, { ...child, name: "Owner's" })).toMatchObject({
      version: 2,
    });
    expect(await decide(answers[1]?.request_id, "apply")).toMatchObject({
      body: { status: "failed", result: { code: "version_conflict" } },
    });
    expect(s.getBot(childId)?.name).toBe("Owner's");
  });

  it("archives a child and stops it, but not the child's own bots", async () => {
    let childId = "";
    let grandId = "";
    let answer: Record<string, unknown> = {};
    const { s } = await leadTurn(
      async (call, runId) => {
        db.prepare(
          `INSERT INTO tasks (id, kind, chain_id, hop, depth, parent_run_id, requester_bot_id,
             owner_bot_id, room_id, goal, status, delivery_key, pending_json, root_task_id, origin,
             blocked_by_json, created_at, updated_at)
           VALUES ('queued-task', 'delegate', ?1, 1, 1, ?1, ?2, ?3, ?4, 'Later', 'queued',
             'queued-task', '{}', 'queued-task', 'human', '[]', 'now', 'now')`,
        ).run(
          runId,
          store?.getBot(childId)?.parentBotId ?? "",
          childId,
          store?.getBot(childId)?.roomId ?? "",
        );
        answer = await call("archive_bot", { bot_id: "Kid" });
      },
      {
        before: (s, leadId) => {
          s.setLeadsActWithoutAsking(true);
          childId = kid(s, leadId).id;
          grandId = kid(s, childId, "Grandkid").id;
        },
      },
    );
    expect(answer).toMatchObject({ status: "applied", botId: childId });
    expect(s.getBot(childId)?.archivedAt).not.toBeNull();
    expect(s.getBot(grandId)?.archivedAt).toBeNull();
    expect(rows("SELECT status FROM tasks WHERE id = 'queued-task'")).toEqual([
      { status: "refused" },
    ]);
  });

  it("apply re-checks the lead and the child's parent", async () => {
    let childId = "";
    const answers: Array<Record<string, unknown>> = [];
    const { s, lead, decide } = await leadTurn(
      async (call) => {
        answers.push(await call("archive_bot", { bot_id: "Kid" }));
        answers.push(await call("update_bot", { bot_id: "Kid", expected_version: 1, name: "X" }));
        answers.push(await call("create_bot", createArgs));
      },
      { before: (s, leadId) => void (childId = kid(s, leadId).id) },
    );
    db.prepare("UPDATE bots SET parent_bot_id = NULL WHERE id = ?").run(childId);
    expect(await decide(answers[0]?.request_id, "apply")).toMatchObject({
      body: { status: "failed", result: { code: "not_your_bot" } },
    });
    expect(s.getBot(childId)?.archivedAt).toBeNull();
    s.archiveBot(lead.id);
    for (const { request_id } of answers.slice(1)) {
      expect(await decide(request_id, "apply")).toMatchObject({
        body: { status: "failed", result: { code: "lead_gone" } },
      });
    }
    expect(s.getBot(childId)?.name).toBe("Kid");
    expect(botCount()).toBe(2);
  });

  it("creates a room with the lead in it, from children and roommates only", async () => {
    const ids = { kid: "", rae: "" };
    const answers: Array<Record<string, unknown>> = [];
    const { s, lead } = await leadTurn(
      async (call) => {
        answers.push(await call("create_room", { name: "Crew", members: ["Kid", "Zed"] }));
        answers.push(
          await call("create_room", { name: "Crew", members: ["Kid"], default_bot: "Rae" }),
        );
        answers.push(
          await call("create_room", { name: "Crew", members: ["Kid", "Rae"], default_bot: "Kid" }),
        );
      },
      {
        before: (s, leadId) => {
          s.setLeadsActWithoutAsking(true);
          ids.kid = kid(s, leadId).id;
          stranger(s, "Zed");
          ids.rae = stranger(s, "Rae").id;
          s.rooms.createGroupRoom({ name: "Old", memberIds: [leadId, ids.rae] });
        },
      },
    );
    expect(answers).toMatchObject([
      { status: "refused", reason: "not_allowed" },
      { status: "refused", reason: "not_member" },
      { status: "applied" },
    ]);
    expect(s.rooms.getRoom(String(answers[2]?.roomId))).toMatchObject({
      name: "Crew",
      members: [lead.id, ids.kid, ids.rae],
      defaultBotId: ids.kid,
    });
  });

  it("invites only into a room the lead is in, and only its children or roommates", async () => {
    const rooms = { in: "", out: "", dm: "" };
    let kidId = "";
    const answers: Array<Record<string, unknown>> = [];
    const { s } = await leadTurn(
      async (call) => {
        answers.push(await call("invite_to_room", { room_id: rooms.out, bot: "Kid" }));
        answers.push(await call("invite_to_room", { room_id: rooms.dm, bot: "Kid" }));
        answers.push(await call("invite_to_room", { room_id: rooms.in, bot: "Zed" }));
        answers.push(await call("invite_to_room", { room_id: rooms.in, bot: "Kid" }));
      },
      {
        before: (s, leadId) => {
          s.setLeadsActWithoutAsking(true);
          kidId = kid(s, leadId).id;
          rooms.dm = s.getBot(leadId)?.roomId ?? "";
          const zed = stranger(s, "Zed");
          rooms.in = s.rooms.createGroupRoom({ name: "In", memberIds: [leadId] })?.id ?? "";
          rooms.out = s.rooms.createGroupRoom({ name: "Out", memberIds: [zed.id] })?.id ?? "";
        },
      },
    );
    expect(answers).toMatchObject([
      { status: "refused", reason: "not_in_room" },
      { status: "refused", reason: "not_in_room" },
      { status: "refused", reason: "not_allowed" },
      { status: "applied", roomId: rooms.in },
    ]);
    expect(s.rooms.getRoom(rooms.in)?.members).toContain(kidId);
    expect(s.rooms.getRoom(rooms.out)?.members).not.toContain(kidId);
  });

  it("applies room and create requests on the owner's word after the lead's turn has ended", async () => {
    const ids = { kid: "", rae: "", old: "" };
    const answers: Array<Record<string, unknown>> = [];
    const { s, lead, decide } = await leadTurn(
      async (call) => {
        answers.push(await call("create_room", { name: "Crew", members: ["Kid", "Rae"] }));
        answers.push(await call("invite_to_room", { room_id: ids.old, bot: "Kid" }));
        answers.push(
          await call("create_bot", { ...createArgs, join_rooms: [ids.old], first_task: "Tidy" }),
        );
      },
      {
        before: (s, leadId) => {
          ids.kid = kid(s, leadId).id;
          ids.rae = stranger(s, "Rae").id;
          ids.old =
            s.rooms.createGroupRoom({ name: "Old", memberIds: [leadId, ids.rae] })?.id ?? "";
        },
      },
    );
    expect(answers.map(({ status }) => status)).toEqual(Array(3).fill("awaiting_approval"));
    await vi.waitFor(() =>
      expect(
        rows(`SELECT id FROM runs WHERE bot_id = '${lead.id}' AND status = 'Running'`),
      ).toEqual([]),
    );
    const results = [];
    for (const { request_id } of answers) {
      const decided = await decide(request_id, "apply");
      expect(decided).toMatchObject({ status: 200, body: { status: "applied" } });
      results.push(s.team.get(String(request_id))?.result ?? {});
    }
    const [made, invited, created] = results;
    const childId = String(created?.botId);
    expect(s.rooms.getRoom(String(made?.roomId))?.members).toEqual([lead.id, ids.kid, ids.rae]);
    expect(invited).toEqual({ roomId: ids.old });
    expect(s.rooms.getRoom(ids.old)?.members).toEqual([lead.id, ids.rae, ids.kid, childId]);
    expect(created).toEqual({ botId: childId, firstTask: { taskId: expect.any(String) } });
    expect(s.getBot(childId)).toMatchObject({ parentBotId: lead.id });
  });
});
