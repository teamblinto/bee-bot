import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { InputAction } from "@beebot/boxd/protocol";
import type { HostControlAvailability } from "@beebot/contracts";
import { z } from "zod";

import type { BrowserRun } from "./browser.ts";
import { boxScreen, type Screen, ScreenRefusal, type ScreenSize } from "./computer.ts";
import { killTree } from "./engine.ts";
import { hostDriverScript } from "./hostDriver.ps1.ts";

// One request at a time over the driver's stdio. `refused` is the driver declining an input op:
// `moved` (the owner's hand is on the mouse) or `own_window` (Bee Bot's window is the target).
export type DriverRequest =
  | { op: "size" }
  | { op: "shot"; w: number; h: number; format: "png" | "jpeg"; quality: number }
  | { op: "move"; x: number; y: number; at: [number, number] }
  | { op: "button"; button: 1 | 2 | 3; down: boolean; at: [number, number] }
  | {
      op: "scroll";
      direction: "up" | "down" | "left" | "right";
      amount: number;
      at: [number, number];
    }
  | { op: "keys"; vks: number[]; extended: boolean[]; at: [number, number] }
  | { op: "type"; text: string; at: [number, number] }
  | { op: "cursor" };

const Answer = z.object({
  ok: z.boolean().optional(),
  refused: z.enum(["moved", "own_window"]).optional(),
  error: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  data: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});
export type DriverAnswer = z.infer<typeof Answer>;

export type HostDriver = {
  request: (request: DriverRequest) => Promise<DriverAnswer>;
  close: () => void;
};

const startTimeoutMs = 30_000;
const requestTimeoutMs = 60_000;

// Windows PowerShell 5.1 is part of every Windows. `guardExe` is Bee Bot's own executable, whose
// windows the bot may not touch.
export async function spawnHostDriver(runtimeDir: string, guardExe: string): Promise<HostDriver> {
  NodeFS.mkdirSync(runtimeDir, { recursive: true });
  const script = NodePath.join(runtimeDir, "host-driver.ps1");
  NodeFS.writeFileSync(script, hostDriverScript);
  const child = NodeChildProcess.spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    {
      env: { ...process.env, BEE_GUARD_EXE: guardExe },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdin.on("error", () => {});
  child.stderr.on("data", () => {});
  const lines = NodeReadline.createInterface({ input: child.stdout });
  const waiting: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  let gone: Error | undefined;
  const fail = (error: Error) => {
    gone ??= error;
    for (const pending of waiting.splice(0)) {
      pending.reject(gone);
    }
  };
  lines.on("line", (line) => waiting.shift()?.resolve(line));
  child.once("exit", () => fail(new Error("host_driver_exited")));
  child.once("error", (error) => fail(error));

  const next = (timeoutMs: number) =>
    new Promise<string>((resolve, reject) => {
      if (gone) {
        reject(gone);
        return;
      }
      const timer = setTimeout(() => {
        fail(new Error("host_driver_timeout"));
        if (child.pid !== undefined) {
          killTree(child.pid);
        }
      }, timeoutMs);
      waiting.push({
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });

  await next(startTimeoutMs);
  let queue = Promise.resolve();
  return {
    request: (request) => {
      const answer = queue.then(async () => {
        const reply = next(requestTimeoutMs);
        child.stdin.write(`${JSON.stringify(request)}\n`);
        const parsed = Answer.parse(JSON.parse(await reply));
        if (parsed.error !== undefined) {
          throw new Error(`host_driver: ${parsed.error}`);
        }
        return parsed;
      });
      queue = answer.then(
        () => {},
        () => {},
      );
      return answer;
    },
    close: () => {
      lines.close();
      child.stdin.end();
      if (child.pid !== undefined && child.exitCode === null) {
        killTree(child.pid);
      }
    },
  };
}

// The whole display, fitted to the box's 1280x800 so a bot's screenshots cost the same either way.
export function fitScreen(physical: ScreenSize): ScreenSize {
  const scale = Math.min(1, boxScreen.width / physical.width, boxScreen.height / physical.height);
  return {
    width: Math.max(1, Math.round(physical.width * scale)),
    height: Math.max(1, Math.round(physical.height * scale)),
  };
}

const named: Record<string, number> = {
  Return: 0x0d,
  KP_Enter: 0x0d,
  Tab: 0x09,
  ISO_Left_Tab: 0x09,
  Escape: 0x1b,
  BackSpace: 0x08,
  Delete: 0x2e,
  Insert: 0x2d,
  Home: 0x24,
  End: 0x23,
  Page_Up: 0x21,
  Prior: 0x21,
  Page_Down: 0x22,
  Next: 0x22,
  Left: 0x25,
  Up: 0x26,
  Right: 0x27,
  Down: 0x28,
  space: 0x20,
  Menu: 0x5d,
  Print: 0x2c,
  Pause: 0x13,
  Caps_Lock: 0x14,
  minus: 0xbd,
  equal: 0xbb,
  plus: 0xbb,
  comma: 0xbc,
  period: 0xbe,
  slash: 0xbf,
  semicolon: 0xba,
  apostrophe: 0xde,
  grave: 0xc0,
  bracketleft: 0xdb,
  bracketright: 0xdd,
  backslash: 0xdc,
};
const modifierKeys: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12,
  shift: 0x10,
  super: 0x5b,
  meta: 0x5b,
};
const extendedKeys = new Set([
  0x2e, 0x2d, 0x24, 0x23, 0x21, 0x22, 0x25, 0x26, 0x27, 0x28, 0x5b, 0x5d,
]);

// The X keysym names the box takes, as Windows virtual keys. Undefined for a key Windows lacks.
export function virtualKeys(keys: string) {
  const vks: number[] = [];
  for (const [index, part] of keys.split("+").entries()) {
    const last = index === keys.split("+").length - 1;
    const modifier = modifierKeys[part.toLowerCase()];
    let vk: number | undefined;
    if (!last && modifier !== undefined) {
      vk = modifier;
    } else if (/^[A-Za-z0-9]$/.test(part)) {
      vk = part.toUpperCase().charCodeAt(0);
    } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(part)) {
      vk = 0x6f + Number(part.slice(1));
    } else {
      vk = named[part] ?? modifierKeys[part.toLowerCase()];
    }
    if (vk === undefined) {
      return undefined;
    }
    vks.push(vk);
  }
  return { vks, extended: vks.map((vk) => extendedKeys.has(vk)) };
}

type Point = [number, number];

export type HostScreenDeps = {
  // Started on first use and again after it exits.
  start: () => Promise<HostDriver>;
  // Whether the bot has a run going, so a finished bot's hold on the screen lapses.
  busy: (botId: string) => boolean;
  idleMs?: number;
};

const ownWindow =
  "That is Bee Bot's own window, which you may not use. Ask the owner to move it aside or " +
  "minimize it if it is in your way.";

// The owner's own desktop. One run drives it at a time, only while the owner watches, and never
// while the owner holds it.
export function createHostScreen(deps: HostScreenDeps) {
  let driver: Promise<HostDriver> | undefined;
  let physical: ScreenSize | undefined;
  let holder: { botId: string } | undefined;
  let ownerHold = false;
  // Where the driving bot last left the pointer, so the owner's move between its calls counts too.
  let left: Point | undefined;
  let idle: NodeJS.Timeout | undefined;
  const idleMs = deps.idleMs ?? 5 * 60_000;

  function shutDown() {
    const closing = driver;
    driver = undefined;
    void closing?.then(
      (open) => open.close(),
      () => {},
    );
  }

  async function request(body: DriverRequest) {
    clearTimeout(idle);
    idle = setTimeout(shutDown, idleMs);
    idle.unref?.();
    if (!driver) {
      const starting = deps.start();
      driver = starting;
      starting.catch(() => {
        if (driver === starting) {
          driver = undefined;
        }
      });
    }
    const open = driver;
    try {
      return await (await open).request(body);
    } catch (error) {
      // A driver that died or hung is replaced on the next request.
      if (driver === open) {
        driver = undefined;
        void open.then(
          (dead) => dead.close(),
          () => {},
        );
      }
      throw error;
    }
  }

  async function measure() {
    const { width, height } = await request({ op: "size" });
    if (width && height) {
      physical = { width, height };
    }
    return physical;
  }

  const size = () => fitScreen(physical ?? { width: 1920, height: 1080 });
  const toPhysical = ([x, y]: Point): Point => {
    const shown = size();
    const real = physical ?? shown;
    return [
      Math.min(real.width - 1, Math.round((x * real.width) / shown.width)),
      Math.min(real.height - 1, Math.round((y * real.height) / shown.height)),
    ];
  };

  async function shot(width: number, height: number, format: "png" | "jpeg", quality: number) {
    const answer = await request({ op: "shot", w: width, h: height, format, quality });
    if (answer.width && answer.height) {
      physical = { width: answer.width, height: answer.height };
    }
    return Buffer.from(answer.data ?? "", "base64");
  }

  const moved = () => {
    left = undefined;
    return new ScreenRefusal(
      "The owner moved the mouse, so you stopped. Take a screenshot and ask the owner before " +
        "you go on.",
    );
  };

  async function input(actions: InputAction[], signal: AbortSignal) {
    const cursor = await request({ op: "cursor" });
    let at: Point = [cursor.x ?? 0, cursor.y ?? 0];
    if (left && (Math.abs(left[0] - at[0]) > 2 || Math.abs(left[1] - at[1]) > 2)) {
      throw moved();
    }
    const act = async (body: DriverRequest) => {
      signal.throwIfAborted();
      if (ownerHold) {
        throw new ScreenRefusal("The owner took control of their computer. Wait for them.");
      }
      const answer = await request(body);
      if (answer.refused === "moved") {
        throw moved();
      }
      if (answer.refused === "own_window") {
        throw new ScreenRefusal(ownWindow);
      }
    };
    for (const action of actions) {
      switch (action.type) {
        case "move": {
          const to = toPhysical([action.x, action.y]);
          await act({ op: "move", x: to[0], y: to[1], at });
          at = to;
          break;
        }
        case "click":
          for (let count = 0; count < (action.count ?? 1); count += 1) {
            await act({ op: "button", button: action.button, down: true, at });
            await act({ op: "button", button: action.button, down: false, at });
          }
          break;
        case "down":
        case "up":
          await act({ op: "button", button: action.button, down: action.type === "down", at });
          break;
        case "scroll":
          await act({ op: "scroll", direction: action.direction, amount: action.amount, at });
          break;
        case "wait":
          await new Promise((resolve) => setTimeout(resolve, action.ms));
          break;
        case "key": {
          const keys = virtualKeys(action.keys);
          if (!keys) {
            throw new ScreenRefusal(`This computer has no key for "${action.keys}".`);
          }
          await act({ op: "keys", ...keys, at });
          break;
        }
        case "type":
          await act({ op: "type", text: action.text, at });
          break;
      }
    }
    left = at;
  }

  const screen: Screen = {
    kind: "host",
    get size() {
      return size();
    },
    screenshot: () => shot(size().width, size().height, "png", 0),
    input,
    refuse: (run: BrowserRun) => {
      if (!run.attended) {
        return "The owner's computer is used only while the owner is watching.";
      }
      if (ownerHold) {
        return "The owner has taken control of their computer. Wait for them to hand it back.";
      }
      if (holder && holder.botId !== run.botId && deps.busy(holder.botId)) {
        return "Another bot is using the owner's computer. Try again when it has finished.";
      }
      if (holder?.botId !== run.botId) {
        left = undefined;
      }
      holder = { botId: run.botId };
      return undefined;
    },
  };

  return {
    screen,
    measure,
    // A small JPEG of the display for the owner's live view.
    frame: async () => {
      if (!physical) {
        await measure();
      }
      const shown = size();
      const width = Math.min(960, shown.width);
      const height = Math.round((shown.height * width) / shown.width);
      return { data: (await shot(width, height, "jpeg", 60)).toString("base64"), width, height };
    },
    // The owner takes their computer back: the bot's input stops and its calls are refused.
    hold: (held: boolean) => {
      ownerHold = held;
      left = undefined;
      return held ? holder?.botId : undefined;
    },
    held: () => ownerHold,
    // The bot driving it now, if its run still goes on.
    driving: () => (holder && deps.busy(holder.botId) ? holder.botId : undefined),
    close: () => {
      clearTimeout(idle);
      shutDown();
    },
  };
}

export type HostScreen = ReturnType<typeof createHostScreen>;

export function hostAvailability(enabled: boolean, held: boolean, platform = process.platform) {
  const problem = !enabled
    ? "Only the Bee Bot desktop app can let a bot use this computer."
    : platform !== "win32"
      ? "Bots can use this computer only on Windows for now."
      : null;
  return { available: problem === null, problem, held } satisfies HostControlAvailability;
}
