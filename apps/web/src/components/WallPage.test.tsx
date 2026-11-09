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
vi.mock("../serverConnection", () => ({
  watchWall,
  postCommand: vi.fn(async () => ({ ok: false, message: "no" })),
  socketUrl: (path: string) => new URL(`ws://127.0.0.1${path}`),
  displaySocketUrl: (ticket: string) => new URL(`ws://127.0.0.1/display?ticket=${ticket}`),
}));
vi.mock("@novnc/novnc", () => ({ default: class extends EventTarget {} }));

const { WallPage } = await import("./WallPage");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  onmessage = null;
  onclose = null;
  send() {}
  close() {}
}

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  watchWall.mockClear();
  unwatch.mockClear();
  vi.stubGlobal("WebSocket", FakeSocket);
  HTMLDialogElement.prototype.showModal = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const bot = (id: string, name: string) =>
  ({ id, name, boundary: "box", pauseReason: null, status: "ready" }) as Bot;
const running = (botId: string) => ({ botId, state: "running" }) as BoxStatus;

function connection(): ConnectionState {
  const chat = {
    bots: [bot("ada", "Ada"), bot("bo", "Bo"), { ...bot("cy", "Cy"), boundary: "host" }],
    runs: [{ id: "run-ada", botId: "ada", status: "Running" } as Run],
    boxes: [running("ada"), running("bo")],
  } as ChatState;
  return {
    chat,
    liveTools: {
      "run-ada": [{ id: "t1", name: "Bash", detail: "ls", status: "running" }],
    },
    thumbnails: { ada: "AAAA" },
    held: ["bo"],
    activity: {},
  } as unknown as ConnectionState;
}

it("shows each box bot's screen, status, tool and controller, and opens its focus view", async () => {
  await act(async () => root.render(<WallPage connection={connection()} onOpenDrawer={vi.fn()} />));
  expect(watchWall).toHaveBeenCalledTimes(1);

  const tiles = [...host.querySelectorAll("li")];
  expect(tiles).toHaveLength(2);
  const [ada, bo] = tiles;
  expect(ada?.textContent).toContain("Working");
  expect(ada?.textContent).toContain("Ada has control");
  expect(ada?.textContent).toContain("Running ls");
  expect(ada?.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
  expect(bo?.textContent).toContain("Idle");
  expect(bo?.textContent).toContain("You have control");
  expect(bo?.querySelector("img")).toBeNull();

  expect(host.querySelector("dialog")).toBeNull();
  await act(async () => ada?.querySelector("button")?.click());
  expect(host.querySelector("dialog")?.getAttribute("aria-label")).toBe("Ada browser");

  act(() => root.unmount());
  expect(unwatch).toHaveBeenCalledTimes(1);
  root = createRoot(host);
});
