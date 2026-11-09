// @vitest-environment jsdom
import type { Bot, Run } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { LiveTool } from "../serverConnection";

const { postCommand, rfb, disconnected } = vi.hoisted(() => ({
  postCommand: vi.fn(),
  rfb: vi.fn(),
  disconnected: vi.fn(),
}));
vi.mock("../serverConnection", async (actual) => ({
  ...(await actual<typeof import("../serverConnection")>()),
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

const { maxWidth, minWidth, useWorkspace, Workspace } = await import("./Workspace");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sockets: FakeSocket[] = [];
class FakeSocket {
  static OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor() {
    sockets.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
}

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  postCommand.mockReset();
  rfb.mockReset();
  disconnected.mockReset();
  sockets.length = 0;
  localStorage.clear();
  vi.stubGlobal("WebSocket", FakeSocket);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const bot = {
  id: "8a6b3c34-6f6e-4b8e-9d1c-3f1a2b4c5d6e",
  name: "Ada",
  boundary: "host",
  manifest: ["browser"],
  pauseReason: null,
} as unknown as Bot;
const leaseId = "0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b";

function receive(message: object) {
  act(() => sockets[0]?.onmessage?.({ data: JSON.stringify(message) }));
}

const lease = (fields: object) =>
  receive({ type: "lease", requested: null, note: null, holder: "bot", mine: false, ...fields });

async function show(tab: "computer" | "browser" = "computer", onEdit = vi.fn(), shown = bot) {
  await act(async () =>
    root.render(
      <Workspace
        bot={shown}
        boxes={undefined}
        activity={undefined}
        tab={tab}
        liveTab={undefined}
        onTab={vi.fn()}
        onClose={vi.fn()}
        onEdit={onEdit}
      />,
    ),
  );
  receive({ type: "frame", data: "AAAA", width: 1280, height: 800 });
}

const query = <T extends Element>(selector: string) => host.querySelector<T>(selector);

it("keeps the screencast when there is no display ticket", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  await show();
  expect(postCommand).toHaveBeenCalledWith({ type: "display-ticket", botId: bot.id, mode: "view" });
  expect(rfb).not.toHaveBeenCalled();
  expect(query("img")?.getAttribute("alt")).toBe("Ada's browser");
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
  lease({ holder: "human", mine: true, leaseId });
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

  lease({ holder: "bot", mine: false, leaseId: null });
  await act(async () => {});
  expect(disconnected).toHaveBeenCalledWith(control);
  expect(rfb.mock.calls[2]?.[0]).toMatchObject({ viewOnly: true });
});

it("drops the last frame and the lease once the browser is gone", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  await show();
  lease({});
  expect(query("img")).not.toBeNull();
  receive({ type: "unavailable" });
  expect(query("img")).toBeNull();
  expect(host.textContent).not.toContain("Take control");
});

it("navigates from the address bar only while the owner holds control", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  await show("browser");
  receive({
    type: "page",
    url: "https://example.com/",
    title: "Example",
    canGoBack: true,
    canGoForward: false,
  });
  lease({});
  const address = query<HTMLInputElement>('input[aria-label="Address"]');
  expect(address?.value).toBe("https://example.com/");
  expect(address?.readOnly).toBe(true);
  expect(query<HTMLButtonElement>('button[aria-label="Back"]')?.disabled).toBe(true);
  act(() => address?.form?.requestSubmit());
  expect(sockets[0]?.sent).toEqual([]);

  lease({ holder: "human", mine: true, leaseId });
  expect(address?.readOnly).toBe(false);
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(address, "wikipedia.org");
    address?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => address?.form?.requestSubmit());
  act(() => query<HTMLButtonElement>('button[aria-label="Back"]')?.click());
  expect(sockets[0]?.sent).toEqual([
    { type: "navigate", url: "https://wikipedia.org" },
    { type: "history", direction: "back" },
  ]);
  expect(address?.value).toBe("https://example.com/");
});

it("resizes within its bounds and remembers the width", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  await show();
  const separator = query<HTMLElement>('[role="separator"]');
  const press = (key: string, times: number) => {
    for (let i = 0; i < times; i += 1) {
      act(() => separator?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
    }
  };
  press("ArrowLeft", 30);
  expect(separator?.getAttribute("aria-valuenow")).toBe(String(maxWidth));
  expect(localStorage.getItem("beebot.workspaceWidth")).toBe(String(maxWidth));
  press("ArrowRight", 30);
  expect(separator?.getAttribute("aria-valuenow")).toBe(String(minWidth));

  act(() => root.unmount());
  root = createRoot(host);
  await show();
  expect(query("[role=separator]")?.getAttribute("aria-valuenow")).toBe(String(minWidth));
});

it("offers the bot's settings instead of a screen when it has no computer or browser", async () => {
  const onEdit = vi.fn();
  await show("computer", onEdit, { ...bot, manifest: [] });
  expect(sockets).toHaveLength(0);
  expect(postCommand).not.toHaveBeenCalled();
  act(() => query<HTMLButtonElement>("aside button.button-outline")?.click());
  expect(onEdit).toHaveBeenCalled();
});

type Hook = ReturnType<typeof useWorkspace>;
let workspace: Hook;
const report = (hook: Hook) => {
  workspace = hook;
};
function Harness({ run, tools }: { run: Run | undefined; tools: LiveTool[] }) {
  report(useWorkspace(bot, run, tools, undefined, false));
  return null;
}

const runOf = (id: string) => ({ id, botId: bot.id, status: "Running" }) as Run;
const tool = (id: string, name: string): LiveTool => ({
  id,
  name,
  detail: null,
  status: "running",
});

it("opens on the tab of a screen tool, but not again in a run where the owner closed it", async () => {
  const render = (run: Run | undefined, tools: LiveTool[]) =>
    act(() => root.render(<Harness run={run} tools={tools} />));
  render(runOf("r1"), [tool("t1", "Bash")]);
  expect(workspace.open).toBe(false);

  render(runOf("r1"), [tool("t1", "Bash"), tool("t2", "mcp__bee__browser_navigate")]);
  expect(workspace).toMatchObject({ open: true, tab: "browser", liveTab: "browser" });

  act(() => workspace.close());
  render(runOf("r1"), [tool("t2", "mcp__bee__browser_navigate"), tool("t3", "computer_click")]);
  expect(workspace.open).toBe(false);
  expect(workspace.liveTab).toBe("computer");

  render(runOf("r2"), [tool("t4", "mcp__bee__computer_click")]);
  expect(workspace).toMatchObject({ open: true, tab: "computer" });
});

it("remembers the tab the owner picks for each bot", async () => {
  act(() => root.render(<Harness run={undefined} tools={[]} />));
  expect(workspace.tab).toBe("computer");
  act(() => workspace.choose("browser"));

  act(() => root.unmount());
  root = createRoot(host);
  act(() => root.render(<Harness run={undefined} tools={[]} />));
  expect(workspace.tab).toBe("browser");
});
