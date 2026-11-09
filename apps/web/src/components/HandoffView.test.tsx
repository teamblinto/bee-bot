// @vitest-environment jsdom
import type { Bot } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { postCommand, rfb, disconnected } = vi.hoisted(() => ({
  postCommand: vi.fn(),
  rfb: vi.fn(),
  disconnected: vi.fn(),
}));
vi.mock("../serverConnection", () => ({
  postCommand,
  socketUrl: (path: string) => new URL(`ws://127.0.0.1${path}`),
  displaySocketUrl: (ticket: string) => new URL(`ws://127.0.0.1/display?ticket=${ticket}`),
}));
vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    constructor(...args: unknown[]) {
      super();
      rfb(this, ...args);
    }
    disconnect() {
      disconnected(this);
    }
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
  disconnected.mockReset();
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
  expect(rfb).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(HTMLDivElement),
    "ws://127.0.0.1/display?ticket=abc",
  );
  expect(rfb.mock.calls[0]?.[0]).toMatchObject({ viewOnly: true });
});

it("drives the desktop with a control ticket for the held lease, and watches again on give", async () => {
  postCommand.mockImplementation(async (command: { mode: string }) => ({
    ok: true,
    body: { ticket: command.mode, expiresAt: 1 },
  }));
  await show();
  const lease = (fields: object) =>
    act(() =>
      sockets[0]?.onmessage?.({
        data: JSON.stringify({ type: "lease", requested: null, note: null, ...fields }),
      }),
    );
  const leaseId = "0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b";
  await lease({ holder: "human", mine: true, leaseId });
  await act(async () => {});
  expect(postCommand).toHaveBeenLastCalledWith({
    type: "display-ticket",
    botId: bot.id,
    mode: "control",
    leaseId,
  });
  const [view, control] = rfb.mock.calls.map(([instance]) => instance);
  expect(disconnected).toHaveBeenCalledWith(view);
  expect(control).toMatchObject({ viewOnly: false });
  expect(rfb.mock.calls[1]?.[2]).toBe("ws://127.0.0.1/display?ticket=control");

  await lease({ holder: "bot", mine: false, leaseId: null });
  await act(async () => {});
  expect(disconnected).toHaveBeenCalledWith(control);
  expect(rfb.mock.calls[2]?.[0]).toMatchObject({ viewOnly: true });
});

it("drops the last frame and the lease once the browser is gone", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  await show();
  const lease = { type: "lease", holder: "bot", mine: false, leaseId: null };
  act(() =>
    sockets[0]?.onmessage?.({ data: JSON.stringify({ ...lease, requested: null, note: null }) }),
  );
  expect(host.querySelector("img")).not.toBeNull();
  act(() => sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "unavailable" }) }));
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("Ada has no browser running.");
  expect(host.textContent).not.toContain("Take control");
});
