import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { createThumbnails } from "./thumbnails.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function wall({
  bots = ["a"],
  working = new Set<string>(),
  held = new Set<string>(),
  capture = async (_botId: string) => Buffer.from("jpeg"),
} = {}) {
  const captured: string[] = [];
  const frames: string[] = [];
  const heldSent: string[][] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const thumbnails = createThumbnails({
    running: () => bots,
    working: (botId) => working.has(botId),
    held: (botId) => held.has(botId),
    capture: async (botId) => {
      captured.push(botId);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      try {
        return await capture(botId);
      } finally {
        inFlight -= 1;
      }
    },
    onFrame: ({ botId }) => frames.push(botId),
    onHeld: (list) => heldSent.push(list),
  });
  return { thumbnails, captured, frames, heldSent, mostInFlight: () => mostInFlight };
}

const count = (list: string[], botId: string) => list.filter((id) => id === botId).length;

it("keeps to the frame budget and three captures at a time, however many bots run", async () => {
  const bots = Array.from({ length: 20 }, (_, index) => `bot-${index}`);
  const slow = async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return Buffer.from("jpeg");
  };
  const { thumbnails, captured, mostInFlight } = wall({
    bots,
    working: new Set(bots),
    capture: slow,
  });
  thumbnails.watch(true);
  await vi.advanceTimersByTimeAsync(10_000);
  // One second's worth up front, then four a second.
  expect(captured.length).toBeLessThanOrEqual(4 + 4 * 10);
  expect(captured.length).toBeGreaterThan(20);
  expect(mostInFlight()).toBe(3);
  thumbnails.close();
});

it("captures a working bot about every 3 s and an idle one about every 30 s", async () => {
  const { thumbnails, captured } = wall({ bots: ["busy", "quiet"], working: new Set(["busy"]) });
  thumbnails.watch(true);
  await vi.advanceTimersByTimeAsync(59_000);
  expect(count(captured, "busy")).toBeGreaterThanOrEqual(19);
  expect(count(captured, "busy")).toBeLessThanOrEqual(20);
  expect(count(captured, "quiet")).toBe(2);
  thumbnails.close();
});

it("never captures a stopped box", async () => {
  const bots = ["a"];
  const { thumbnails, captured } = wall({ bots, working: new Set(["a"]) });
  thumbnails.watch(true);
  bots.length = 0;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(captured).toEqual(["a"]);
  thumbnails.close();
});

it("skips a bot the owner controls, and drops a frame taken while they took control", async () => {
  const held = new Set<string>();
  let finish: (() => void) | undefined;
  const { thumbnails, captured, frames, heldSent } = wall({
    bots: ["a", "b"],
    working: new Set(["a", "b"]),
    held,
    capture: (botId) =>
      botId === "a" && finish === undefined
        ? new Promise((resolve) => (finish = () => resolve(Buffer.from("jpeg"))))
        : Promise.resolve(Buffer.from("jpeg")),
  });
  thumbnails.watch(true);
  expect(captured).toEqual(["a", "b"]);
  held.add("a");
  finish?.();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(count(captured, "a")).toBe(1);
  expect(count(frames, "a")).toBe(0);
  expect(count(frames, "b")).toBeGreaterThan(2);
  expect(heldSent).toEqual([["a"]]);
  held.delete("a");
  await vi.advanceTimersByTimeAsync(300);
  expect(count(frames, "a")).toBe(1);
  expect(heldSent.at(-1)).toEqual([]);
  thumbnails.close();
});

it("stops shortly after the last watcher leaves, and starts again when one comes", async () => {
  const { thumbnails, captured } = wall({ working: new Set(["a"]) });
  thumbnails.watch(true);
  thumbnails.watch(false);
  await vi.advanceTimersByTimeAsync(5_250);
  expect(thumbnails.watching()).toBe(false);
  const before = captured.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(captured.length).toBe(before);
  thumbnails.watch(true);
  expect(captured.length).toBe(before + 1);
  thumbnails.close();
});

it("backs off a box whose capture keeps failing", async () => {
  const { thumbnails, captured } = wall({
    working: new Set(["a"]),
    capture: () => Promise.reject(new Error("no display")),
  });
  thumbnails.watch(true);
  // Tries at 0, 5, 15 and 35 s.
  await vi.advanceTimersByTimeAsync(40_000);
  expect(captured).toHaveLength(4);
  thumbnails.close();
});
