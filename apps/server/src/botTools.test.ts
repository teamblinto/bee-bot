import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Duplex, Readable, Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { attachmentsDir, maxAttachmentBytes } from "./attachments.ts";
import { callBotTool, shareFile } from "./botTools.ts";
import type { RunTurn } from "./engine.ts";
import type * as LimitsModule from "./limits.ts";
import type { Limits } from "./limits.ts";
import { startServer } from "./server.ts";
import { type EventStore, openEventStore } from "./store.ts";

// Overrides whatever limits the owner stored.
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
  it("refuses past the hop cap, and past the fan-out cap", () => {
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
      status: "delegated",
    });
    finish(child.id, "Asked Ed.");
    // Ed sits at hop 2 and depth 2; the hop check runs first.
    const grandchild = start(ed.id);
    expect(call(grandchild, "delegate", { to: "Cy", goal: "Deeper still" })).toMatchObject({
      status: "refused",
      reason: "hop",
    });
    expect(store.state().tasks).toHaveLength(4);
  });

  it("settles a depth-2 chain bottom-up at the default limits", () => {
    openStore();
    const [ada, ben, cy] = team("Ada", "Ben", "Cy");
    if (!ada || !ben || !cy) {
      throw new Error("no team");
    }
    say(ada.roomId, "go");
    const parent = start(ada.id);
    call(parent, "delegate", { to: "Ben", goal: "Find B" });
    finish(parent.id, "Asked Ben.");
    const child = start(ben.id);
    expect(call(child, "delegate", { to: "Cy", goal: "Find C" })).toMatchObject({
      status: "delegated",
    });
    finish(child.id, "Asked Cy.");
    finish(start(cy.id).id, "C is 3");
    const benAgain = start(ben.id);
    expect(benAgain.prompt).toContain("[from @Cy via result");
    expect(benAgain.prompt).toContain("C is 3");
    finish(benAgain.id, "B: 3");
    const adaAgain = start(ada.id);
    expect(adaAgain.prompt).toContain("[from @Ben via result");
    expect(adaAgain.prompt).toContain("B: 3");
    expect(store.state().tasks).toEqual([]);
  });

  it("never goes deeper than 4, however high the owner raises it", () => {
    openStore();
    raised.depth = 10;
    raised.hop = 10;
    const bots = team("Ada", "Ben", "Cy", "Di", "Ed", "Fi");
    const [ada] = bots;
    if (!ada) {
      throw new Error("no team");
    }
    say(ada.roomId, "go");
    for (const [index, bot] of bots.slice(0, 4).entries()) {
      const run = start(bot.id);
      expect(call(run, "delegate", { to: bots[index + 1]?.name, goal: "Deeper" })).toMatchObject({
        status: "delegated",
      });
      finish(run.id, "Asked.");
    }
    // Hop and depth rise together, and hop is checked first.
    const deepest = start(bots[4]?.id ?? "");
    expect(call(deepest, "delegate", { to: "Fi", goal: "Deeper still" })).toMatchObject({
      status: "refused",
      reason: "hop",
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
    raised.depth = 1;
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

  it("records parent, root and origin from the run, not from the model", () => {
    openStore();
    const [ada, ben, cy] = team("Ada", "Ben", "Cy");
    if (!ada || !ben || !cy) {
      throw new Error("no team");
    }
    say(ada.roomId, "go");
    const parent = start(ada.id);
    const first = call(parent, "delegate", { to: "Ben", goal: "Find B" });
    const t1 = store.tasks.getTask(String(first.task_id));
    expect(t1).toMatchObject({ parentTaskId: null, rootTaskId: t1?.id, origin: "human" });
    finish(parent.id, "Asked Ben.");
    const child = start(ben.id);
    const spoofed = { parent_task_id: "forged", root_task_id: "forged", origin: "board" };
    const second = call(child, "delegate", {
      ...spoofed,
      to: "Cy",
      goal: "Find C",
      done_when: "C is known",
    });
    expect(store.tasks.getTask(String(second.task_id))).toMatchObject({
      parentTaskId: t1?.id,
      rootTaskId: t1?.rootTaskId,
      origin: "human",
      doneWhen: "C is known",
    });
    finish(child.id, "Asked Cy.");
    expect(start(cy.id).prompt).toContain("Find C\n\nDone when: C is known");
  });

  it("refuses a blocker the caller has nothing to do with", () => {
    openStore();
    const { ada, cy, task_id } = delegated();
    say(cy.roomId, "go");
    const other = start(cy.id);
    for (const blocked_by of [[task_id], ["missing"]]) {
      expect(call(other, "delegate", { to: "Ada", goal: "Wait", blocked_by })).toMatchObject({
        status: "refused",
        reason: "unknown_blocker",
      });
    }
    say(ada.roomId, "and?");
    const parent = start(ada.id);
    expect(
      call(parent, "delegate", { to: "Cy", goal: "After Ben", blocked_by: [task_id] }),
    ).toMatchObject({ status: "delegated", queued: true });
    expect(store.state().tasks).toHaveLength(2);
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
    const move = { fromBotId: ben.id, hop: 2, note: "Over to you" };
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

describe("send_message routing", () => {
  const groupId = () => store.state().rooms.find(({ kind }) => kind === "group")?.id ?? "";

  it("wakes a roommate it names in a group room, and no one from a DM", () => {
    openStore();
    const [ada, ben] = team("Ada", "Ben");
    if (!ada || !ben) {
      throw new Error("no team");
    }
    say(ada.roomId, "go");
    const run = start(ada.id);

    expect(
      call(run, "send_message", { room_id: groupId(), text: "@Ben please check" }),
    ).toMatchObject({ status: "sent" });
    const benWakes = () =>
      store.dueWakes(new Date().toISOString()).filter(({ botId }) => botId === ben.id);
    const [wake] = benWakes();
    expect(benWakes()).toHaveLength(1);
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    expect(db.prepare("SELECT source FROM wakes WHERE id = ?").get(wake?.id ?? "")).toEqual({
      source: "mention",
    });
    db.close();

    expect(call(run, "send_message", { text: "@Ben hi" })).toMatchObject({ status: "sent" });
    expect(benWakes()).toHaveLength(1);
  });

  it("spends the room's post budget like a final reply", () => {
    openStore();
    const [ada, ben] = team("Ada", "Ben");
    if (!ada || !ben) {
      throw new Error("no team");
    }
    const group = groupId();
    say(group, "@Ada start");
    const adaRun = start(ada.id);
    expect(call(adaRun, "send_message", { text: "@Ben go" })).toMatchObject({ status: "sent" });
    finish(adaRun.id, "Done.");

    const benRun = start(ben.id);
    for (const text of ["One.", "Two."]) {
      expect(call(benRun, "send_message", { room_id: group, text })).toMatchObject({
        status: "sent",
      });
    }
    expect(call(benRun, "send_message", { room_id: group, text: "Three." })).toMatchObject({
      status: "refused",
      reason: "post_budget",
    });
  });
});

// Ada delegates to Ben, and Ben is free, so the task opens at once.
function delegated() {
  const [ada, ben, cy] = team("Ada", "Ben", "Cy");
  if (!ada || !ben || !cy) {
    throw new Error("no team");
  }
  store.setAccountConcurrency("fake", 2);
  say(ada.roomId, "go");
  const parent = start(ada.id);
  const { task_id } = call(parent, "delegate", { to: "Ben", goal: "Find the year." });
  finish(parent.id, "Asked Ben.");
  const status = () => store.tasks.getTask(String(task_id))?.status;
  return { ada, ben, cy, task_id, status };
}

describe("follow_up", () => {
  it("an owner's question waits on the requester, and the answer reopens the task", () => {
    openStore();
    const { ada, ben, task_id, status } = delegated();
    const child = start(ben.id);
    expect(
      call(child, "follow_up", { task_id, kind: "ask", message: "Which year?" }),
    ).toMatchObject({ status: "sent" });
    expect(status()).toBe("needs_input");
    finish(child.id, "Asked.");
    expect(status()).toBe("needs_input");

    const parent = start(ada.id);
    expect(parent.prompt).toContain("[from @Ben via follow_up");
    expect(parent.prompt).toContain("Which year?");
    expect(call(parent, "follow_up", { task_id, kind: "answer", message: "2024" })).toMatchObject({
      status: "sent",
    });
    expect(status()).toBe("open");
    finish(parent.id, "Answered.");
    expect(status()).toBe("open");
    expect(start(ben.id).prompt).toContain("2024");
  });

  it("rework reopens a done task, and cancel drops a queued one", () => {
    openStore();
    const { ada, ben, cy, task_id, status } = delegated();
    finish(start(ben.id).id, "v1");
    expect(status()).toBe("done");

    const parent = start(ada.id);
    expect(
      call(parent, "follow_up", { task_id, kind: "rework", message: "Shorter" }),
    ).toMatchObject({ status: "sent", task_status: "open" });
    expect(status()).toBe("open");
    finish(parent.id, "Sent back.");
    const child = start(ben.id);
    expect(child.prompt).toContain("Shorter");

    say(cy.roomId, "go");
    const other = start(cy.id);
    const second = call(other, "delegate", { to: "Ben", goal: "Another thing." });
    expect(second).toMatchObject({ status: "delegated", queued: true });
    expect(
      call(other, "follow_up", { task_id: second.task_id, kind: "cancel", message: "Never mind." }),
    ).toEqual({ status: "sent", task_id: second.task_id, task_status: "cancelled" });
    finish(other.id, "Dropped it.");

    finish(child.id, "v2");
    expect(store.tasks.activeTasks().filter((task) => task.ownerBotId === ben.id)).toEqual([]);
  });

  it("refuses a bot that is neither side, and a kind that doesn't fit the status", () => {
    openStore();
    const { ada, cy, task_id } = delegated();
    say(cy.roomId, "go");
    const other = start(cy.id);
    expect(call(other, "follow_up", { task_id, kind: "ask", message: "Hi?" })).toMatchObject({
      status: "refused",
      reason: "not_party",
    });
    say(ada.roomId, "and?");
    const parent = start(ada.id);
    expect(call(parent, "follow_up", { task_id, kind: "answer", message: "2024" })).toMatchObject({
      status: "refused",
      reason: "wrong_state",
    });
  });
});

describe("task_status", () => {
  it("shows the caller's tasks only", () => {
    openStore();
    const { ben, cy } = delegated();
    const { tasks } = call(start(ben.id), "task_status", {});
    expect(tasks).toHaveLength(1);
    expect(tasks).toMatchObject([{ status: "open", from: "Ada", to: "Ben" }]);
    say(cy.roomId, "go");
    expect(call(start(cy.id), "task_status", {})).toMatchObject({ status: "ok", tasks: [] });
  });
});

describe("share_file", () => {
  const box = (chunks: Iterable<Buffer>, code = 0) =>
    vi.fn(async () => ({
      stream: Duplex.from({
        readable: Readable.from(chunks),
        writable: new Writable({ write: (_chunk, _encoding, done) => done() }),
      }),
      exited: Promise.resolve(code),
    }));

  function setUp() {
    openStore();
    const [ada] = team("Ada");
    if (!ada) {
      throw new Error("no bot");
    }
    say(ada.roomId, "send me the report");
    const run = start(ada.id);
    const attached: string[] = [];
    const share = (args: unknown, read: ReturnType<typeof box>) =>
      shareFile(store, run, args, {
        dataDir,
        workdir: "/work",
        read,
        attach: (_runId, id) => attached.push(id) > 0,
      }).then((text) => JSON.parse(text) as Record<string, unknown>);
    return { ada, run, attached, share };
  }

  it("refuses a path outside the workspace without reading anything", async () => {
    const { share } = setUp();
    const read = box([Buffer.from("root:x:0:0")]);
    for (const path of ["../etc/passwd", "/etc/passwd", "/work/../etc/passwd", "/workshop/a"]) {
      expect(await share({ path }, read)).toMatchObject({ reason: "outside_workspace" });
    }
    expect(read).not.toHaveBeenCalled();
    // The box resolves links, and answers 3 for one that leads out.
    expect(await share({ path: "link" }, box([], 3))).toMatchObject({
      reason: "outside_workspace",
    });
  });

  it("refuses a file over the limit and leaves nothing behind", async () => {
    const { ada, attached, share } = setUp();
    const mib = Buffer.alloc(1024 * 1024);
    const chunks = Array.from({ length: maxAttachmentBytes / mib.length + 1 }, () => mib);
    expect(await share({ path: "big.bin" }, box(chunks))).toMatchObject({ reason: "too_large" });
    expect(attached).toEqual([]);
    expect(NodeFS.readdirSync(attachmentsDir(dataDir, ada.roomId))).toEqual([]);
  });

  it("refuses a program, and puts any other file on the reply as a download", async () => {
    const { ada, run, attached, share } = setUp();
    expect(await share({ path: "setup.exe" }, box([]))).toMatchObject({
      reason: "attachment_type",
    });
    expect(await share({ path: "out/report.html" }, box([Buffer.from("<b>hi</b>")]))).toEqual({
      status: "attached",
      name: "report.html",
      size: 9,
    });
    store.finishRun(run.id, "boot", {
      status: "Completed",
      reason: null,
      reply: "here it is",
      tools: [],
      attachmentIds: attached,
    });
    const reply = store.state().messages.find(({ author }) => author === "bot");
    expect(reply?.attachments).toEqual([
      { id: attached[0], name: "report.html", mime: "application/octet-stream", size: 9 },
    ]);
    expect(reply?.roomId).toBe(ada.roomId);
  });
});

describe("schedule_wakeup", () => {
  function solo() {
    openStore();
    const [ada] = team("Ada");
    if (!ada) {
      throw new Error("no team");
    }
    return ada;
  }

  it("schedules a once routine for in_minutes, and refuses both or neither of at and in_minutes", () => {
    const ada = solo();
    say(ada.roomId, "go");
    const run = start(ada.id);
    const before = Date.now();
    const result = call(run, "schedule_wakeup", { in_minutes: 30, note: "  Check the deploy " });
    expect(result).toMatchObject({ status: "scheduled" });
    const routine = store.getRoutine(String(result.routine_id));
    expect(routine).toMatchObject({
      kind: "once",
      enabled: true,
      name: "Wakeup: Check the deploy",
      prompt: "Check the deploy",
      fireAt: result.fire_at,
    });
    const delay = Date.parse(String(result.fire_at)) - before;
    expect(delay).toBeGreaterThanOrEqual(30 * 60_000);
    expect(delay).toBeLessThan(31 * 60_000);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    for (const args of [
      { note: "x" },
      { at, in_minutes: 5, note: "x" },
      { at: new Date(Date.now() + 10_000).toISOString(), note: "x" },
      { at: "tomorrow", note: "x" },
      { in_minutes: 43_201, note: "x" },
      { in_minutes: 5, note: "x", task_id: "someone-else" },
    ]) {
      expect(call(run, "schedule_wakeup", args)).toMatchObject({ status: "refused" });
    }
    expect(call(run, "schedule_wakeup", { at, note: "Later" })).toMatchObject({
      status: "scheduled",
      fire_at: at,
    });
    expect(store.pendingWakeups(ada.id)).toBe(2);
  });

  it("refuses an unattended tainted run with wake_approval and creates nothing", () => {
    const ada = solo();
    store.sendMessage({ id: crypto.randomUUID(), roomId: ada.roomId, body: "go", attended: false });
    const run = start(ada.id);
    store.markUntrusted(run.id);
    expect(call(run, "schedule_wakeup", { in_minutes: 5, note: "Again" })).toMatchObject({
      status: "refused",
      reason: "wake_approval",
    });
    expect(store.state().routines).toEqual([]);
  });

  it("refuses an 11th pending wakeup", () => {
    const ada = solo();
    say(ada.roomId, "go");
    const run = start(ada.id);
    for (let i = 0; i < 10; i++) {
      expect(call(run, "schedule_wakeup", { in_minutes: 5 + i, note: `n${i}` })).toMatchObject({
        status: "scheduled",
      });
    }
    expect(call(run, "schedule_wakeup", { in_minutes: 5, note: "one more" })).toMatchObject({
      status: "refused",
      reason: "too_many_wakeups",
    });
  });
});

describe("wait_until", () => {
  const waitFor = (
    run: { id: string; launch: { botId: string } },
    condition: Record<string, unknown>,
  ) => call(run, "wait_until", { condition, note: "Carry on", timeout_minutes: 30 });

  it("answers already_met for a finished task and refuses a task that isn't the caller's", () => {
    openStore();
    const { cy, ben, task_id } = delegated();
    const owner = start(ben.id);
    expect(waitFor(owner, { kind: "task_done", task_id })).toMatchObject({ status: "waiting" });
    store.tasks.finishTask(String(task_id), "done");
    expect(waitFor(owner, { kind: "task_done", task_id })).toEqual({
      status: "already_met",
      task_status: "done",
    });
    expect(store.waits.dueWaits(new Date(Date.now() + 60_000).toISOString())).toHaveLength(1);

    say(cy.roomId, "go");
    const stranger = start(cy.id);
    for (const condition of [
      { kind: "task_done", task_id },
      { kind: "task_done", task_id: "missing" },
    ]) {
      expect(waitFor(stranger, condition)).toMatchObject({
        status: "refused",
        reason: "not_your_task",
      });
    }
    expect(waitFor(stranger, { kind: "bot_idle", bot_id: "Cy" })).toMatchObject({
      reason: "not_allowed",
    });
  });

  it("refuses file_exists for a host bot and for a path that leaves the workspace", () => {
    openStore();
    const [ada] = team("Ada");
    if (!ada) {
      throw new Error("no team");
    }
    say(ada.roomId, "go");
    const run = start(ada.id);
    expect(waitFor(run, { kind: "file_exists", path: "out/report.pdf" })).toMatchObject({
      reason: "box_only",
    });
    expect(waitFor(run, { kind: "url_changes", url: "https://example.com/" })).toMatchObject({
      status: "waiting",
      note: expect.stringContaining("You don't run in a box"),
    });

    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    db.prepare("UPDATE bots SET boundary = 'box' WHERE id = ?").run(ada.id);
    db.close();
    for (const path of ["../secret", "/etc/passwd", "out/../../secret", ".."]) {
      expect(waitFor(run, { kind: "file_exists", path })).toMatchObject({
        reason: "outside_workspace",
      });
    }
    const made = waitFor(run, { kind: "file_exists", path: "./out//report.pdf" });
    expect(made).toMatchObject({ status: "waiting" });
    expect(String(made.note)).not.toContain("box");
    const [created] = store.waits
      .dueWaits(new Date(Date.now() + 60_000).toISOString())
      .filter(({ id }) => id === made.wait_id);
    expect(created?.condition).toEqual({ kind: "file_exists", path: "out/report.pdf" });
  });
});

describe("progress budgets", () => {
  const past = (minutes: number) => new Date(Date.UTC(2020, 0, 1) + minutes * 60_000).toISOString();
  function seed(sql: string, rows: unknown[][]) {
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    const statement = db.prepare(sql);
    for (const row of rows) statement.run(...(row as string[]));
    db.close();
  }
  // Every run so far started long ago, and the task just after, so seeded rows count after both.
  function backdated() {
    const { ada, ben, cy, task_id } = delegated();
    const owner = start(ben.id);
    seed("UPDATE runs SET created_at = ?", [[past(0)]]);
    seed("UPDATE tasks SET created_at = ? WHERE id = ?", [[past(1), String(task_id)]]);
    return { ada, ben, cy, task_id: String(task_id), owner };
  }
  const copyRun = (chained: boolean) =>
    `INSERT INTO runs (id, bot_id, scope_id, wake_id, engine_account_id, status, chain_id,
       task_id, created_at)
     SELECT ?1, bot_id, scope_id, wake_id, engine_account_id, 'Completed',
       ${chained ? "chain_id" : "NULL"}, task_id, ?3 FROM runs WHERE id = ?2`;

  it("refuses the 25th request since progress, and report_progress renews it", () => {
    openStore();
    const { ada, cy, task_id, owner } = backdated();
    seed(
      `INSERT INTO tasks (id, kind, chain_id, hop, depth, parent_run_id, requester_bot_id,
         owner_bot_id, room_id, goal, status, delivery_key, parent_task_id, root_task_id,
         created_at, updated_at)
       SELECT ?1, kind, chain_id, hop, depth, parent_run_id, requester_bot_id, owner_bot_id,
         room_id, goal, 'done', ?1, id, id, ?2, ?2 FROM tasks WHERE id = ?3`,
      Array.from({ length: 24 }, (_, i) => [`seed-${i}`, past(2 + i), task_id]),
    );
    expect(call(owner, "delegate", { to: "Cy", goal: "One more" })).toMatchObject({
      status: "refused",
      reason: "progress_budget",
    });

    say(cy.roomId, "go");
    const stranger = start(cy.id);
    for (const id of [task_id, "missing"]) {
      expect(call(stranger, "report_progress", { task_id: id, note: "Mine" })).toMatchObject({
        status: "refused",
        reason: "not_your_task",
      });
    }
    expect(call(owner, "report_progress", { task_id, note: "" })).toMatchObject({
      status: "refused",
    });
    expect(call(owner, "report_progress", { task_id, note: "Half done." })).toEqual({
      status: "recorded",
      task_id,
    });
    expect(store.tasks.getTask(task_id)?.progressAt).not.toBeNull();
    const posted = store.state().messages.filter(({ id }) => id.startsWith("progress:"));
    expect(posted).toMatchObject([{ roomId: ada.roomId, body: "Half done." }]);
    expect(store.dueWakes(new Date().toISOString()).filter((w) => w.botId === ada.id)).toEqual([]);
    expect(call(owner, "delegate", { to: "Cy", goal: "One more" })).toMatchObject({
      status: "delegated",
    });
  });

  it("caps an unattended tree's total turns, but never a human one", () => {
    openStore();
    const { ben, task_id } = delegated();
    const owner = start(ben.id);
    const now = new Date().toISOString();
    seed(
      copyRun(false),
      Array.from({ length: 300 }, (_, i) => [`seed-${i}`, owner.id, now]),
    );
    const waitUntil = () =>
      call(owner, "wait_until", {
        condition: { kind: "url_changes", url: "https://example.com/" },
        note: "Later",
        timeout_minutes: 30,
      });
    const delegate = () => call(owner, "delegate", { to: "Cy", goal: "Help" });

    seed("UPDATE tasks SET origin = 'routine' WHERE id = ?", [[task_id]]);
    for (const result of [
      waitUntil(),
      delegate(),
      call(owner, "schedule_wakeup", { in_minutes: 5, note: "Again" }),
      call(owner, "handoff", { to: "Cy", note: "Yours" }),
      call(owner, "follow_up", { task_id, kind: "ask", message: "Which year?" }),
    ]) {
      expect(result).toMatchObject({ status: "refused", reason: "tree_budget" });
    }

    seed("UPDATE tasks SET origin = 'human' WHERE id = ?", [[task_id]]);
    expect(waitUntil()).toMatchObject({ status: "waiting" });
    expect(delegate()).toMatchObject({ status: "delegated" });
  });

  it("refuses rework in an unattended tree past its turns", () => {
    openStore();
    const { ben, cy, task_id } = delegated();
    const owner = start(ben.id);
    const grandchild = String(call(owner, "delegate", { to: "Cy", goal: "Check it" }).task_id);
    finish(start(cy.id).id, "Checked.");
    seed(
      copyRun(false),
      Array.from({ length: 300 }, (_, i) => [`seed-${i}`, owner.id, new Date().toISOString()]),
    );
    const rework = () =>
      call(owner, "follow_up", { task_id: grandchild, kind: "rework", message: "Again" });

    seed("UPDATE tasks SET origin = 'routine' WHERE id = ?", [[task_id]]);
    expect(rework()).toMatchObject({ status: "refused", reason: "tree_budget" });
    seed("UPDATE tasks SET origin = 'human' WHERE id = ?", [[task_id]]);
    expect(rework()).toMatchObject({ status: "sent" });
  });

  it("renews chain turns from progress, so a long productive tree keeps delegating", () => {
    openStore();
    const { task_id, owner } = backdated();
    seed(
      copyRun(true),
      Array.from({ length: 20 }, (_, i) => [`seed-${i}`, owner.id, past(2 + i)]),
    );
    expect(call(owner, "delegate", { to: "Cy", goal: "Help" })).toMatchObject({
      status: "refused",
      reason: "chain_turns",
    });
    expect(call(owner, "report_progress", { task_id, note: "Step 1 done." })).toMatchObject({
      status: "recorded",
    });
    expect(call(owner, "delegate", { to: "Cy", goal: "Help" })).toMatchObject({
      status: "delegated",
    });
  });
});
