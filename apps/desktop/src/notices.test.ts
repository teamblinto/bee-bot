import type { Approval, Bot, Routine, ServerEvent } from "@beebot/contracts";
import { expect, it } from "vite-plus/test";

import { apply, knownFrom, noticeFor } from "./notices.ts";

const stamp = { seq: 1, createdAt: "2026-03-10T12:00:00.000Z" };
const bot = { id: "b1", name: "Hazel", status: "ready", pauseReason: null } as Bot;
const routine = { id: "t1", botId: "b1", name: "Morning digest" } as Routine;
const known = () => knownFrom({ bots: [bot], routines: [routine] });
const paused = (pauseReason: Bot["pauseReason"]): ServerEvent => ({
  ...stamp,
  type: "bot.changed",
  bot: { ...bot, status: "paused", pauseReason },
});

it("names the bot whose approval is waiting, and stays quiet once it is decided", () => {
  const approval = { id: "a1", botId: "b1" } as Approval;
  const event = (status: "pending" | "allowed"): ServerEvent => ({
    ...stamp,
    type: "approval.changed",
    approval: { ...approval, status },
  });
  expect(noticeFor(event("pending"), known())?.title).toBe("Hazel");
  expect(noticeFor(event("allowed"), known())).toBeUndefined();
});

it("tells only of a pause the owner didn't make, once", () => {
  const state = known();
  expect(noticeFor(paused("owner"), state)).toBeUndefined();
  expect(noticeFor(paused("auth_failed"), state)?.title).toBe("Hazel");
  apply(paused("auth_failed"), state);
  expect(noticeFor(paused("auth_failed"), state)).toBeUndefined();
});

it("names a routine whose firing is ready to start", () => {
  const event = (status: "ready" | "missed"): ServerEvent => ({
    ...stamp,
    type: "firing.changed",
    firing: {
      id: "f1",
      routineId: "t1",
      slot: stamp.createdAt,
      status,
      reason: null,
      missedBefore: 0,
      createdAt: stamp.createdAt,
      decidedAt: null,
    },
  });
  expect(noticeFor(event("ready"), known())?.body).toBe("Morning digest is ready to start.");
  expect(noticeFor(event("missed"), known())).toBeUndefined();
});
