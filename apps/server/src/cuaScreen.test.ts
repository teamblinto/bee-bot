import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  createCuaScreen,
  type CuaDriver,
  cuaExecutors,
  type CuaResult,
  type CuaScreenDeps,
  ownerPaused,
  spawnCuaDriver,
} from "./cuaScreen.ts";

type Call = { name: string; args: Record<string, unknown> };

const ok = (text: string, structured: Record<string, unknown> = {}): CuaResult => ({
  isError: false,
  content: [{ type: "text", text }],
  structured,
});

const windows = [
  { window_id: 11, pid: 101, title: "Untitled - Notepad", app_name: "Notepad.exe" },
  { window_id: 22, pid: 202, title: "Bee Bot", app_name: "Bee Bot.exe" },
  { window_id: 33, pid: 303, title: "Example - Edge", app_name: "msedge.exe" },
  // Bee Bot's window under `pnpm dev:desktop`, owned by its Electron main process.
  { window_id: 44, pid: 404, title: "Bee Bot", app_name: "electron.exe" },
];

// Answers as cua-driver does: Edge's window drops typing, keys and scrolling sent in the background.
// A call named in `failing` fails, and one named in `hang` waits until the driver is killed.
function fakeDriver() {
  const state = {
    calls: [] as Call[],
    windows,
    started: 0,
    closed: 0,
    killed: 0,
    die: false,
    failing: undefined as string | undefined,
    hang: undefined as string | undefined,
    // Notepad's next look, which makes tokens from its earlier looks stale.
    snapshot: "s1",
    tree: '- Window\n  - [12] Edit "Text editor" [actions=[set_value]]\n',
  };
  const answer = (name: string, args: Record<string, unknown>): CuaResult => {
    if (name === state.failing) {
      return { isError: true, content: [{ type: "text", text: "no such window" }], structured: {} };
    }
    const token = String(args.element_token);
    if (token.startsWith("s1") && !token.startsWith(`${state.snapshot}:`)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "element_token is stale or unknown; call get_window_state again to refresh",
          },
        ],
        structured: {},
      };
    }
    switch (name) {
      case "list_windows":
        return ok("windows", { windows: state.windows });
      case "get_window_state": {
        const id = args.window_id === 33 ? "s3" : state.snapshot;
        return ok(`snapshot_id=${id}`, {
          ...state.windows.find(({ window_id }) => window_id === args.window_id),
          snapshot_id: id,
          tree_markdown: state.tree,
        });
      }
      case "get_desktop_state":
        return {
          isError: false,
          content: [{ type: "image", data: "UE5H", mimeType: "image/png" }],
          structured: { screenshot_width: 960, screenshot_height: 540 },
        };
      default: {
        const edge = args.pid === 303 || String(args.element_token).startsWith("s3:");
        if (
          edge &&
          args.delivery_mode !== "foreground" &&
          name !== "click" &&
          name !== "set_value"
        ) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Background delivery is not available for target window class 'Chrome_WidgetWin_1'",
              },
            ],
            structured: {},
          };
        }
        return ok(`did ${name}`);
      }
    }
  };
  const start = async (): Promise<CuaDriver> => {
    state.started += 1;
    let killed = () => {};
    return {
      call: async (name, args) => {
        state.calls.push({ name, args });
        if (state.die) {
          state.die = false;
          throw new Error("cua_driver_exited");
        }
        if (name === state.hang) {
          await new Promise<void>((resolve) => {
            killed = resolve;
          });
          throw new Error("cua_driver_stopped");
        }
        return answer(name, args);
      },
      close: () => {
        state.closed += 1;
      },
      kill: () => {
        state.killed += 1;
        killed();
      },
    };
  };
  return { state, start };
}

// A clock that moves only when the screen sleeps, and an owner whose last input is `ownerAt`.
function setUp(over: Partial<CuaScreenDeps> = {}) {
  const driver = fakeDriver();
  const time = { now: 10_000, ownerAt: 9_500 };
  const audits: string[] = [];
  const screen = createCuaScreen({
    start: driver.start,
    refuse: () => undefined,
    check: () => ({ kind: "allow" }),
    appendAudit: (record) => audits.push(record.reason ?? ""),
    requestApproval: () => "waiting for the owner",
    idle: () => ({ idleSeconds: Math.floor((time.now - time.ownerAt) / 1000), at: time.now }),
    ownApp: "bee bot.exe",
    ownPids: [404],
    now: () => time.now,
    sleep: async (ms) => {
      time.now += ms;
    },
    ...over,
  });
  return { ...driver, time, audits, screen };
}

const run = { id: "run-1", botId: "bot-1", attended: true };
const said = (content: { type: string; text?: string }[]) =>
  content.map((item) => item.text ?? "").join("\n");

describe("ownerPaused", () => {
  it("waits for 3 idle seconds, but doesn't count the bot's own foreground input", () => {
    expect(ownerPaused({ idleSeconds: 3, at: 20_000 }, 20_000)).toBe(true);
    expect(ownerPaused({ idleSeconds: 2, at: 20_000 }, 20_000)).toBe(false);
    // The bot's foreground input ended at 18 s, and nothing has come since.
    expect(ownerPaused({ idleSeconds: 2, at: 20_000 }, 20_000, 18_000)).toBe(true);
    expect(ownerPaused({ idleSeconds: 1, at: 20_000 }, 20_000, 18_500)).toBe(true);
    expect(ownerPaused({ idleSeconds: 0, at: 18_100 }, 18_100, 18_000)).toBe(true);
    // The owner moved after it, even just after.
    expect(ownerPaused({ idleSeconds: 0, at: 20_000 }, 20_000, 18_000)).toBe(false);
    expect(ownerPaused({ idleSeconds: 1, at: 20_000 }, 20_000, 18_000)).toBe(false);
    // A reading from before it ended can't tell.
    expect(ownerPaused({ idleSeconds: 2, at: 18_000 }, 18_100, 18_000)).toBe(false);
    // An old reading says nothing about now.
    expect(ownerPaused({ idleSeconds: 9, at: 20_000 }, 23_000)).toBe(false);
  });
});

describe("the cua host screen", () => {
  it("maps each tool to its driver call, in the run's session", async () => {
    const { state, screen } = setUp();
    await screen.call(run, "computer_windows", { app: "notepad" });
    await screen.call(run, "computer_look", { window_id: 11 });
    await screen.call(run, "computer_window_type", { element: "s1:12", text: "hi" });
    await screen.call(run, "computer_window_type", { element: "s1:12", text: "hi", replace: true });
    await screen.call(run, "computer_window_click", { element: "s1:12", double: true });
    await screen.call(run, "computer_window_click", { window_id: 11, x: 5, y: 6 });
    await screen.call(run, "computer_window_key", { window_id: 11, keys: "ctrl+S" });
    await screen.call(run, "computer_window_key", { element: "s1:12", keys: "Return" });
    await screen.call(run, "computer_window_scroll", { window_id: 11, direction: "down" });
    await screen.call(run, "computer_window_drag", { window_id: 11, from: [1, 2], to: [3, 4] });
    await screen.call(run, "computer_open", { app: "C:\\Tools\\app.exe" });
    const session = "run-1";
    const target = { pid: 101, window_id: 11 };
    expect(state.calls).toEqual([
      { name: "list_windows", args: { session, app: "notepad" } },
      {
        name: "get_window_state",
        args: { session, ...target, include_screenshot: false, max_image_dimension: 1280 },
      },
      { name: "type_text", args: { session, element_token: "s1:12", text: "hi" } },
      { name: "set_value", args: { session, element_token: "s1:12", value: "hi" } },
      { name: "click", args: { session, element_token: "s1:12", button: "left", count: 2 } },
      { name: "click", args: { session, ...target, x: 5, y: 6, button: "left", count: 1 } },
      { name: "hotkey", args: { session, ...target, keys: ["ctrl", "s"] } },
      { name: "press_key", args: { session, element_token: "s1:12", key: "return" } },
      { name: "scroll", args: { session, ...target, direction: "down", amount: 3 } },
      {
        name: "drag",
        args: { session, ...target, from_x: 1, from_y: 2, to_x: 3, to_y: 4 },
      },
      { name: "launch_app", args: { session, path: "C:\\Tools\\app.exe" } },
    ]);
    screen.close();
  });

  it("runs an approved action on a fresh token when the window was looked at again", async () => {
    const { state, screen } = setUp();
    const execute = new Map(cuaExecutors(screen)).get("computer_window_type");
    const approved = (element: string) =>
      execute?.({
        botId: run.botId,
        runId: run.id,
        tool: "computer_window_type",
        payload: JSON.stringify({ input: { element, text: "hi\nyo" } }),
      });
    await screen.call(run, "computer_look", { window_id: 11 });
    // Another look while the owner decides.
    state.snapshot = "s1b";
    expect(await approved("s1:12")).toEqual({
      ok: true,
      output: 'Typed into "Untitled - Notepad"',
    });
    expect(state.calls.slice(2).map(({ name, args }) => [name, args.element_token])).toEqual([
      ["type_text", "s1:12"],
      ["get_window_state", undefined],
      ["type_text", "s1b:12"],
    ]);

    // The control at that index is another one now.
    state.snapshot = "s1c";
    state.tree = '- Window\n  - [12] Button "Send"\n';
    const failed = await approved("s1b:12");
    expect(failed?.ok).toBe(false);
    expect(failed?.output).toContain("computer_look");
    expect(state.calls.at(-1)?.name).toBe("get_window_state");
    screen.close();
  });

  it("refuses as the PowerShell screen does, without reaching the driver", async () => {
    let refusal: string | undefined = "The owner has taken control of their computer.";
    const { state, audits, screen } = setUp({ refuse: () => refusal });
    expect(said(await screen.call(run, "computer_windows", {}))).toContain("taken control");
    expect(state.calls).toEqual([]);
    expect(audits).toEqual(["screen_refused"]);
    refusal = undefined;
    expect(said(await screen.call(run, "computer_look", { window_id: 22 }))).toContain(
      "Bee Bot's own window",
    );
    expect(said(await screen.call(run, "computer_look", { window_id: 44 }))).toContain(
      "Bee Bot's own window",
    );
    expect(state.calls.map(({ name }) => name)).toEqual(["list_windows"]);
    expect(
      said(await screen.call(run, "computer_window_type", { element: "s9:1", text: "x" })),
    ).toContain("computer_look");
    for (const app of ["powershell", "C:\\Windows\\System32\\cmd.exe", "C:\\x\\run.ps1", "wsl"]) {
      expect(said(await screen.call(run, "computer_open", { app }))).toContain("doesn't open");
    }
    expect(state.calls.map(({ name }) => name)).toEqual(["list_windows"]);
    screen.close();
  });

  it("forgets a window a call fails on, so an id reused by Bee Bot's window is refused", async () => {
    const { state, screen } = setUp();
    await screen.call(run, "computer_look", { window_id: 11 });
    state.windows = state.windows.map((row) => (row.window_id === 11 ? { ...row, pid: 404 } : row));
    state.failing = "click";
    const click = { window_id: 11, x: 1, y: 1 };
    expect(said(await screen.call(run, "computer_window_click", click))).toBe("no such window");
    expect(said(await screen.call(run, "computer_window_click", click))).toContain(
      "Bee Bot's own window",
    );
    screen.close();
  });

  it("sends what a window drops in the background in front, once the owner pauses", async () => {
    const { state, time, screen } = setUp();
    await screen.call(run, "computer_look", { window_id: 33 });
    const typed = await screen.call(run, "computer_window_type", { element: "s3:12", text: "hi" });
    expect(said(typed)).toBe("did computer_window_type");
    expect(time.now).toBeGreaterThanOrEqual(time.ownerAt + 3000);
    expect(state.calls.slice(-2).map(({ args }) => args.delivery_mode)).toEqual([
      undefined,
      "foreground",
    ]);

    // Its own keys reset the idle time, and the owner hasn't moved since, so this goes on the next
    // reading.
    const before = time.now;
    time.ownerAt = time.now;
    await screen.call(run, "computer_window_key", { window_id: 33, keys: "Return" });
    expect(time.now - before).toBeLessThanOrEqual(250);
    expect(state.calls.at(-1)?.args.delivery_mode).toBe("foreground");
    screen.close();
  });

  it("never sends keys that act on the whole computer in front", async () => {
    const { state, screen } = setUp();
    for (const keys of ["win+r", "alt+Tab", "alt+F4", "ctrl+shift+esc", "ctrl+escape"]) {
      const pressed = await screen.call(run, "computer_window_key", { window_id: 33, keys });
      expect(said(pressed)).toContain("whole computer");
    }
    expect(state.calls.some(({ args }) => args.delivery_mode === "foreground")).toBe(false);
    screen.close();
  });

  it("stops an action in flight when the owner takes control", async () => {
    let refusal: string | undefined;
    const { state, screen } = setUp({ refuse: () => refusal });
    await screen.call(run, "computer_look", { window_id: 33 });
    state.hang = "type_text";
    const typing = screen.call(run, "computer_window_type", { element: "s3:12", text: "hi" });
    await expect.poll(() => state.calls.at(-1)?.name).toBe("type_text");
    refusal = "The owner has taken control of their computer.";
    screen.interrupt();
    expect(said(await typing)).toContain("taken control");
    expect(state.killed).toBe(1);
    screen.close();
  });

  it("gives up after 30 s of the owner using the computer, and never goes in front", async () => {
    const { state, time, screen } = setUp({
      idle: () => ({ idleSeconds: 0, at: time.now }),
    });
    const scrolled = await screen.call(run, "computer_window_scroll", {
      window_id: 33,
      direction: "down",
    });
    expect(said(scrolled)).toContain("kept using the computer");
    expect(time.now).toBeGreaterThanOrEqual(40_000);
    expect(state.calls.some(({ args }) => args.delivery_mode === "foreground")).toBe(false);
    screen.close();
  });

  it("never goes in front without word from the desktop, or once the owner takes control", async () => {
    let refusal: string | undefined;
    const { state, time, screen } = setUp({ idle: () => undefined, refuse: () => refusal });
    const keys = { window_id: 33, keys: "Return" };
    expect(said(await screen.call(run, "computer_window_key", keys))).toContain("kept using");
    expect(time.now).toBe(10_000);

    const held = setUp({
      idle: () => ({ idleSeconds: 0, at: held.time.now }),
      refuse: () => refusal,
    });
    const waiting = held.screen.call(run, "computer_window_key", keys);
    refusal = "The owner has taken control of their computer.";
    expect(said(await waiting)).toContain("taken control");
    expect(state.calls.concat(held.state.calls).some(({ args }) => args.delivery_mode)).toBe(false);
    screen.close();
    held.screen.close();
  });

  it("starts a fresh driver after one dies", async () => {
    const { state, screen } = setUp();
    state.die = true;
    expect(said(await screen.call(run, "computer_windows", {}))).toContain("computer_unavailable");
    await Promise.resolve();
    expect(state.closed).toBe(1);
    expect(said(await screen.call(run, "computer_windows", {}))).toBe("windows");
    expect(state.started).toBe(2);
    screen.close();
  });

  it("fails only the call a garbled or late reply belongs to, until the driver hangs", async () => {
    const script = `
      require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
        const { id, params } = JSON.parse(line);
        const name = params?.name;
        if (id === undefined || name === "slow") return;
        const result = name === "bad" ? { content: "garbled" } : { content: [{ type: "text", text: "ok" }] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
      });`;
    const driver = await spawnCuaDriver(process.execPath, ["-e", script], 200);
    try {
      expect((await driver.call("bad", {})).isError).toBe(true);
      expect(said((await driver.call("slow", {})).content)).toContain("didn't answer");
      expect(said((await driver.call("fine", {})).content)).toBe("ok");
      await driver.call("slow", {});
      await expect(driver.call("slow", {})).rejects.toThrow("cua_driver_stopped");
    } finally {
      driver.close();
    }
  });

  it("isn't ready when the driver can't start, and tries again only a minute later", async () => {
    let starts = 0;
    const { time, screen } = setUp({
      start: () => {
        starts += 1;
        return spawnCuaDriver(NodePath.join(NodeOS.tmpdir(), "no-such-dir", "cua-driver.exe"));
      },
    });
    expect(await screen.ready()).toBe(false);
    time.now += 59_000;
    expect(await screen.ready()).toBe(false);
    expect(starts).toBe(1);
    time.now += 1_000;
    expect(await screen.ready()).toBe(false);
    expect(starts).toBe(2);
    screen.close();
  });

  it("gives the owner's live view a PNG of the desktop", async () => {
    const { state, screen } = setUp();
    expect(await screen.frame()).toEqual({
      data: "UE5H",
      width: 960,
      height: 540,
      mime: "image/png",
    });
    expect(state.calls).toEqual([
      { name: "get_desktop_state", args: { session: "bee-preview", max_image_dimension: 960 } },
    ]);
    screen.close();
  });
});

// The real driver on this desktop. It opens Notepad and types in it, so it runs only when asked.
const driverPath = process.env.BEEBOT_CUA_DRIVER;
const cuaTests =
  process.platform === "win32" && process.env.BEEBOT_HOST_TESTS === "1" && Boolean(driverPath);

describe.skipIf(!cuaTests)("cua-driver on this desktop", { timeout: 60_000 }, () => {
  it("opens Notepad and types into it by element token", async () => {
    const exe = driverPath ?? "";
    const check = await spawnCuaDriver(exe);
    const sent: string[] = [];
    const { screen } = setUp({
      start: async () => {
        const driver = await spawnCuaDriver(exe);
        return {
          ...driver,
          call: (name, args) => {
            sent.push(`${name} ${args.element_token ?? ""}`);
            return driver.call(name, args);
          },
        };
      },
      ownPids: [process.pid, process.ppid],
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    let pid: number | undefined;
    let windowId: number | undefined;
    // Notepad brings back the tab it last had, typing and all, even after it is killed.
    const editor = async () => {
      const read = await check.call("get_window_state", {
        pid,
        window_id: windowId,
        include_screenshot: false,
        tree_format: "elements",
        query: "Text editor",
      });
      const [found] = z
        .array(z.object({ element_token: z.string(), value: z.string().optional() }))
        .parse(read.structured.elements);
      return found;
    };
    const clear = async () => {
      await check.call("set_value", { element_token: (await editor())?.element_token, value: "" });
    };
    try {
      const open = await check.call("list_windows", { app: "notepad" });
      expect(open.structured.windows, "close Notepad first").toEqual([]);

      const opened = said(await screen.call(run, "computer_open", { app: "notepad" }));
      pid = Number(/pid (\d+)/.exec(opened)?.[1]);
      windowId = Number(/window_id: (\d+)/.exec(opened)?.[1]);
      await clear();
      const look = said(
        await screen.call(run, "computer_look", { window_id: windowId, query: "Text editor" }),
      );
      const snapshot = /snapshot_id=(\S+)/.exec(look)?.[1];
      const row = /\[(\d+)\] Document/.exec(look)?.[1];
      const token = `${snapshot}:${row}`;
      // A later turn looks again, which makes the first look's tokens stale.
      await screen.call({ ...run, id: "run-2" }, "computer_look", { window_id: windowId });
      const before = sent.length;
      const typed = await screen.call(run, "computer_window_type", {
        element: token,
        text: "bee was here\nand here",
      });
      expect(said(typed)).not.toContain("stale");
      expect(sent.slice(before)).toEqual([
        `type_text ${token}`,
        "get_window_state ",
        expect.not.stringContaining(token),
      ]);
      expect((await editor())?.value?.replace(/\r\n?/g, "\n")).toBe("bee was here\nand here");
    } finally {
      if (pid) {
        await clear().catch(() => {});
      }
      screen.close();
      check.close();
      // Synchronous, so Notepad is gone before the test ends.
      if (pid) {
        NodeChildProcess.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
        });
      }
    }
  });
});
