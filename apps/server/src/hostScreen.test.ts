import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { ScreenRefusal } from "./computer.ts";
import {
  createHostScreen,
  type DriverAnswer,
  type DriverRequest,
  fitScreen,
  type HostDriver,
  spawnHostDriver,
  virtualKeys,
} from "./hostScreen.ts";

// A display that answers as the PowerShell driver does: the pointer stays where it was put, and an
// input op whose `at` isn't the pointer is refused as `moved`.
function fakeDisplay(width = 1920, height = 1080) {
  const state = {
    cursor: [0, 0] as [number, number],
    requests: [] as DriverRequest[],
    started: 0,
    closed: 0,
    answer: undefined as ((request: DriverRequest) => DriverAnswer | undefined) | undefined,
    fail: false,
  };
  const start = async (): Promise<HostDriver> => {
    state.started += 1;
    const generation = state.started;
    return {
      request: async (request) => {
        state.requests.push(request);
        if (state.fail) {
          state.fail = false;
          throw new Error(`driver ${generation} died`);
        }
        const scripted = state.answer?.(request);
        if (scripted) {
          return scripted;
        }
        switch (request.op) {
          case "size":
            return { width, height };
          case "cursor":
            return { x: state.cursor[0], y: state.cursor[1] };
          case "shot":
            return { width, height, data: Buffer.from(`shot ${generation}`).toString("base64") };
          default: {
            const [x, y] = request.at;
            if (x !== state.cursor[0] || y !== state.cursor[1]) {
              return { refused: "moved" };
            }
            if (request.op === "move") {
              state.cursor = [request.x, request.y];
            }
            return { ok: true };
          }
        }
      },
      close: () => {
        state.closed += 1;
      },
    };
  };
  return { state, start };
}

const run = (botId: string, attended = true) => ({ id: `run-${botId}`, botId, attended });
const signal = () => new AbortController().signal;

describe("virtualKeys", () => {
  it("maps X keysym chords to Windows virtual keys, arrows and the Windows key as extended", () => {
    expect(virtualKeys("Return")).toEqual({ vks: [0x0d], extended: [false] });
    expect(virtualKeys("ctrl+s")).toEqual({ vks: [0x11, 0x53], extended: [false, false] });
    expect(virtualKeys("ctrl+shift+Tab")).toEqual({
      vks: [0x11, 0x10, 0x09],
      extended: [false, false, false],
    });
    expect(virtualKeys("super+e")).toEqual({ vks: [0x5b, 0x45], extended: [true, false] });
    expect(virtualKeys("F5")).toEqual({ vks: [0x74], extended: [false] });
    for (const arrow of ["Left", "Up", "Right", "Down"]) {
      expect(virtualKeys(arrow)?.extended, arrow).toEqual([true]);
    }
    expect(virtualKeys("ctrl+XF86AudioPlay")).toBeUndefined();
  });
});

describe("fitScreen", () => {
  it("fits the display inside 1280x800 and never enlarges it", () => {
    expect(fitScreen({ width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720 });
    expect(fitScreen({ width: 2560, height: 1600 })).toEqual({ width: 1280, height: 800 });
    expect(fitScreen({ width: 1024, height: 768 })).toEqual({ width: 1024, height: 768 });
  });
});

describe("the host screen", () => {
  it("moves the pointer to physical pixels, scaled from the bot's fitted screen", async () => {
    const { state, start } = fakeDisplay();
    const host = createHostScreen({ start, busy: () => true });
    await host.measure();
    expect(host.screen.size).toEqual({ width: 1280, height: 720 });
    await host.screen.input(
      [
        { type: "move", x: 640, y: 360 },
        { type: "click", button: 1 },
      ],
      signal(),
    );
    expect(state.cursor).toEqual([960, 540]);
    expect(state.requests.filter(({ op }) => op === "button")).toEqual([
      { op: "button", button: 1, down: true, at: [960, 540] },
      { op: "button", button: 1, down: false, at: [960, 540] },
    ]);
    host.close();
  });

  it("serves one watched bot at a time, until its run ends", () => {
    const busy = new Set(["bot-1"]);
    const host = createHostScreen({ start: fakeDisplay().start, busy: (id) => busy.has(id) });
    expect(host.screen.refuse?.(run("bot-1", false))).toContain("watching");
    expect(host.screen.refuse?.(run("bot-1"))).toBeUndefined();
    expect(host.driving()).toBe("bot-1");
    expect(host.screen.refuse?.(run("bot-2"))).toContain("Another bot");
    busy.delete("bot-1");
    expect(host.screen.refuse?.(run("bot-2"))).toBeUndefined();
    host.close();
  });

  it("refuses everything while the owner holds it, and names the bot it took it from", async () => {
    const { state, start } = fakeDisplay();
    const host = createHostScreen({ start, busy: () => true });
    expect(host.screen.refuse?.(run("bot-1"))).toBeUndefined();
    expect(host.hold(true)).toBe("bot-1");
    expect(host.held()).toBe(true);
    expect(host.screen.refuse?.(run("bot-1"))).toContain("taken control");
    await expect(host.screen.input([{ type: "move", x: 1, y: 1 }], signal())).rejects.toThrow(
      ScreenRefusal,
    );
    expect(state.requests.some(({ op }) => op === "move")).toBe(false);
    expect(host.hold(false)).toBeUndefined();
    expect(host.screen.refuse?.(run("bot-1"))).toBeUndefined();
    host.close();
  });

  it("stops when the owner moves the mouse", async () => {
    const { state, start } = fakeDisplay();
    state.answer = (request) => {
      if (request.op === "move" && request.x === 300) {
        state.cursor = [5, 5];
      }
      return undefined;
    };
    const host = createHostScreen({ start, busy: () => true });
    await host.measure();
    const moved = host.screen.input(
      [
        { type: "move", x: 100, y: 100 },
        { type: "move", x: 200, y: 200 },
        { type: "click", button: 1 },
      ],
      signal(),
    );
    await expect(moved).rejects.toThrow(ScreenRefusal);
    await expect(moved).rejects.toThrow(/moved the mouse/);
    expect(state.requests.filter(({ op }) => op === "move")).toHaveLength(2);
    expect(state.requests.some(({ op }) => op === "button")).toBe(false);
    host.close();
  });

  it("stops when the owner moved the mouse between the bot's calls, then lets it go on", async () => {
    const { state, start } = fakeDisplay();
    const host = createHostScreen({ start, busy: () => true });
    await host.measure();
    expect(host.screen.refuse?.(run("bot-1"))).toBeUndefined();
    await host.screen.input([{ type: "move", x: 100, y: 100 }], signal());
    state.cursor = [700, 700];
    const click = [{ type: "click", button: 1 } as const];
    await expect(host.screen.input(click, signal())).rejects.toThrow(/moved the mouse/);
    expect(state.requests.some(({ op }) => op === "button")).toBe(false);
    await host.screen.input(click, signal());
    expect(state.requests.filter(({ op }) => op === "button")).toHaveLength(2);
    host.close();
  });

  it("refuses a key this computer has no key for, without sending anything", async () => {
    const { state, start } = fakeDisplay();
    const host = createHostScreen({ start, busy: () => true });
    await expect(
      host.screen.input([{ type: "key", keys: "XF86AudioPlay" }], signal()),
    ).rejects.toThrow(ScreenRefusal);
    expect(state.requests.some(({ op }) => op === "keys")).toBe(false);
    host.close();
  });

  it("refuses Bee Bot's own window", async () => {
    const { state, start } = fakeDisplay();
    state.answer = (request) => (request.op === "keys" ? { refused: "own_window" } : undefined);
    const host = createHostScreen({ start, busy: () => true });
    await expect(host.screen.input([{ type: "key", keys: "ctrl+w" }], signal())).rejects.toThrow(
      /Bee Bot's own window/,
    );
    host.close();
  });

  it("replaces a driver that died with a fresh one on the next request", async () => {
    const { state, start } = fakeDisplay();
    const host = createHostScreen({ start, busy: () => true });
    expect(String(await host.screen.screenshot())).toBe("shot 1");
    state.fail = true;
    await expect(host.screen.screenshot()).rejects.toThrow("driver 1 died");
    await Promise.resolve();
    expect(state.closed).toBe(1);
    expect(String(await host.screen.screenshot())).toBe("shot 2");
    expect(state.started).toBe(2);
    host.close();
  });

  it("starts again after a driver that never came up", async () => {
    const { state, start } = fakeDisplay();
    let attempts = 0;
    const host = createHostScreen({
      start: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error("no powershell")) : start();
      },
      busy: () => true,
    });
    await expect(host.measure()).rejects.toThrow("no powershell");
    expect(await host.measure()).toEqual({ width: 1920, height: 1080 });
    expect(state.started).toBe(1);
    host.close();
  });

  it("closes an idle driver", async () => {
    const { state, start } = fakeDisplay();
    const host = createHostScreen({ start, busy: () => true, idleMs: 10 });
    await host.measure();
    await expect.poll(() => state.closed).toBe(1);
    await host.measure();
    expect(state.started).toBe(2);
    host.close();
  });

  it("gives the owner's live view a small JPEG of the display's own shape, even first", async () => {
    const { state, start } = fakeDisplay(2000, 1000);
    const host = createHostScreen({ start, busy: () => true });
    expect(await host.frame()).toEqual({
      data: Buffer.from("shot 1").toString("base64"),
      width: 960,
      height: 480,
    });
    expect(state.requests.at(-1)).toEqual({
      op: "shot",
      w: 960,
      h: 480,
      format: "jpeg",
      quality: 60,
    });
    host.close();
  });
});

// The real PowerShell driver on this desktop. It moves the pointer a few pixels and back, so it
// runs only when asked for, and the mouse must be left alone while it does.
const hostTests = process.platform === "win32" && process.env.BEEBOT_HOST_TESTS === "1";

describe.skipIf(!hostTests)("the PowerShell driver on this desktop", { timeout: 60_000 }, () => {
  it("measures, shoots, moves, and refuses a move when the pointer isn't where it was", async () => {
    const runtimeDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-host-"));
    const driver = await spawnHostDriver(runtimeDir, "");
    try {
      const { width, height } = await driver.request({ op: "size" });
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);

      const shot = await driver.request({ op: "shot", w: 64, h: 40, format: "png", quality: 0 });
      const png = Buffer.from(shot.data ?? "", "base64");
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([64, 40]);

      const { x = 0, y = 0 } = await driver.request({ op: "cursor" });
      const start: [number, number] = [x, y];
      const nudged: [number, number] = [x > 10 ? x - 5 : x + 5, y > 10 ? y - 5 : y + 5];
      expect(await driver.request({ op: "move", x: nudged[0], y: nudged[1], at: start })).toEqual({
        ok: true,
      });
      expect(await driver.request({ op: "cursor" })).toMatchObject({ x: nudged[0], y: nudged[1] });
      const elsewhere: [number, number] = [nudged[0] + 50, nudged[1] + 50];
      expect(await driver.request({ op: "move", x, y, at: elsewhere })).toEqual({
        refused: "moved",
      });
      expect(await driver.request({ op: "cursor" })).toMatchObject({ x: nudged[0], y: nudged[1] });
      expect(await driver.request({ op: "move", x, y, at: nudged })).toEqual({ ok: true });
      expect(await driver.request({ op: "cursor" })).toMatchObject({ x, y });
    } finally {
      driver.close();
      NodeFS.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
