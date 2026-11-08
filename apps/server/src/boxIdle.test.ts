import { afterEach, expect, it, vi } from "vite-plus/test";

import { idleBoxes, readyBoxRuntime, stopIdleBoxes } from "./boxHost.ts";
import { createFakeBoxRuntime } from "./boxRuntime.ts";

const quietMs = 15 * 60_000;
const now = 100 * quietMs;

afterEach(() => {
  vi.useRealTimers();
});

it.each([
  ["quiet for the whole period", { attached: 0, lastUsedAt: now - quietMs }, true],
  ["used just inside the period", { attached: 0, lastUsedAt: now - quietMs + 1 }, false],
  ["attached to a long, silent turn", { attached: 1, lastUsedAt: 0 }, false],
] as const)("a box %s is idle: %s", (_, use, idle) => {
  expect(idleBoxes(new Map([["bot-1", use]]), now, quietMs)).toEqual(idle ? ["bot-1"] : []);
});

it("stops an idle box, keeps it, and starts it again on the next use", async () => {
  vi.useFakeTimers();
  const fake = createFakeBoxRuntime();
  const ready = readyBoxRuntime(fake, { account: () => "claude", applyEgress: async () => {} });
  const idle = stopIdleBoxes(ready, { quietMs, everyMs: 60_000, now: () => Date.now() });
  const exec = { argv: [process.execPath, "-e", ""], env: {} };
  const { exited } = await idle.runtime.execAttach("bot-1", exec);
  await exited;
  await vi.advanceTimersByTimeAsync(quietMs - 60_000);
  expect(await fake.snapshot("bot-1")).toBe("running");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await fake.snapshot("bot-1")).toBe("stopped");
  const again = await idle.runtime.execAttach("bot-1", exec);
  expect(await fake.snapshot("bot-1")).toBe("running");
  await again.exited;
  idle.close();
});
