import { EventEmitter } from "node:events";

import { afterEach, expect, it, vi } from "vite-plus/test";

import { sendUsage, startServer } from "./server.ts";

class FakeChild extends EventEmitter {
  lines: unknown[] = [];
  stdin = {
    writable: true,
    on: () => {},
    write: (line: string) => this.lines.push(JSON.parse(line)),
  };
}

const children: FakeChild[] = [];

vi.mock("electron", () => ({ dialog: { showErrorBox: () => {} } }));
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

it("holds usage lines while no server is up and writes them after the next bootstrap", async () => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
  for (let index = 0; index < 60; index += 1) {
    sendUsage("app_launched", { server_ready_ms: index });
  }
  await startServer({ entry: "server.cjs", dataDir: "data", allowedOrigins: [] });
  const [first] = children;
  expect(first?.lines).toHaveLength(51);
  expect(first?.lines[0]).toHaveProperty("token");
  expect(first?.lines[1]).toEqual({
    usage: { event: "app_launched", properties: { server_ready_ms: 10 } },
  });

  vi.useFakeTimers();
  first?.emit("exit", 1, null);
  vi.runAllTimers();
  const second = children[1];
  expect(second?.lines).toHaveLength(2);
  expect(second?.lines[0]).toHaveProperty("token");
  expect(second?.lines[1]).toMatchObject({
    usage: {
      event: "server_crashed",
      properties: { exit_code: 1, signal: null, will_restart: true },
    },
  });

  vi.useRealTimers();
});
