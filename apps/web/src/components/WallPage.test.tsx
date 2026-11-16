// @vitest-environment jsdom
import type { Bot, BoxStatus, ChatState, Run } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { ConnectionState } from "../serverConnection";

const { watchWall, unwatch } = vi.hoisted(() => {
  const unwatch = vi.fn();
  return { unwatch, watchWall: vi.fn(() => unwatch) };
});
vi.mock("../serverConnection", async (actual) => ({
  ...(await actual<typeof import("../serverConnection")>()),
  watchWall,
}));

const { WallPage } = await import("./WallPage");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  watchWall.mockClear();
  unwatch.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const bot = (id: string, name: string) =>
  ({
    id,
    name,
    boundary: "box",
    control: "computer",
    pauseReason: null,
    status: "ready",
  }) as Bot;
const running = (botId: string) => ({ botId, state: "running" }) as BoxStatus;

function connection(): ConnectionState {
  const chat = {
    bots: [
      bot("ada", "Ada"),
      bot("bo", "Bo"),
      { ...bot("cy", "Cy"), boundary: "host", control: "none" },
      { ...bot("fy", "Fy"), control: "host" },
      { ...bot("ed", "Ed"), boundary: "host", control: "browser" },
      bot("di", "Di"),
    ],
    runs: [{ id: "run-ada", botId: "ada", status: "Running" } as Run],
    boxes: [running("ada"), running("bo"), running("di")],
    approvals: [{ id: "a1", botId: "di", status: "pending" }],
    continuations: [],
    routines: [],
    firings: [],
  } as unknown as ChatState;
  return {
    chat,
    liveTools: {
      "run-ada": [{ id: "t1", name: "Bash", detail: "ls", status: "running" }],
    },
    boxAvailability: { available: true },
    thumbnails: { ada: "AAAA" },
    held: ["bo"],
    activity: {},
  } as unknown as ConnectionState;
}

it("shows each computer's screen, status, tool and controller, and opens its bot", async () => {
  const onOpen = vi.fn();
  await act(async () =>
    root.render(<WallPage connection={connection()} onOpenDrawer={vi.fn()} onOpen={onOpen} />),
  );
  expect(watchWall).toHaveBeenCalledTimes(1);

  const tiles = [...host.querySelectorAll("li")];
  expect(tiles).toHaveLength(4);
  const [ada, bo, , di] = tiles;
  expect(ada?.textContent).toContain("Working");
  expect(ada?.textContent).toContain("Ada has control");
  expect(ada?.textContent).toContain("Running ls");
  expect(ada?.querySelector('img[src^="data:"]')?.getAttribute("src")).toBe(
    "data:image/jpeg;base64,AAAA",
  );
  expect(bo?.textContent).toContain("Idle");
  expect(bo?.textContent).toContain("You have control");
  expect(bo?.querySelector('img[src^="data:"]')).toBeNull();
  expect(di?.textContent).toContain("Waiting on you");

  await act(async () => ada?.querySelector("button")?.click());
  expect(onOpen).toHaveBeenCalledWith("ada");

  act(() => root.unmount());
  expect(unwatch).toHaveBeenCalledTimes(1);
  root = createRoot(host);
});
