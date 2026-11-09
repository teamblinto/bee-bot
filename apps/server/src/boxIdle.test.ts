import * as NodeStream from "node:stream";

import { afterEach, expect, it, vi } from "vite-plus/test";

import { idleBoxes, readyBoxRuntime, sidecarEndpoint, stopIdleBoxes } from "./boxHost.ts";
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

it("counts DevTools traffic as use, and passes every byte through both ways", async () => {
  const touched: string[] = [];
  const sidecar = new NodeStream.PassThrough();
  sidecar.write("early ");
  const runtime = {
    ...createFakeBoxRuntime(),
    cdp: async () => ({ stream: sidecar, exited: new Promise<null>(() => {}) }),
  };
  const endpoint = sidecarEndpoint(runtime, "bot-1", (botId) => touched.push(botId));
  const stream = await endpoint.connect();
  stream.write("echo");
  stream.end();
  let received = "";
  for await (const chunk of stream) {
    received += String(chunk);
  }
  expect(received).toBe("early echo");
  expect(touched.length).toBeGreaterThanOrEqual(3);
});

it("keeps a box up while its display view is open, even with no bytes", async () => {
  vi.useFakeTimers();
  const fake = createFakeBoxRuntime();
  await fake.create("bot-1");
  await fake.start("bot-1");
  let close = () => {};
  const runtime = {
    ...fake,
    display: async () => ({
      stream: new NodeStream.PassThrough(),
      exited: new Promise<null>((resolve) => (close = () => resolve(null))),
    }),
  };
  const idle = stopIdleBoxes(runtime, { quietMs, everyMs: 60_000, now: () => Date.now() });
  await idle.runtime.display("bot-1", "view");
  await vi.advanceTimersByTimeAsync(2 * quietMs);
  expect(await fake.snapshot("bot-1")).toBe("running");
  close();
  await vi.advanceTimersByTimeAsync(quietMs);
  expect(await fake.snapshot("bot-1")).toBe("stopped");
  idle.close();
});
