import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Bot, Routine } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { dueSlot, nextSlot, scheduleProblem } from "./routines.ts";
import { type EventStore, openEventStore } from "./store.ts";

const now = "2026-03-10T12:00:00.000Z";
const utc = (cron: string) => ({ cron, timezone: "UTC" });

function slots(schedule: { cron: string; timezone: string }, after: string, count: number) {
  const found: string[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    cursor = nextSlot(schedule, cursor) ?? "";
    found.push(cursor);
  }
  return found;
}

describe("schedules", () => {
  it("gives the next slot strictly after a time", () => {
    expect(nextSlot(utc("0 9 * * *"), now)).toBe("2026-03-11T09:00:00.000Z");
    expect(nextSlot(utc("0 9 * * *"), "2026-03-11T09:00:00.000Z")).toBe("2026-03-12T09:00:00.000Z");
  });

  it("has no next slot for a pattern that stopped parsing or never comes", () => {
    expect(nextSlot(utc("nope"), now)).toBeNull();
    expect(nextSlot(utc("0 0 30 2 *"), now)).toBeNull();
  });

  it("refuses bad cron, bad timezone and anything under 15 minutes apart", () => {
    expect(scheduleProblem(utc("0 9 * * 1-5"), now)).toBeNull();
    expect(scheduleProblem(utc("*/15 * * * *"), now)).toBeNull();
    expect(scheduleProblem(utc("61 * * * *"), now)).toBe("invalid_cron");
    expect(scheduleProblem(utc("0 0 30 2 *"), now)).toBe("invalid_cron");
    expect(scheduleProblem({ cron: "0 9 * * *", timezone: "Not/AZone" }, now)).toBe(
      "invalid_timezone",
    );
    expect(scheduleProblem(utc("*/14 * * * *"), now)).toBe("schedule_too_frequent");
    expect(scheduleProblem(utc("0,5 9 * * *"), now)).toBe("schedule_too_frequent");
    expect(scheduleProblem(utc("* * * * * *"), now)).toBe("schedule_too_frequent");
  });

  it("gives one 02:30 slot a day across both Paris clock changes", () => {
    const paris = { cron: "30 2 * * *", timezone: "Europe/Paris" };
    expect(slots(paris, "2026-03-28T12:00:00.000Z", 2)).toEqual([
      // 02:30 doesn't exist that day, so it lands on 03:30.
      "2026-03-29T01:30:00.000Z",
      "2026-03-30T00:30:00.000Z",
    ]);
    expect(slots(paris, "2026-10-24T12:00:00.000Z", 2)).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-26T01:30:00.000Z",
    ]);
  });

  it("returns the slot itself when only it is due", () => {
    expect(dueSlot(utc("0 9 * * *"), "2026-03-10T09:00:00.000Z", now)).toEqual({
      slot: "2026-03-10T09:00:00.000Z",
      passedOver: 0,
    });
  });

  it("returns the latest due slot and counts the ones passed over", () => {
    expect(dueSlot(utc("0 9 * * *"), "2026-03-07T09:00:00.000Z", now)).toEqual({
      slot: "2026-03-10T09:00:00.000Z",
      passedOver: 3,
    });
  });

  it("stops counting at its bound and still finds the latest slot", () => {
    const start = performance.now();
    const due = dueSlot(utc("*/15 * * * *"), "2025-03-10T00:00:00.000Z", now);
    expect(due).toEqual({ slot: now, passedOver: 1000 });
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

describe("firing", () => {
  const fields = {
    name: "Standup",
    prompt: "Say hi",
    cron: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    skipIfLaterMins: null as number | null,
  };
  const slot = "2026-03-10T09:00:00.000Z";
  const justAfter = "2026-03-10T09:00:01.000Z";

  let dataDir: string;
  let store: EventStore;
  let bot: Bot;

  beforeEach(() => {
    dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-routines-"));
    store = openEventStore(dataDir);
    bot = store.createBot({ name: "Ada", personality: "", engineAccountId: "fake" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    store.close();
    NodeFS.rmSync(dataDir, { recursive: true, force: true });
  });

  function exec(sql: string, ...values: Array<string | null>) {
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    try {
      return db.prepare(sql).run(...values);
    } finally {
      db.close();
    }
  }

  function firings() {
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    try {
      return db
        .prepare("SELECT slot, status, reason, missed_before AS missedBefore FROM routine_firings")
        .all();
    } finally {
      db.close();
    }
  }

  function routineDue(at: string, overrides: Partial<typeof fields> = {}, owner = bot): Routine {
    const routine = store.createRoutine({ ...fields, ...overrides, botId: owner.id });
    exec("UPDATE routines SET next_fire_at = ? WHERE id = ?", at, routine.id);
    return routine;
  }

  const latest = (routine: Routine) =>
    store.state().firings.find(({ routineId }) => routineId === routine.id);
  const firingId = (routine: Routine) => latest(routine)?.id ?? "";

  it("opens one card and moves next_fire_at past now together", () => {
    const routine = routineDue(slot);
    store.fireDueRoutines(justAfter);
    store.fireDueRoutines(justAfter);
    expect(firings()).toEqual([{ slot, status: "ready", reason: null, missedBefore: 0 }]);
    expect(store.getRoutine(routine.id)?.nextFireAt).toBe("2026-03-11T09:00:00.000Z");
  });

  it("leaves both the row and next_fire_at alone when the write fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const routine = routineDue(slot);
    exec(
      "CREATE TRIGGER boom BEFORE INSERT ON routine_firings BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    store.fireDueRoutines(justAfter);
    expect(firings()).toEqual([]);
    expect(store.getRoutine(routine.id)?.nextFireAt).toBe(slot);
    exec("DROP TRIGGER boom");
    store.fireDueRoutines(justAfter);
    expect(firings()).toHaveLength(1);
  });

  it("does not fire a slot that is already on record, and keeps its card open", () => {
    const routine = routineDue(slot);
    store.fireDueRoutines(justAfter);
    exec("UPDATE routines SET next_fire_at = ? WHERE id = ?", slot, routine.id);
    store.close();
    store = openEventStore(dataDir);
    store.fireDueRoutines(justAfter);
    expect(firings()).toEqual([{ slot, status: "ready", reason: null, missedBefore: 0 }]);
    expect(store.getRoutine(routine.id)?.nextFireAt).toBe("2026-03-11T09:00:00.000Z");
  });

  it("makes exactly one catch-up after a long gap, and counts what it passed over", () => {
    routineDue("2026-03-05T09:00:00.000Z");
    store.fireDueRoutines("2026-03-10T10:00:00.000Z");
    expect(firings()).toEqual([{ slot, status: "ready", reason: null, missedBefore: 5 }]);
  });

  it("records the latest slot as missed, with no card, past the catch-up window", () => {
    // Weekly: a daily slot is never more than a day old.
    const routine = routineDue("2026-03-03T09:00:00.000Z", { cron: "0 9 * * 2" });
    store.fireDueRoutines("2026-03-12T08:00:00.000Z");
    expect(firings()).toEqual([{ slot, status: "missed", reason: "asleep", missedBefore: 1 }]);
    expect(latest(routine)?.decidedAt).toBe("2026-03-12T08:00:00.000Z");
  });

  it("closes the old card as no_boundary before the new one opens", () => {
    const routine = routineDue(slot);
    const events: string[] = [];
    store.onEvent((event) => {
      if (event.type === "firing.changed") {
        events.push(event.firing.status);
      }
    });
    store.fireDueRoutines(justAfter);
    store.fireDueRoutines("2026-03-11T09:00:01.000Z");
    expect(events).toEqual(["ready", "skipped", "ready"]);
    expect(firings()).toEqual([
      { slot, status: "skipped", reason: "no_boundary", missedBefore: 0 },
      { slot: "2026-03-11T09:00:00.000Z", status: "ready", reason: null, missedBefore: 0 },
    ]);
    expect(latest(routine)?.status).toBe("ready");
  });

  it("records a paused bot's slot as skipped, with no card", () => {
    routineDue(slot);
    store.setBotPause(bot.id, "owner");
    store.fireDueRoutines(justAfter);
    expect(firings()).toEqual([{ slot, status: "skipped", reason: "bot_paused", missedBefore: 0 }]);
  });

  it("keeps going past a bad row, and turns off a row that no longer parses", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = routineDue(slot);
    const unreadable = routineDue(slot, { name: "Unreadable" });
    const good = routineDue(slot, { name: "Good" });
    exec("UPDATE routines SET cron = 'nope' WHERE id = ?", broken.id);
    exec("UPDATE routines SET skip_if_later_mins = 'x' WHERE id = ?", unreadable.id);
    store.fireDueRoutines(justAfter);
    expect(store.getRoutine(good.id)?.nextFireAt).toBe("2026-03-11T09:00:00.000Z");
    expect(store.getRoutine(broken.id)).toMatchObject({ enabled: false, nextFireAt: null });
    store.fireDueRoutines(justAfter);
    expect(firings()).toEqual([{ slot, status: "ready", reason: null, missedBefore: 0 }]);
  });

  describe("starting", () => {
    function openCard(overrides: Partial<typeof fields> = {}) {
      const routine = routineDue(slot, overrides);
      store.fireDueRoutines(justAfter);
      return routine;
    }

    it("marks it ran and posts one human message under the firing's ID", () => {
      const routine = openCard({ name: "Stand\nup" });
      const id = firingId(routine);
      expect(store.startFiring(id, true)).toBe("started");
      expect(latest(routine)?.status).toBe("ran");
      const [message] = store.state().messages;
      expect(message).toMatchObject({ id, author: "human" });
      expect(message?.body.split("\n")[0]).toMatch(
        /^\[Routine "Stand up": scheduled_for 2026-03-10T09:00:00.000Z \(UTC\), late_by \d+ minutes\]$/,
      );
      expect(message?.body.endsWith("\n\nSay hi")).toBe(true);
    });

    it("adds nothing on a repeat click", () => {
      const routine = openCard();
      const id = firingId(routine);
      store.startFiring(id, true);
      expect(store.startFiring(id, true)).toBe("firing_closed");
      expect(store.state().messages).toHaveLength(1);
    });

    it("refuses when no client is connected, and changes nothing", () => {
      const routine = openCard();
      expect(store.startFiring(firingId(routine), false)).toBe("not_attended");
      expect(latest(routine)?.status).toBe("ready");
      expect(store.state().messages).toEqual([]);
    });

    it("closes the card as too_late once past its limit", () => {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-03-10T10:00:01.000Z") });
      const routine = openCard({ skipIfLaterMins: 60 });
      expect(store.startFiring(firingId(routine), true)).toBe("too_late");
      expect(latest(routine)).toMatchObject({ status: "skipped", reason: "too_late" });
      expect(store.state().messages).toEqual([]);
    });

    it("starts inside its limit", () => {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-03-10T09:30:00.000Z") });
      const routine = openCard({ skipIfLaterMins: 60 });
      expect(store.startFiring(firingId(routine), true)).toBe("started");
      expect(store.state().messages[0]?.body).toContain("late_by 30 minutes");
    });

    it("leaves the card open when the bot is paused or busy", () => {
      const routine = openCard();
      const id = firingId(routine);
      store.setBotPause(bot.id, "owner");
      expect(store.startFiring(id, true)).toBe("bot_paused");
      store.setBotPause(bot.id, null);
      store.sendMessage({
        id: crypto.randomUUID(),
        roomId: bot.roomId,
        body: "first",
        attended: true,
      });
      const [wake] = store.dueWakes(justAfter);
      if (wake) {
        store.queueRun(wake);
      }
      expect(store.startFiring(id, true)).toBe("bot_busy");
      expect(latest(routine)?.status).toBe("ready");
    });

    it("lets the owner skip an open card, once", () => {
      const routine = openCard();
      const id = firingId(routine);
      expect(store.skipFiring(id)).toBe("skipped");
      expect(latest(routine)).toMatchObject({ status: "skipped", reason: null });
      expect(store.skipFiring(id)).toBe("firing_closed");
    });
  });

  describe("editing", () => {
    it("closes an open card and recomputes when the schedule changes", () => {
      const routine = routineDue(slot);
      store.fireDueRoutines(justAfter);
      store.updateRoutine(routine.id, { ...fields, cron: "0 10 * * *" });
      expect(latest(routine)).toMatchObject({ status: "skipped", reason: "disabled" });
      expect(store.getRoutine(routine.id)?.nextFireAt).toMatch(/T10:00:00.000Z$/);
    });

    it("leaves the card and the slot alone for a rename", () => {
      const routine = routineDue(slot);
      store.fireDueRoutines(justAfter);
      const { nextFireAt } = store.getRoutine(routine.id) ?? {};
      store.updateRoutine(routine.id, { ...fields, name: "Renamed" });
      expect(latest(routine)?.status).toBe("ready");
      expect(store.getRoutine(routine.id)?.nextFireAt).toBe(nextFireAt);
    });

    it("stops firing while disabled and picks a future slot when enabled", () => {
      const routine = routineDue(slot);
      store.updateRoutine(routine.id, { ...fields, enabled: false });
      expect(store.getRoutine(routine.id)?.nextFireAt).toBeNull();
      store.fireDueRoutines(justAfter);
      expect(firings()).toEqual([]);
      store.updateRoutine(routine.id, { ...fields, enabled: true });
      expect(Date.parse(store.getRoutine(routine.id)?.nextFireAt ?? "")).toBeGreaterThan(
        Date.now(),
      );
    });

    it("deletes a routine's firings with it", () => {
      const routine = routineDue(slot);
      store.fireDueRoutines(justAfter);
      expect(store.deleteRoutine(routine.id)).toBe(true);
      expect(firings()).toEqual([]);
      expect(store.state()).toMatchObject({ routines: [], firings: [] });
      expect(store.deleteRoutine(routine.id)).toBe(false);
    });
  });

  it("keeps only the latest firing of each routine in state", () => {
    const first = routineDue(slot);
    const second = routineDue(slot, { name: "Second" });
    store.fireDueRoutines(justAfter);
    store.fireDueRoutines("2026-03-11T09:00:01.000Z");
    const { firings: latestFirings } = store.state();
    expect(latestFirings).toHaveLength(2);
    expect(latest(first)?.slot).toBe("2026-03-11T09:00:00.000Z");
    expect(latest(second)?.slot).toBe("2026-03-11T09:00:00.000Z");
  });
});
