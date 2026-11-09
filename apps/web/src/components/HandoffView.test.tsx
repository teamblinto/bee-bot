// @vitest-environment jsdom
import type { Bot } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { postCommand, rfb } = vi.hoisted(() => ({ postCommand: vi.fn(), rfb: vi.fn() }));
vi.mock("../serverConnection", () => ({
  postCommand,
  socketUrl: (path: string) => new URL(`ws://127.0.0.1${path}`),
  displaySocketUrl: (ticket: string) => new URL(`ws://127.0.0.1/display?ticket=${ticket}`),
}));
vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    constructor(...args: unknown[]) {
      super();
      rfb(...args);
    }
    disconnect() {}
  },
}));

const { HandoffView } = await import("./HandoffView");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    sockets.push(this);
  }
  send() {}
  close() {}
}

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  postCommand.mockReset();
  rfb.mockReset();
  sockets.length = 0;
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

const bot = { id: "8a6b3c34-6f6e-4b8e-9d1c-3f1a2b4c5d6e", name: "Ada" } as Bot;

async function show() {
  await act(async () => root.render(<HandoffView bot={bot} onClose={vi.fn()} />));
  act(() =>
    sockets[0]?.onmessage?.({
      data: JSON.stringify({ type: "frame", data: "AAAA", width: 1280, height: 800 }),
    }),
  );
}

it("keeps the screencast when there is no display ticket", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  await show();
  expect(postCommand).toHaveBeenCalledWith({ type: "display-ticket", botId: bot.id, mode: "view" });
  expect(rfb).not.toHaveBeenCalled();
  expect(host.querySelector("img")?.getAttribute("alt")).toBe("Ada's browser");
});

it("opens the desktop view with the ticket, not the token", async () => {
  postCommand.mockResolvedValue({ ok: true, body: { ticket: "abc", expiresAt: 1 } });
  await show();
  expect(rfb).toHaveBeenCalledWith(expect.any(HTMLDivElement), "ws://127.0.0.1/display?ticket=abc");
});
