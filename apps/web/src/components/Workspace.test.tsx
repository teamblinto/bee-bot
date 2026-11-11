// @vitest-environment jsdom
import type { Bot, BoxAvailability, HostControlAvailability, Run } from "@beebot/contracts";
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
  control: "computer",
  pauseReason: null,
} as unknown as Bot;
const leaseId = "0f8e2c4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b";

function receive(message: object) {
  act(() => sockets[0]?.onmessage?.({ data: JSON.stringify(message) }));
}

const lease = (fields: object) =>
  receive({ type: "lease", requested: null, note: null, holder: "bot", mine: false, ...fields });

const ready: BoxAvailability = {
  machine: "beebot",
  podmanFound: true,
  machineFound: true,
  boxdInstalled: true,
  imageBuilt: true,
  available: true,
  settingUp: false,
  progress: null,
  problem: null,
};

async function show(
  tab: "computer" | "browser" = "computer",
  shown = bot,
  boxes: BoxAvailability | undefined = ready,
) {
  await act(async () =>
    root.render(
      <Workspace
        bot={shown}
        boxes={boxes}
        hostControl={undefined}
        working={false}
        activity={undefined}
        tab={tab}
        liveTab={undefined}
        onTab={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
  receive({ type: "frame", data: "AAAA", width: 1280, height: 800 });
}

const query = <T extends Element>(selector: string) => host.querySelector<T>(selector);

const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.textContent?.trim().startsWith(name) || each.getAttribute("aria-label") === name,
  );

it("waits for the desktop on the Screen tab, and shows the page on the Browser tab", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  await show();
  expect(postCommand).toHaveBeenCalledWith({ type: "display-ticket", botId: bot.id, mode: "view" });
  expect(rfb).not.toHaveBeenCalled();
  expect(query("img")).toBeNull();
  expect(host.textContent).toContain("Connecting to Ada's desktop…");
  await show("browser");
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

it("takes the desktop from the bot, and hands it back from the banner", async () => {
  postCommand.mockResolvedValue({ ok: true, body: { ticket: "t", expiresAt: 1 } });
  await show();
  lease({ leaseId: null });
  act(() => button("Take control")?.click());
  expect(sockets[0]?.sent).toEqual([{ type: "take" }]);

  lease({ holder: "human", mine: true, leaseId });
  expect(button("Take control")).toBeUndefined();
  expect(host.textContent).toContain("You're in control");
  expect(host.textContent).toContain("Ada's clicks and keystrokes are refused");
  act(() => button("Hand control back")?.click());
  expect(sockets[0]?.sent).toEqual([{ type: "take" }, { type: "give" }]);

  lease({ holder: "human", mine: false, leaseId: null });
  expect(button("Take control")?.disabled).toBe(true);
});

it("drops the last frame and the lease once the browser is gone", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  await show("browser");
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

it("switches where a bot works from its panel, and asks consent there before this PC", async () => {
  const off = { ...bot, control: "none" as const };
  await show("computer", off);
  expect(sockets).toHaveLength(0);
  expect(postCommand).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Ada has no screen.");
  expect(button("Off")?.getAttribute("aria-pressed")).toBe("true");
  expect(button("This PC")?.disabled).toBe(true);

  postCommand.mockResolvedValue({ ok: true, body: {} });
  await act(async () => button("Private desktop")?.click());
  expect(postCommand).toHaveBeenCalledWith({
    type: "set-bot-control",
    botId: bot.id,
    control: "computer",
  });

  postCommand.mockClear();
  const showOff = (access: Bot["access"]) =>
    act(async () =>
      root.render(
        <Workspace
          bot={{ ...off, access }}
          boxes={ready}
          hostControl={{ available: true, problem: null, held: false }}
          working={false}
          activity={undefined}
          tab="computer"
          liveTab={undefined}
          onTab={vi.fn()}
          onClose={vi.fn()}
        />,
      ),
    );
  await showOff("supervised");
  await act(async () => button("This PC")?.click());
  expect(postCommand).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Let Ada use this PC?");
  expect(host.textContent).not.toContain("Full access");
  await act(async () => button("Cancel")?.click());
  expect(host.textContent).not.toContain("Let Ada use this PC?");
  expect(postCommand).not.toHaveBeenCalled();

  await showOff("full");
  await act(async () => button("This PC")?.click());
  expect(host.textContent).toContain("With Full access it won't ask before each click.");
  await act(async () => button("Use this PC")?.click());
  expect(postCommand).toHaveBeenCalledWith({
    type: "set-bot-control",
    botId: bot.id,
    control: "host",
  });
  expect(host.textContent).not.toContain("Let Ada use this PC?");

  postCommand.mockResolvedValue({ ok: false, message: "This bot is working." });
  await act(async () => button("Browser")?.click());
  expect(host.textContent).toContain("This bot is working.");
});

it("sets up computers from the panel when the bot wants one and boxes aren't ready", async () => {
  postCommand.mockResolvedValue({ ok: true, body: {} });
  const stopped = { ...ready, available: false, boxdInstalled: false, problem: "Not running." };
  await show("computer", bot, stopped);
  expect(sockets).toHaveLength(0);
  await act(async () => query<HTMLButtonElement>("aside button.button-primary")?.click());
  expect(postCommand).toHaveBeenCalledWith({ type: "set-up-boxes" });
  const downloading = { label: "Downloading", fraction: 0.42, detail: "42 MB of 100 MB" };
  await show("computer", bot, { ...stopped, settingUp: true, progress: downloading });
  expect(query("aside button.button-primary")).toBeNull();
  const bar = query("[role=progressbar]");
  expect(bar?.getAttribute("aria-valuenow")).toBe("42");
  expect(bar?.getAttribute("aria-valuetext")).toBe("42 MB of 100 MB");
  await show("computer", bot, {
    ...stopped,
    settingUp: true,
    progress: { ...downloading, fraction: null, detail: null },
  });
  expect(query("[role=progressbar]")?.hasAttribute("aria-valuenow")).toBe(false);
});

type Hook = ReturnType<typeof useWorkspace>;
let workspace: Hook;
const report = (hook: Hook) => {
  workspace = hook;
};
function Harness({
  run,
  tools,
  shown = bot,
}: {
  run: Run | undefined;
  tools: LiveTool[];
  shown?: Bot;
}) {
  report(useWorkspace(shown, run, tools, undefined, false));
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

it("on a narrow window, offers the screen instead of covering the chat with it", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  act(() =>
    root.render(<Harness run={runOf("r1")} tools={[tool("t1", "mcp__bee__computer_click")]} />),
  );
  expect(workspace).toMatchObject({ open: false, liveTab: "computer" });
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

it("shows only the tabs the bot's control mode has", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  const tabNames = () => [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
  await show("computer");
  expect(tabNames()).toEqual(["Screen", "Browser"]);

  postCommand.mockClear();
  await show("browser", { ...bot, control: "browser" });
  expect(tabNames()).toEqual(["Screen", "Browser"]);
  expect(postCommand).not.toHaveBeenCalledWith(expect.objectContaining({ type: "display-ticket" }));

  await showHost({ available: true, problem: null, held: false });
  expect(tabNames()).toEqual(["Screen"]);

  await show("computer", { ...bot, control: "none" });
  expect(tabNames()).toEqual(["Screen"]);
});

async function showHost(hostControl: HostControlAvailability | undefined, working = false) {
  await act(async () =>
    root.render(
      <Workspace
        bot={{ ...bot, control: "host" }}
        boxes={undefined}
        hostControl={hostControl}
        working={working}
        activity={undefined}
        tab="host"
        liveTab={undefined}
        onTab={vi.fn()}
        onClose={vi.fn()}
      />,
    ),
  );
}

const frameCalls = () =>
  postCommand.mock.calls.filter(([command]) => command.type === "host-frame").length;

it("polls the owner's screen, faster while the bot works, and stops when closed", async () => {
  vi.useFakeTimers();
  try {
    postCommand.mockResolvedValue({ ok: true, body: { data: "BBBB", width: 1920, height: 1080 } });
    const available = { available: true, problem: null, held: false };
    await showHost(available);
    expect(frameCalls()).toBe(1);
    expect(query("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,BBBB");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(frameCalls()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(frameCalls()).toBe(2);

    await showHost(available, true);
    expect(frameCalls()).toBe(3);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(frameCalls()).toBe(4);

    act(() => root.unmount());
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(frameCalls()).toBe(4);
    root = createRoot(host);
  } finally {
    vi.useRealTimers();
  }
});

it("takes the owner's computer back from bots, and hands it back", async () => {
  postCommand.mockResolvedValue({ ok: true, body: {} });
  await showHost({ available: true, problem: null, held: false });
  await act(async () => button("Take control")?.click());
  expect(postCommand).toHaveBeenCalledWith({ type: "host-hold", held: true });

  await showHost({ available: true, problem: null, held: true });
  expect(host.textContent).toContain("You're in control");
  await act(async () => button("Hand control back")?.click());
  expect(postCommand).toHaveBeenCalledWith({ type: "host-hold", held: false });
});

it("doesn't ask for the owner's screen when this computer can't be used", async () => {
  await showHost({ available: false, problem: "Only the Windows app can.", held: false });
  expect(postCommand).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Only the Windows app can.");
});

it("opens a host bot's screen tools and remembered tab on the owner's screen", async () => {
  const hostBot = { ...bot, control: "host" as const };
  localStorage.setItem(`beebot.workspaceTab.${bot.id}`, "browser");
  act(() => root.render(<Harness run={undefined} tools={[]} shown={hostBot} />));
  expect(workspace.tab).toBe("host");
  act(() =>
    root.render(
      <Harness
        run={runOf("r1")}
        tools={[tool("t1", "mcp__bee__computer_click")]}
        shown={hostBot}
      />,
    ),
  );
  expect(workspace).toMatchObject({ open: true, tab: "host", liveTab: "host" });
});

it("gives a browser-only bot's takeover the Browser tab", async () => {
  const browserBot = { ...bot, control: "browser" as const };
  act(() => root.render(<Harness run={undefined} tools={[]} shown={browserBot} />));
  expect(workspace.tab).toBe("browser");
  act(() => workspace.choose("computer"));
  expect(workspace.tab).toBe("computer");
  act(() =>
    root.render(
      <Harness
        run={undefined}
        tools={[]}
        shown={{ ...browserBot, pauseReason: "browser_session" }}
      />,
    ),
  );
  expect(workspace).toMatchObject({ open: true, tab: "browser", liveTab: "browser" });
});
