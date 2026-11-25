import * as NodeCrypto from "node:crypto";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Bot, type Command, protocolVersion, type Room } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

import type { RunTurn, Steer, TurnOutcome } from "./engine.ts";
import type * as LimitsModule from "./limits.ts";
import type { Verdict } from "./limits.ts";
import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";

const verdicts = vi.hoisted(() => ({
  mention: (_input: { mentions: number }): Verdict => ({ verdict: "allow" }),
  botPost: (): Verdict => ({ verdict: "allow" }),
}));
const checks = vi.hoisted(() => ({ mention: [] as unknown[], botPost: [] as unknown[] }));
// When set, the real checks decide, as in production.
const real = vi.hoisted(() => ({ on: false }));

vi.mock("./limits.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof LimitsModule>();
  return {
    ...actual,
    checkMentionWake: (...args: Parameters<typeof actual.checkMentionWake>) => {
      checks.mention.push(args[1]);
      return real.on ? actual.checkMentionWake(...args) : verdicts.mention(args[1]);
    },
    checkBotPost: (...args: Parameters<typeof actual.checkBotPost>) => {
      checks.botPost.push(args[1]);
      return real.on ? actual.checkBotPost(...args) : verdicts.botPost();
    },
  };
});

const token = "t".repeat(43);
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const allow = (): Verdict => ({ verdict: "allow" });

let dataDir: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-rooms-"));
  verdicts.mention = allow;
  verdicts.botPost = allow;
  real.on = false;
  checks.mention = [];
  checks.botPost = [];
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

type Turn = {
  botId: string;
  prompt: string;
  finish: (outcome: TurnOutcome) => void;
  steers: string[];
  // Resolves the latest steer, which stays open until the test answers it.
  take: (taken: boolean) => void;
  toolStart: (id: string) => void;
  toolEnd: (id: string) => void;
};

function scriptedEngine() {
  const turns: Turn[] = [];
  const runTurn: RunTurn = ({ prompt, launch, signal, onSteerable, onToolStart, onToolEnd }) =>
    new Promise((resolve) => {
      let answer: ((taken: boolean) => void) | undefined;
      const turn: Turn = {
        botId: launch.botId,
        prompt,
        finish: resolve,
        steers: [],
        take: (taken) => answer?.(taken),
        toolStart: (id) => onToolStart({ id, name: "Bash", detail: null }),
        toolEnd: (id) => onToolEnd(id, false),
      };
      const steer: Steer = (text) =>
        new Promise((taken) => {
          turn.steers.push(text);
          answer = taken;
        });
      onSteerable?.(steer);
      turns.push(turn);
      signal.addEventListener("abort", () => resolve({ kind: "failed" }));
    });
  return { turns, runTurn };
}

async function boot() {
  const engine = scriptedEngine();
  const store = openEventStore(dataDir);
  const server = await startServer({
    port: 0,
    token,
    dataDir,
    allowedOrigins: [],
    store,
    probeEngine: async () => ({
      cliFound: true,
      version: "2.1.318",
      auth: "authenticated" as const,
      email: null,
      pauseReason: null,
    }),
    runTurn: engine.runTurn,
  });
  cleanups.push(async () => {
    await server.close();
    store.close();
  });
  const params = new URLSearchParams({ protocolVersion: String(protocolVersion), token });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?${params}`);
  cleanups.push(() => socket.terminate());
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "subscribe", afterSeq: 0 }));
  await once(socket, "message");

  const command = (body: Command) =>
    fetch(`http://127.0.0.1:${server.port}/commands?protocolVersion=${protocolVersion}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    });
  const createBot = async (name: string) =>
    (await (await command({ type: "create-bot", name, personality: "" })).json()) as Bot;
  const createRoom = async (members: Bot[], defaultBot?: Bot) =>
    (await (
      await command({
        type: "create-room",
        name: "Team",
        memberIds: members.map(({ id }) => id),
        ...(defaultBot && { defaultBotId: defaultBot.id }),
      })
    ).json()) as Room;
  const send = (roomId: string, body: string) =>
    command({ type: "send-message", messageId: NodeCrypto.randomUUID(), roomId, body });
  const turnsFor = (bot: Bot) => engine.turns.filter(({ botId }) => botId === bot.id);
  const expectTurns = (count: number) =>
    vi.waitFor(() => expect(engine.turns).toHaveLength(count), { timeout: 5000 });
  const roomMessages = (room: Room) =>
    store.state().messages.filter(({ roomId }) => roomId === room.id);
  return {
    store,
    engine,
    command,
    createBot,
    createRoom,
    send,
    turnsFor,
    expectTurns,
    roomMessages,
  };
}

function query(sql: string) {
  const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

const done = (text: string): TurnOutcome => ({ kind: "completed", text });

describe("a group room", () => {
  it("wakes only the bot a message names", async () => {
    const { createBot, createRoom, send, engine, expectTurns, roomMessages, store } = await boot();
    const [ada, ben, cy] = [await createBot("Ada"), await createBot("Ben"), await createBot("Cy")];
    const room = await createRoom([ada, ben, cy], ada);
    expect((await send(room.id, "@ben what do you think?")).status).toBe(200);
    await expectTurns(1);
    const [turn] = engine.turns;
    expect(turn?.botId).toBe(ben.id);
    expect(turn?.prompt).toContain("Owner: @ben what do you think?");
    expect(turn?.prompt).toContain("reply with exactly NO_RESPONSE");
    turn?.finish(done("I think it works."));
    await vi.waitFor(() => expect(roomMessages(room)).toHaveLength(2));
    const [asked, answered] = roomMessages(room);
    expect(answered).toMatchObject({ botId: ben.id, chainId: asked?.chainId, hop: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(engine.turns).toHaveLength(1);
    const wakes = query("SELECT bot_id AS botId, chain_id AS chainId, hop, depth FROM wakes");
    expect(wakes).toEqual([{ botId: ben.id, chainId: asked?.chainId, hop: 0, depth: 0 }]);
    expect(store.state().runs.filter(({ botId }) => botId !== ben.id)).toEqual([]);
  });

  it("asks the human instead of guessing, and stores nothing", async () => {
    const { createBot, createRoom, send, roomMessages } = await boot();
    const [ada, ada2] = [await createBot("Ada"), await createBot("Ada")];
    const room = await createRoom([ada, ada2]);
    const unaddressed = await send(room.id, "anyone?");
    expect(unaddressed.status).toBe(409);
    expect(await unaddressed.json()).toEqual({ code: "no_bot_addressed" });
    const ambiguous = await send(room.id, "@ada hi");
    expect(await ambiguous.json()).toEqual({ code: "ambiguous_mention" });
    expect(roomMessages(room)).toEqual([]);
    expect(query("SELECT id FROM wakes")).toEqual([]);
  });

  it("refuses a message whose mentions are over the cap", async () => {
    const { createBot, createRoom, send, roomMessages } = await boot();
    const [ada, ben] = [await createBot("Ada"), await createBot("Ben")];
    const room = await createRoom([ada, ben]);
    verdicts.mention = ({ mentions }) =>
      mentions > 1 ? { verdict: "refuse", reason: "mentions" } : allow();
    expect(await (await send(room.id, "@ada @ben go")).json()).toEqual({ code: "mention_limit" });
    expect(checks.mention).toMatchObject([
      { chain: null, mentions: 1 },
      { chain: null, mentions: 2 },
    ]);
    expect(roomMessages(room)).toEqual([]);
  });

  it("runs mentioned bots in order, so the later one sees the earlier reply", async () => {
    const { createBot, createRoom, send, engine, expectTurns } = await boot();
    const [ada, ben, cy] = [await createBot("Ada"), await createBot("Ben"), await createBot("Cy")];
    const room = await createRoom([ada, ben, cy]);
    await send(room.id, "@cy then @ada, please");
    await expectTurns(1);
    expect(engine.turns[0]?.botId).toBe(cy.id);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(engine.turns).toHaveLength(1);
    engine.turns[0]?.finish(done("Cy's take."));
    await expectTurns(2);
    expect(engine.turns[1]?.botId).toBe(ada.id);
    expect(engine.turns[1]?.prompt).toContain("Cy: Cy's take.");
  });

  it("lets a bot's mention wake another one hop further along the chain", async () => {
    const { createBot, createRoom, send, engine, expectTurns, roomMessages } = await boot();
    const [ada, ben] = [await createBot("Ada"), await createBot("Ben")];
    const room = await createRoom([ada, ben], ada);
    await send(room.id, "plan it");
    await expectTurns(1);
    engine.turns[0]?.finish(done("@ben can you check this?"));
    await expectTurns(2);
    expect(engine.turns[1]?.botId).toBe(ben.id);
    expect(checks.mention.at(-1)).toMatchObject({ chain: { hop: 0, depth: 0 }, mentions: 1 });
    const chainId = roomMessages(room)[0]?.chainId;
    expect(query("SELECT hop, source FROM wakes WHERE bot_id = '" + ben.id + "'")).toEqual([
      { hop: 1, source: "mention" },
    ]);
    engine.turns[1]?.finish(done("Checked."));
    await vi.waitFor(() => expect(roomMessages(room)).toHaveLength(3));
    expect(roomMessages(room)[2]).toMatchObject({ botId: ben.id, chainId, hop: 1 });
    expect(query("SELECT bot_posts AS posts FROM room_rounds")).toEqual([{ posts: 1 }]);
  });

  it("stops two bots mentioning each other at hop 2", async () => {
    real.on = true;
    const { createBot, createRoom, send, engine, expectTurns, roomMessages } = await boot();
    const [ada, ben] = [await createBot("Ada"), await createBot("Ben")];
    const room = await createRoom([ada, ben], ada);
    await send(room.id, "plan it");
    await expectTurns(1);
    engine.turns[0]?.finish(done("@ben your turn"));
    await expectTurns(2);
    engine.turns[1]?.finish(done("@ada your turn"));
    await expectTurns(3);
    engine.turns[2]?.finish(done("@ben your turn"));
    await vi.waitFor(() => expect(roomMessages(room)).toHaveLength(4));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(engine.turns.map(({ botId }) => botId)).toEqual([ada.id, ben.id, ada.id]);
    expect(roomMessages(room).map(({ hop }) => hop)).toEqual([0, 0, 1, 2]);
    expect(query("SELECT hop FROM wakes ORDER BY rowid")).toEqual([
      { hop: 0 },
      { hop: 1 },
      { hop: 2 },
    ]);
  });

  it("drops a bot-prompted post once the round's budget is spent", async () => {
    const { createBot, createRoom, send, engine, expectTurns, roomMessages } = await boot();
    const [ada, ben] = [await createBot("Ada"), await createBot("Ben")];
    const room = await createRoom([ada, ben], ada);
    await send(room.id, "plan it");
    await expectTurns(1);
    verdicts.botPost = () => ({ verdict: "refuse", reason: "post_budget" });
    engine.turns[0]?.finish(done("@ben over to you"));
    await expectTurns(2);
    engine.turns[1]?.finish(done("Another bot post."));
    await vi.waitFor(() => expect(checks.botPost).toHaveLength(1));
    expect(roomMessages(room).map(({ body }) => body)).toEqual(["plan it", "@ben over to you"]);
  });

  it("posts nothing for an exact NO_RESPONSE, and posts anything else", async () => {
    const { createBot, createRoom, send, engine, expectTurns, roomMessages } = await boot();
    const ada = await createBot("Ada");
    const room = await createRoom([ada], ada);
    await send(room.id, "status?");
    await expectTurns(1);
    engine.turns[0]?.finish(done("  NO_RESPONSE\n"));
    await vi.waitFor(() =>
      expect(query("SELECT status FROM runs")).toEqual([{ status: "Completed" }]),
    );
    expect(roomMessages(room)).toHaveLength(1);
    await send(room.id, "and now?");
    await expectTurns(2);
    engine.turns[1]?.finish(done("NO_RESPONSE, sorry"));
    await vi.waitFor(() => expect(roomMessages(room)).toHaveLength(3));
  });
});

describe("a busy bot", () => {
  it("batches input that lands mid-turn into steers of the live turn", async () => {
    const { createBot, send, engine, expectTurns, store } = await boot();
    const ada = await createBot("Ada");
    await send(ada.roomId, "first");
    await expectTurns(1);
    const turn = engine.turns[0];
    await send(ada.roomId, "second");
    await vi.waitFor(() => expect(turn?.steers).toEqual(["second"]), { timeout: 3000 });
    await send(ada.roomId, "third");
    await send(ada.roomId, "fourth");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(turn?.steers).toEqual(["second"]);
    turn?.take(true);
    await vi.waitFor(() => expect(turn?.steers).toEqual(["second", "third\n\nfourth"]), {
      timeout: 3000,
    });
    turn?.take(true);
    turn?.finish(done("All of it."));
    await vi.waitFor(() =>
      expect(query("SELECT status FROM wakes")).toEqual([{ status: "done" }, { status: "done" }]),
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(engine.turns).toHaveLength(1);
    expect(store.state().messages.map(({ body }) => body)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
      "All of it.",
    ]);
  });

  it("holds a steer until no tool is in flight", async () => {
    const { createBot, send, engine, expectTurns } = await boot();
    const ada = await createBot("Ada");
    await send(ada.roomId, "first");
    await expectTurns(1);
    const turn = engine.turns[0];
    turn?.toolStart("t1");
    await send(ada.roomId, "second");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(turn?.steers).toEqual([]);
    turn?.toolEnd("t1");
    await vi.waitFor(() => expect(turn?.steers).toEqual(["second"]), { timeout: 3000 });
    expect(query("SELECT status FROM external_effects")).toEqual([{ status: "done" }]);
  });

  it("leaves refused steers for the follow-up turn", async () => {
    const { createBot, send, engine, expectTurns } = await boot();
    const ada = await createBot("Ada");
    await send(ada.roomId, "first");
    await expectTurns(1);
    await send(ada.roomId, "second");
    await vi.waitFor(() => expect(engine.turns[0]?.steers).toEqual(["second"]), { timeout: 3000 });
    engine.turns[0]?.take(false);
    engine.turns[0]?.finish(done("First only."));
    await expectTurns(2);
    expect(engine.turns[1]?.prompt).toBe("second");
  });
});

describe("room settings", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1200));

  it("runs everyone_optional members one at a time, so the second sees the first's reply, and posts nothing for NO_RESPONSE", async () => {
    const { createBot, createRoom, command, send, engine, expectTurns, roomMessages } =
      await boot();
    const [ada, ben, cy] = [await createBot("Ada"), await createBot("Ben"), await createBot("Cy")];
    const room = await createRoom([ada, ben, cy]);
    const updated = await command({
      type: "update-room",
      roomId: room.id,
      responderMode: "everyone_optional",
    });
    expect(await updated.json()).toMatchObject({ responderMode: "everyone_optional" });
    expect((await send(room.id, "thoughts?")).status).toBe(200);
    await expectTurns(1);
    expect(engine.turns[0]?.botId).toBe(ada.id);
    expect(engine.turns[0]?.prompt).toContain("Everyone here was asked.");
    await settle();
    expect(engine.turns).toHaveLength(1);
    engine.turns[0]?.finish(done("Ada's take."));
    await expectTurns(2);
    expect(engine.turns[1]?.botId).toBe(ben.id);
    expect(engine.turns[1]?.prompt).toContain("Ada: Ada's take.");
    engine.turns[1]?.finish(done("NO_RESPONSE"));
    await expectTurns(3);
    expect(engine.turns[2]?.botId).toBe(cy.id);
    engine.turns[2]?.finish(done("Cy adds one thing."));
    await vi.waitFor(() => expect(roomMessages(room)).toHaveLength(3));
    expect(roomMessages(room).map(({ body }) => body)).toEqual([
      "thoughts?",
      "Ada's take.",
      "Cy adds one thing.",
    ]);
  });

  it("wakes all 6 members of an everyone_optional room for one human message", async () => {
    real.on = true;
    const { createBot, createRoom, command, send } = await boot();
    const bots = [];
    for (const name of ["A", "B", "C", "D", "E", "F"]) {
      bots.push(await createBot(name));
    }
    const room = await createRoom(bots);
    await command({ type: "update-room", roomId: room.id, responderMode: "everyone_optional" });
    expect((await send(room.id, "thoughts?")).status).toBe(200);
    expect(checks.mention).toEqual([]);
    expect(query("SELECT bot_id AS botId FROM wakes ORDER BY rowid")).toEqual(
      bots.map(({ id }) => ({ botId: id })),
    );
  });

  it("refuses everyone_optional above 6 members, and a 7th member in such a room", async () => {
    const { createBot, createRoom, command, store } = await boot();
    const bots = [];
    for (const name of ["A", "B", "C", "D", "E", "F", "G"]) {
      bots.push(await createBot(name));
    }
    const [seventh] = bots.splice(6);
    const big = await createRoom([...bots, seventh as Bot]);
    const refused = await command({
      type: "update-room",
      roomId: big.id,
      responderMode: "everyone_optional",
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ code: "too_many_members" });
    expect(store.rooms.getRoom(big.id)?.responderMode).toBe("mentions");
    const six = await createRoom(bots);
    await command({ type: "update-room", roomId: six.id, responderMode: "everyone_optional" });
    const added = await command({
      type: "add-room-member",
      roomId: six.id,
      botId: seventh?.id ?? "",
    });
    expect(added.status).toBe(409);
    expect(await added.json()).toEqual({ code: "too_many_members" });
    expect(store.rooms.getRoom(six.id)?.members).toHaveLength(6);
  });

  it("refuses lead mode without a member lead and default mode without a default", async () => {
    const { createBot, createRoom, command } = await boot();
    const [ada, ben, cy] = [await createBot("Ada"), await createBot("Ben"), await createBot("Cy")];
    const room = await createRoom([ada, ben]);
    const lead = (leadBotId: string | null) =>
      command({ type: "update-room", roomId: room.id, responderMode: "lead", leadBotId });
    expect(await (await lead(cy.id)).json()).toEqual({ code: "not_member" });
    expect(await (await lead(null)).json()).toEqual({ code: "not_member" });
    const noDefault = await command({
      type: "update-room",
      roomId: room.id,
      responderMode: "default",
    });
    expect(noDefault.status).toBe(400);
    expect(await noDefault.json()).toEqual({ code: "default_bot_required" });
    const withDefault = await command({
      type: "update-room",
      roomId: room.id,
      defaultBotId: ada.id,
      responderMode: "default",
    });
    expect(await withDefault.json()).toMatchObject({
      responderMode: "default",
      defaultBotId: ada.id,
    });
  });

  it("clears the lead when it leaves the room", async () => {
    const { createBot, createRoom, command, send, engine, expectTurns } = await boot();
    const [ada, ben] = [await createBot("Ada"), await createBot("Ben")];
    const room = await createRoom([ada, ben], ada);
    await command({
      type: "update-room",
      roomId: room.id,
      responderMode: "lead",
      leadBotId: ben.id,
    });
    const left = await command({ type: "remove-room-member", roomId: room.id, botId: ben.id });
    expect(await left.json()).toMatchObject({ responderMode: "lead", leadBotId: null });
    await send(room.id, "go");
    await expectTurns(1);
    expect(engine.turns[0]?.botId).toBe(ada.id);
  });

  it("puts the owner's bulletin at the top of a member's room prompt", async () => {
    const { createBot, createRoom, command, send, engine, expectTurns } = await boot();
    const ada = await createBot("Ada");
    const room = await createRoom([ada], ada);
    await command({ type: "update-room", roomId: room.id, bulletin: "Ship by Friday." });
    await send(room.id, "status?");
    await expectTurns(1);
    expect(engine.turns[0]?.prompt).toMatch(
      /^\[Room bulletin from the owner\]\nShip by Friday\.\n\[End of bulletin\]\n\n\[New messages/,
    );
  });

  it("holds a room to its own post budget", async () => {
    real.on = true;
    const { createBot, createRoom, command, send, engine, expectTurns, roomMessages, store } =
      await boot();
    const [ada, ben] = [await createBot("Ada"), await createBot("Ben")];
    const strict = await createRoom([ada, ben], ada);
    const loose = await createRoom([ada, ben], ada);
    const set = await command({ type: "update-room", roomId: strict.id, limits: { posts: 1 } });
    expect(await set.json()).toMatchObject({ limits: { posts: 1 } });
    // Hop 0 posts always; hop 1 spends the first post; hop 2 needs a second.
    const exchange = async (room: Room, first: number) => {
      await send(room.id, "plan it");
      await expectTurns(first + 1);
      engine.turns[first]?.finish(done("@ben over to you"));
      await expectTurns(first + 2);
      engine.turns[first + 1]?.finish(done("@ada back to you"));
      await expectTurns(first + 3);
      engine.turns[first + 2]?.finish(done("@ben once more"));
      await vi.waitFor(() =>
        expect(store.state().runs.filter(({ status }) => status === "Running")).toEqual([]),
      );
    };
    await exchange(strict, 0);
    expect(roomMessages(strict).map(({ hop }) => hop)).toEqual([0, 0, 1]);
    await exchange(loose, 3);
    expect(roomMessages(loose).map(({ hop }) => hop)).toEqual([0, 0, 1, 2]);
  });
});
