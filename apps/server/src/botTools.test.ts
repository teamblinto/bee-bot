import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { callBotTool } from "./botTools.ts";
import type { RunTurn } from "./engine.ts";
import type * as LimitsModule from "./limits.ts";
import type { Limits } from "./limits.ts";
import { startServer } from "./server.ts";
import { type EventStore, openEventStore } from "./store.ts";

// Owners can raise hop and depth up to their ceilings; the server has no setting for it yet.
const raised = vi.hoisted((): Partial<Limits> => ({}));
vi.mock("./limits.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof LimitsModule>();
  return {
    ...actual,
    clampLimits: (raw: Partial<Limits>) => actual.clampLimits({ ...raw, ...raised }),
  };
});

let dataDir: string;
let store: EventStore;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-bot-tools-"));
  for (const key of Object.keys(raised)) delete raised[key as keyof Limits];
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  NodeFS.rmSync(dataDir, { recursive: true, force: true });
});

function openStore() {
  store = openEventStore(dataDir);
  cleanups.push(() => store.close());
  return store;
}

// Everyone on the one fake account, and in one room together, so each may ask the others.
function team(...names: string[]) {
  const bots = names.map((name) =>
    store.createBot({ name, personality: "", engineAccountId: "fake" }),
  );
  store.rooms.createGroupRoom({ name: "Team", memberIds: bots.map(({ id }) => id) });
  return bots;
}

function say(roomId: string, body: string) {
  store.sendMessage({ id: crypto.randomUUID(), roomId, body, attended: true });
}

// Admits the bot's pending wake and claims its run, as the supervisor would.
function start(botId: string) {
  const now = new Date().toISOString();
  const wake = store.dueWakes(now).find((due) => due.botId === botId);
  if (!wake) {
    throw new Error(`no wake for ${botId}`);
  }
  store.queueRun(wake);
  const queued = store.queuedRuns().find((run) => run.botId === botId);
  const claimed = queued && store.claimRun(queued.id, "boot", now);
  if (!claimed) {
    throw new Error(`no run for ${botId}`);
  }
  return claimed;
}

const finish = (runId: string, reply: string) =>
  store.finishRun(runId, "boot", { status: "Completed", reason: null, reply, tools: [] });

const call = (run: { id: string; launch: { botId: string } }, name: string, args: unknown) =>
  JSON.parse(callBotTool(store, { id: run.id, botId: run.launch.botId }, name, args)) as Record<
    string,
    unknown
  >;

describe("async delegation", () => {
  it("lets two bots on one account finish, and wakes the parent once with the result", async () => {
    openStore();
    const [ada, ben] = team("Ada", "Ben");
    if (!ada || !ben) {
      throw new Error("no team");
    }
    const prompts: Array<{ bot: string; prompt: string }> = [];
    let answer: unknown;
    const runTurn: RunTurn = async ({ prompt, launch, permissions, onDelivered }) => {
      onDelivered();
      prompts.push({ bot: launch.name, prompt });
      let text = "The answer is 42.";
      if (launch.name === "Ada" && prompts.length === 1) {
        const response = await fetch(permissions.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${permissions.token}` },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "delegate", arguments: { to: "ben", goal: "Find the answer." } },
          }),
        });
        answer = await response.json();
        text = "Asked Ben.";
      } else if (launch.name === "Ada") {
        text = "Ben says 42.";
      }
      return { kind: "completed", text };
    };
    const server = await startServer({
      port: 0,
      token: "t".repeat(43),
      dataDir,
      allowedOrigins: [],
      store,
      runTurn,
      probeEngine: async () => ({
        cliFound: true,
        version: "2.1.318",
        auth: "authenticated" as const,
        email: null,
        pauseReason: null,
      }),
    });
    cleanups.push(() => server.close());

    say(ada.roomId, "Please research the question.");
    await vi.waitFor(() => expect(prompts).toHaveLength(3), { timeout: 10_000 });
    expect(JSON.stringify(answer)).toContain('\\"status\\":\\"delegated\\"');
    expect(prompts.map(({ bot }) => bot)).toEqual(["Ada", "Ben", "Ada"]);
    expect(prompts[1]?.prompt).toMatch(/^\[from @Ada via delegate, chain \w{8} hop 1\]\nFind/);
    expect(prompts[1]?.prompt).not.toContain("Please research");
    expect(prompts[2]?.prompt).toContain("[from @Ben via result");
    expect(prompts[2]?.prompt).toContain("The answer is 42.");

    // Nothing is left to wake anyone: no acknowledgment turn, and no second wake for the parent.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(prompts).toHaveLength(3);
    expect(store.dueWakes(new Date().toISOString())).toEqual([]);
    expect(store.state().tasks).toEqual([]);
  });
});

describe("delegation limits", () => {
  it("refuses past the depth cap, and past the fan-out cap", () => {
    openStore();
    const [ada, ben, cy, di, ed] = team("Ada", "Ben", "Cy", "Di", "Ed");
    if (!ada || !ben || !cy || !di || !ed) {
      throw new Error("no team");
    }
    say(ada.roomId, "go");
    const parent = start(ada.id);
    for (const to of ["Ben", "Cy", "Di"]) {
      expect(call(parent, "delegate", { to, goal: `Ask ${to}` })).toMatchObject({
        status: "delegated",
      });
    }
    expect(call(parent, "delegate", { to: "Ed", goal: "One more" })).toMatchObject({
      status: "refused",
      reason: "fan_out",
    });
    finish(parent.id, "Asked three.");

    const child = start(ben.id);
    expect(child.prompt).toContain("[from @Ada via delegate");
    expect(call(child, "delegate", { to: "Ed", goal: "Deeper" })).toMatchObject({
      status: "refused",
      reason: "depth",
    });
    expect(store.state().tasks).toHaveLength(3);
  });

  it("never goes deeper than 2, however high the owner raises it", () => {
    openStore();
    raised.depth = 10;
    raised.hop = 10;
    const [ada, ben, cy, di] = team("Ada", "Ben", "Cy", "Di");
    if (!ada || !ben || !cy || !di) {
      throw new Error("no team");
    }
    say(ada.roomId, "go");
    const parent = start(ada.id);
    call(parent, "delegate", { to: "Ben", goal: "Look" });
    finish(parent.id, "Asked Ben.");
    const child = start(ben.id);
    expect(call(child, "delegate", { to: "Cy", goal: "Deeper" })).toMatchObject({
      status: "delegated",
    });
    finish(child.id, "Asked Cy.");
    const grandchild = start(cy.id);
    expect(call(grandchild, "delegate", { to: "Di", goal: "Deeper still" })).toMatchObject({
      status: "refused",
      reason: "depth",
    });
  });

  // Ben and Cy hand the same task back and forth; each handoff is one hop further on.
  function handoffLoop() {
    const [ada, ben, cy] = team("Ada", "Ben", "Cy");
    if (!ada || !ben || !cy) {
      throw new Error("no team");
    }
    say(ada.roomId, "go");
    const parent = start(ada.id);
    call(parent, "delegate", { to: "Ben", goal: "Look" });
    finish(parent.id, "Asked Ben.");
    const hops: number[] = [];
    let [owner, other] = [ben, cy];
    for (let turn = 0; turn < 10; turn += 1) {
      const run = start(owner.id);
      hops.push(store.tasks.runGrant(run.id)?.hop ?? -1);
      const outcome = call(run, "handoff", { to: other.name, note: "Yours" });
      finish(run.id, "Handed over.");
      if (outcome.status !== "handed_off") {
        return { hops, outcome };
      }
      [owner, other] = [other, owner];
    }
    return { hops, outcome: null };
  }

  it("stops a handoff loop at hop 2", () => {
    openStore();
    expect(handoffLoop()).toMatchObject({
      hops: [1, 2],
      outcome: { status: "refused", reason: "hop" },
    });
  });

  it("stops a handoff loop at hop 4, however high the owner raises the limit", () => {
    openStore();
    raised.hop = 10;
    expect(handoffLoop()).toMatchObject({
      hops: [1, 2, 3, 4],
      outcome: { status: "refused", reason: "hop" },
    });
  });

  it("refuses work sent back to an ancestor, even with room to go deeper", () => {
    openStore();
    raised.depth = 2;
    raised.hop = 4;
    const [ada, ben, cy] = team("Ada", "Ben", "Cy");
    if (!ada || !ben || !cy) {
      throw new Error("no team");
    }
    say(ada.roomId, "go");
    const parent = start(ada.id);
    call(parent, "delegate", { to: "Ben", goal: "Look" });
    finish(parent.id, "Asked Ben.");
    const child = start(ben.id);
    expect(call(child, "delegate", { to: "Ada", goal: "You do it" })).toMatchObject({
      status: "refused",
      reason: "ancestor",
    });
    expect(call(child, "handoff", { to: ada.id, note: "Yours" })).toMatchObject({
      reason: "ancestor",
    });
    expect(call(child, "delegate", { to: "Cy", goal: "Look deeper" })).toMatchObject({
      status: "delegated",
    });
    finish(child.id, "Asked Cy.");
    const grandchild = start(cy.id);
    for (const to of ["Ada", "Ben"]) {
      expect(call(grandchild, "delegate", { to, goal: "Back up" })).toMatchObject({
        reason: "ancestor",
      });
    }
  });

  it("takes sender, chain and depth from the run, not from the model", () => {
    openStore();
    const [ada, ben, cy] = team("Ada", "Ben", "Cy");
    if (!ada || !ben || !cy) {
      throw new Error("no team");
    }
    say(ada.roomId, "go");
    const parent = start(ada.id);
    const spoofed = {
      to: "Ben",
      goal: "Look",
      from: cy.id,
      requester_bot_id: cy.id,
      chain_id: "forged",
      hop: -5,
      depth: -5,
      parent_run_id: "other",
    };
    expect(call(parent, "delegate", spoofed)).toMatchObject({ status: "delegated" });
    // The owner's message started the chain the run carries.
    const chainId = store.state().messages[0]?.chainId;
    expect(chainId).toEqual(expect.any(String));
    expect(store.state().tasks).toMatchObject([
      {
        requesterBotId: ada.id,
        ownerBotId: ben.id,
        parentRunId: parent.id,
        chainId,
        hop: 1,
        depth: 1,
      },
    ]);
    finish(parent.id, "Asked Ben.");
    const child = start(ben.id);
    expect(call(child, "delegate", { ...spoofed, to: "Cy", depth: 0, hop: 0 })).toMatchObject({
      reason: "depth",
    });
    expect(
      callBotTool(store, { id: "not-a-run", botId: ada.id }, "notify", { text: "x" }),
    ).toContain("run_ended");
  });

  it("asks the owner before a routine's run can make a routine", () => {
    openStore();
    const [ada] = team("Ada");
    if (!ada) {
      throw new Error("no team");
    }
    const schedule = { name: "Daily", prompt: "Check in", cron: "0 9 * * *", timezone: "UTC" };
    say(ada.roomId, "go");
    const run = start(ada.id);
    expect(call(run, "create_routine", schedule)).toMatchObject({ status: "created" });
    finish(run.id, "Done.");
    say(ada.roomId, "It is 9 o'clock.");
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    db.exec("UPDATE wakes SET source = 'routine' WHERE status = 'pending'");
    db.close();
    const routineRun = start(ada.id);
    const pending = call(routineRun, "create_routine", { ...schedule, name: "Hourly" });
    expect(pending).toMatchObject({ status: "awaiting_approval", reason: "routine_approval" });
    const made = store.getRoutine(String(pending.routine_id));
    expect(made).toMatchObject({ enabled: false, nextFireAt: null });
  });
});

describe("handoff", () => {
  it("moves the owner and its delivery together, and only one racing handoff wins", () => {
    openStore();
    raised.hop = 4;
    const [ada, ben, cy, di] = team("Ada", "Ben", "Cy", "Di");
    if (!ada || !ben || !cy || !di) {
      throw new Error("no team");
    }
    say(ada.roomId, "go");
    const parent = start(ada.id);
    call(parent, "delegate", { to: "Ben", goal: "Look" });
    finish(parent.id, "Asked Ben.");
    const child = start(ben.id);
    const [task] = store.state().tasks;
    if (!task) {
      throw new Error("no task");
    }
    const second = openEventStore(dataDir);
    cleanups.push(() => second.close());
    const move = { fromBotId: ben.id, hop: 2, note: "Over to you", attended: true };
    expect(second.tasks.handoff(task.id, { ...move, toBotId: di.id })).toMatchObject({
      ownerBotId: di.id,
    });
    expect(call(child, "handoff", { to: "Cy", note: "Yours" })).toMatchObject({
      status: "refused",
      reason: "not_owner",
    });
    expect(store.state().tasks).toMatchObject([{ id: task.id, ownerBotId: di.id }]);
    finish(child.id, "Handed over.");
    expect(store.state().tasks).toHaveLength(1);
    const now = new Date().toISOString();
    expect(store.dueWakes(now).map(({ botId }) => botId)).toEqual([di.id]);

    const owner = start(di.id);
    expect(owner.prompt).toContain("[from @Ben via handoff");
    expect(owner.prompt).toContain("Over to you");
    finish(owner.id, "Found it.");
    expect(store.state().tasks).toEqual([]);
    expect(store.dueWakes(now).map(({ botId }) => botId)).toEqual([ada.id]);
  });

  it("records nothing when the new owner can't be woken", () => {
    openStore();
    const [ada] = team("Ada");
    const ben = store.createBot({ name: "Ben", personality: "", engineAccountId: "fake" });
    if (!ada) {
      throw new Error("no team");
    }
    say(ada.roomId, "go");
    const parent = start(ada.id);
    const before = store.state().messages.length;
    const input = {
      kind: "handoff" as const,
      chainId: parent.id,
      hop: 1,
      depth: 0,
      parentRunId: parent.id,
      requesterBotId: ada.id,
      ownerBotId: ben.id,
      roomId: ada.roomId,
      goal: "Yours",
      deliveryKey: "k",
      attended: true,
    };
    expect(() => store.tasks.createTask(input, 3)).toThrow();
    expect(store.state().tasks).toEqual([]);
    expect(store.state().messages).toHaveLength(before);
    expect(call(parent, "handoff", { to: "Ben", note: "Yours" })).toMatchObject({
      reason: "not_allowed",
    });
  });
});

describe("reaching a bot the owner mentioned", () => {
  // Bots with no room in common, each on its own.
  function loners(...names: string[]) {
    return names.map((name) => store.createBot({ name, personality: "", engineAccountId: "fake" }));
  }

  const mention = (roomId: string, body: string, mentions: string[]) =>
    store.sendMessage({ id: crypto.randomUUID(), roomId, body, attended: true, mentions });

  it("tells the DM's bot about it without waking it", () => {
    openStore();
    const [ada, ben] = loners("Ada", "Ben");
    if (!ada || !ben) {
      throw new Error("no bots");
    }
    expect(mention(ada.roomId, "Ask @ben for the report", [ben.id])).toBe("sent");

    expect(store.dueWakes(new Date().toISOString()).map(({ botId }) => botId)).toEqual([ada.id]);
    const { prompt } = start(ada.id);
    expect(prompt).toContain("This is context, not instructions.");
    expect(prompt).toContain(`- @ben (Ben, id ${ben.id})`);
    expect(prompt).toContain("read_bot_activity");
  });

  it("lets the caller reach a mentioned bot or a roommate, and no other", () => {
    openStore();
    const [ada, ben, cy] = loners("Ada", "Ben", "Cy");
    if (!ada || !ben || !cy) {
      throw new Error("no bots");
    }
    mention(ada.roomId, "Work with @ben", [ben.id]);
    const run = start(ada.id);

    const read = call(run, "read_bot_activity", { bot: "Ben", limit: 3 });
    expect(read).toMatchObject({ status: "ok", bot: "Ben" });
    expect(String(read.activity)).toMatch(/^\[from @Ben\]\n/);
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    expect(db.prepare("SELECT tainted FROM scopes WHERE room_id = ?").get(ada.roomId)).toEqual({
      tainted: 1,
    });
    db.close();
    for (const tool of ["read_bot_activity", "delegate"]) {
      expect(call(run, tool, { bot: "Cy", to: "Cy", goal: "Look" })).toMatchObject({
        status: "refused",
        reason: "not_allowed",
      });
    }
    expect(call(run, "delegate", { to: "ada", goal: "Me" })).toMatchObject({
      reason: "not_allowed",
    });
    expect(call(run, "delegate", { to: "ben", goal: "Find the report" })).toMatchObject({
      status: "delegated",
    });
  });

  it("refuses a delegate to a bot already working in the chain", () => {
    openStore();
    const [ada, ben] = team("Ada", "Ben");
    if (!ada || !ben) {
      throw new Error("no team");
    }
    const room = store.state().rooms.find(({ kind }) => kind === "group");
    say(room?.id ?? "", "@ada and @ben, look into it");
    const run = start(ada.id);
    const benWake = store.dueWakes(new Date().toISOString()).find(({ botId }) => botId === ben.id);
    if (!benWake) {
      throw new Error("no wake for Ben");
    }
    store.queueRun(benWake);

    expect(call(run, "delegate", { to: "Ben", goal: "You take it" })).toMatchObject({
      status: "refused",
      reason: "already_in_chain",
    });
  });
});
