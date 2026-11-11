import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import { maxTypedText } from "@beebot/boxd/protocol";
import type { HostFrame } from "@beebot/contracts";
import { z } from "zod";

import type { Execute } from "./approvals.ts";
import type { AuditRecord } from "./audit.ts";
import type { PolicyDecision } from "./broker.ts";
import { ApprovedCall, type BrowserRun, refused } from "./browser.ts";
import { ScreenRefusal, type ToolContent } from "./computer.ts";
import { killTree } from "./engine.ts";
import { keepDriver, ownWindow } from "./hostScreen.ts";

// trycua's cua-driver, over MCP on its stdio. It acts on windows in the background with its own
// cursor, so the owner's pointer, keyboard focus and front window stay theirs.

export type CuaResult = {
  isError: boolean;
  content: ToolContent[];
  structured: Record<string, unknown>;
};

export type CuaDriver = {
  call: (name: string, args: Record<string, unknown>) => Promise<CuaResult>;
  close: () => void;
  // Stops it at once, input half-typed or not, and fails every call waiting on it.
  kill: () => void;
};

const RpcReply = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});
type RpcReply = z.infer<typeof RpcReply>;
const RpcId = z.object({ id: z.number() });

const CallReply = z.object({
  content: z
    .array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
        data: z.string().optional(),
        mimeType: z.string().optional(),
      }),
    )
    .default([]),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

const startTimeoutMs = 15_000;
const callTimeoutMs = 60_000;
// Typing in front goes a key at a time.
const typedCharMs = 50;
const exitGraceMs = 2_000;
const stderrKept = 4096;

export async function spawnCuaDriver(
  exe: string,
  args = ["mcp"],
  timeoutMs = callTimeoutMs,
): Promise<CuaDriver> {
  const child = NodeChildProcess.spawn(exe, args, {
    env: {
      ...process.env,
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
      CUA_DRIVER_RS_UPDATE_CHECK: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-stderrKept);
  });
  const pending = new Map<
    number,
    { resolve: (reply: RpcReply) => void; reject: (error: Error) => void }
  >();
  let gone: Error | undefined;
  const fail = (error: Error) => {
    gone ??= error;
    for (const waiting of pending.values()) {
      waiting.reject(gone);
    }
    pending.clear();
  };
  const kill = () => {
    fail(new Error("cua_driver_stopped"));
    if (child.pid !== undefined && child.exitCode === null) {
      killTree(child.pid);
    }
  };
  // Calls that ran out of time since the last reply. One may just be slow; two in a row is a hang.
  let unanswered = 0;
  NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const id = RpcId.safeParse(message).data?.id;
    const waiting = id === undefined ? undefined : pending.get(id);
    if (id === undefined || !waiting) {
      return;
    }
    unanswered = 0;
    waiting.resolve(
      RpcReply.safeParse(message).data ?? {
        id,
        error: { message: "cua-driver sent a reply Bee couldn't read" },
      },
    );
  });
  child.once("exit", () => fail(new Error("cua_driver_exited")));
  child.once("error", (error) => fail(error));

  const send = (message: object) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  let lastId = 0;
  const request = (method: string, params: object, timeoutMs: number) =>
    new Promise<RpcReply>((resolve, reject) => {
      if (gone) {
        reject(gone);
        return;
      }
      lastId += 1;
      const id = lastId;
      const timer = setTimeout(() => {
        unanswered += 1;
        if (unanswered > 1) {
          kill();
          return;
        }
        pending.delete(id);
        resolve({ id, error: { message: "cua-driver didn't answer in time" } });
      }, timeoutMs);
      pending.set(id, {
        resolve: (reply) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      send({ id, method, params });
    });

  try {
    const init = await request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "beebotd", version: "1" },
      },
      startTimeoutMs,
    );
    if (init.error) {
      throw new Error(`cua_driver: ${init.error.message}`);
    }
  } catch (error) {
    kill();
    const said = stderr.trim();
    throw new Error(`${(error as Error)?.message}${said ? `; stderr: ${said}` : ""}`, {
      cause: error,
    });
  }
  send({ method: "notifications/initialized" });

  return {
    call: async (name, args) => {
      const typed = name === "type_text" && typeof args.text === "string" ? args.text.length : 0;
      const reply = await request(
        "tools/call",
        { name, arguments: args },
        timeoutMs + typed * typedCharMs,
      );
      if (reply.error) {
        return { isError: true, content: text(reply.error.message), structured: {} };
      }
      const parsed = CallReply.safeParse(reply.result);
      if (!parsed.success) {
        return {
          isError: true,
          content: text("cua-driver sent a reply Bee couldn't read"),
          structured: {},
        };
      }
      const { content, isError = false, structuredContent = {} } = parsed.data;
      return {
        isError,
        content: content.flatMap((item): ToolContent[] => {
          if (item.type === "text" && item.text !== undefined) {
            return [{ type: "text", text: item.text }];
          }
          if (item.type === "image" && item.mimeType === "image/png" && item.data) {
            return [{ type: "image", data: item.data, mimeType: "image/png" }];
          }
          return [];
        }),
        structured: structuredContent,
      };
    },
    kill,
    // End of input is its order to stop.
    close: () => {
      child.stdin.end();
      const timer = setTimeout(kill, exitGraceMs);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    },
  };
}

const text = (value: string): ToolContent[] => [{ type: "text", text: value }];

// Seconds since the owner last used the mouse or keyboard, as the desktop last said, and when.
export type IdleReading = { idleSeconds: number; at: number };

const pauseSeconds = 3;
const freshMs = 2_000;
const slackMs = 500;

// The bot's own foreground input resets the computer's idle time too, so the owner also counts as
// paused when a reading taken after that input says nothing has come since, near enough.
export function ownerPaused(reading: IdleReading, now: number, ownInputEnded?: number) {
  if (now - reading.at > freshMs) {
    return false;
  }
  return (
    reading.idleSeconds >= pauseSeconds ||
    (ownInputEnded !== undefined &&
      reading.at > ownInputEnded &&
      reading.idleSeconds * 1000 >= now - ownInputEnded - slackMs)
  );
}

const WindowId = z.number().int().positive();
const Element = z
  .string()
  .regex(/^[\w-]+:\d+$/)
  .describe('An element token from computer_look, such as "s00000003:12"');
const Pixel = z.number().int().min(0).max(20_000);
const Keys = z
  .string()
  .regex(/^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/)
  .describe(
    'A key or combination joined by "+": return, tab, escape, space, backspace, delete, up, ' +
      "down, left, right, home, end, pageup, pagedown, f1-f12, a letter or digit, with ctrl, " +
      'shift, alt or win, such as "ctrl+s"',
  );

const args = {
  computer_windows: z.object({
    app: z.string().min(1).max(200).optional().describe("Only this app's windows"),
  }),
  computer_open: z.object({
    app: z
      .string()
      .min(1)
      .max(1024)
      .describe('An app name such as "notepad", or the full path of an .exe'),
  }),
  computer_look: z.object({
    window_id: WindowId,
    query: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Keeps only the controls whose text contains this"),
    screenshot: z
      .boolean()
      .optional()
      .describe("Adds a picture of the window, which clicking by x,y needs"),
  }),
  computer_desktop: z.object({}),
  computer_window_click: z
    .object({
      element: Element.optional(),
      window_id: WindowId.optional(),
      x: Pixel.optional().describe("With window_id: pixels in that window's computer_look picture"),
      y: Pixel.optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
      double: z.boolean().optional(),
    })
    .refine(
      ({ element, window_id, x, y }) =>
        element !== undefined || (window_id !== undefined && x !== undefined && y !== undefined),
    ),
  computer_window_type: z.object({
    element: Element,
    text: z
      .string()
      .min(1)
      .max(maxTypedText)
      .refine((typed) => !typed.includes("\0")),
    replace: z.boolean().optional().describe("Sets the control's whole value to text instead"),
  }),
  computer_window_key: z
    .object({ keys: Keys, element: Element.optional(), window_id: WindowId.optional() })
    .refine(({ element, window_id }) => element !== undefined || window_id !== undefined),
  computer_window_scroll: z.object({
    window_id: WindowId,
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().int().min(1).max(20).optional().describe("Lines, 3 if left out"),
  }),
  computer_window_drag: z.object({
    window_id: WindowId,
    from: z.tuple([Pixel, Pixel]).describe("[x, y] in the window's computer_look picture"),
    to: z.tuple([Pixel, Pixel]),
  }),
};
type CuaTool = keyof typeof args;

const background =
  " It works in the background: the owner's pointer and front window stay theirs, and you never " +
  "need to bring a window to the front.";
const descriptions: Record<CuaTool, string> = {
  computer_windows:
    "Lists the open windows on the owner's computer, each with its window_id, app and title. " +
    "Start here: find the window you need, or open its app with computer_open. Then look at it " +
    "with computer_look and act on its controls. Bee Bot's own window is off limits.",
  computer_open:
    "Opens an app on the owner's computer without bringing it to the front, and lists its " +
    "windows.",
  computer_look:
    "Reads one window, even one behind others: its controls as a tree, each actionable one " +
    'tagged [N] and acted on by its element token, "<snapshot_id>:N". Look again after the ' +
    "window changes, since tokens from an older look go stale.",
  computer_desktop:
    "Returns a picture of the owner's whole screen, to see what is open. To act, find the " +
    "window with computer_windows and look at it with computer_look.",
  computer_window_click:
    "Clicks a control by its element token. Only for something with no control, such as a " +
    "canvas, pass window_id and x,y in that window's computer_look picture instead." +
    background,
  computer_window_type:
    "Types text into a control by its element token. With replace, sets the control's whole " +
    "value instead, which also works where typing doesn't." +
    background,
  computer_window_key:
    "Presses a key or key combination in a window, or at one of its controls by element token." +
    background,
  computer_window_scroll: `Scrolls a window.${background}`,
  computer_window_drag:
    "Drags with the left mouse button between two points in a window, in its computer_look " +
    `picture.${background}`,
};

function schemaOf(tool: CuaTool) {
  const { $schema: _, ...schema } = z.toJSONSchema(args[tool], { io: "input" });
  return schema;
}

export const cuaTools = (Object.keys(args) as CuaTool[]).map((name) => ({
  name,
  description: descriptions[name],
  inputSchema: schemaOf(name),
}));
export const cuaToolNames: ReadonlySet<string> = new Set(Object.keys(args));
const isCuaTool = (name: string): name is CuaTool => cuaToolNames.has(name);

// Its words name its own tools. These are the ones the bot has instead.
const ownNames: Record<string, string> = {
  list_windows: "computer_windows",
  launch_app: "computer_open",
  get_window_state: "computer_look",
  get_desktop_state: "computer_desktop",
  type_text: "computer_window_type",
  set_value: "computer_window_type",
  press_key: "computer_window_key",
  hotkey: "computer_window_key",
};
const renamed = (content: ToolContent[]) =>
  content.map((item) =>
    item.type === "text"
      ? {
          ...item,
          text: item.text.replace(
            /\b(list_windows|launch_app|get_window_state|get_desktop_state|type_text|set_value|press_key|hotkey)\b/g,
            (name) => ownNames[name] ?? name,
          ),
        }
      : item,
  );

const backgroundRefused = (result: CuaResult) =>
  result.isError &&
  (result.content.some(
    (item) => item.type === "text" && item.text.includes("Background delivery is not available"),
  ) ||
    JSON.stringify(result.structured).includes('"background_unavailable"'));

const staleToken = (result: CuaResult) =>
  result.isError &&
  result.content.some(
    (item) => item.type === "text" && item.text.includes("element_token is stale or unknown"),
  );

const controlChanged =
  "That control changed since it was looked at, so nothing was done. Look at the window again " +
  "with computer_look.";

const noPause =
  "This app takes typing, keys and scrolling only while it is in front, and the owner kept " +
  "using the computer, so it wasn't brought forward. Set a field with computer_window_type and " +
  "replace, click its controls instead, or try again in a moment.";

// A shell or script host runs whatever it is handed, past the owner's approval of commands. So do
// scripts, and shortcuts with arguments of their own.
const shells =
  /\b(cmd|command prompt|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|bash|wsl|conhost)\b|\.(bat|cmd|ps1|vbs|js|wsf|hta|lnk)$/;
const opensShell = (app: string) => shells.test((app.split(/[\\/]/).at(-1) ?? "").toLowerCase());

const shellRefused =
  "Bee doesn't open shells, script hosts or scripts on the owner's computer. Open the app itself.";

// Keys that act on the whole computer, not the window, when sent in front.
const systemKeys = new Set(["win", "windows", "lwin", "rwin", "meta", "super", "cmd", "command"]);
const systemCombos = [
  ["alt", "tab"],
  ["alt", "f4"],
  ["ctrl", "alt", "del"],
  ["ctrl", "alt", "delete"],
  ["ctrl", "shift", "esc"],
  ["ctrl", "shift", "escape"],
  ["ctrl", "esc"],
  ["ctrl", "escape"],
];
function systemWide(parts: string[]) {
  const pressed = new Set(parts.map((part) => (part === "control" ? "ctrl" : part)));
  return (
    parts.some((part) => systemKeys.has(part)) ||
    systemCombos.some((combo) => combo.every((key) => pressed.has(key)))
  );
}

const systemRefused =
  "This window takes keys only while it is in front, and there that combination would act on " +
  "the owner's whole computer, so it wasn't sent.";

const WindowRow = z.object({
  window_id: z.number(),
  pid: z.number(),
  title: z.string().optional(),
  window_title: z.string().optional(),
  app_name: z.string().optional(),
});
type Window = { pid: number; title: string; app: string };
const Windows = z.object({ windows: z.array(WindowRow) });
const Snapshot = WindowRow.extend({
  snapshot_id: z.string(),
  tree_markdown: z.string().optional(),
});
const Picture = z.object({ screenshot_width: z.number(), screenshot_height: z.number() });

const maxSnapshots = 100;
const pollMs = 250;
const waitMs = 30_000;
const lookImage = 1280;
const frameImage = 960;
const previewSession = "bee-preview";

export type CuaScreenDeps = {
  start: () => Promise<CuaDriver>;
  // Shared with the PowerShell screen: consent, a watching owner, their hold, one bot at a time.
  refuse: (run: BrowserRun) => string | undefined;
  check: (run: BrowserRun, tool: string, args: unknown) => PolicyDecision;
  appendAudit: (record: AuditRecord) => void;
  requestApproval: (run: BrowserRun, tool: string, args: Record<string, unknown>) => string;
  idle: () => IdleReading | undefined;
  // Bee Bot's own executable name, such as "bee bot.exe", and its processes, whose windows are off
  // limits. Electron's main process owns the app's windows.
  ownApp: string;
  ownPids: number[];
  idleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const retryStartMs = 60_000;

export function createCuaScreen(deps: CuaScreenDeps) {
  const driver = keepDriver(deps.start, deps.idleMs);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const windows = new Map<number, Window>();
  const snapshots = new Map<string, { windowId: number; rows: Map<number, string> }>();
  let ownInputEnded: number | undefined;
  let failedStartAt: number | undefined;
  // The drivers a bot's actions wait on now, one entry per action.
  const acting: CuaDriver[] = [];

  const drive = (name: string, driverArgs: Record<string, unknown>) =>
    driver.use((open) => open.call(name, driverArgs));
  const driveAction = (name: string, driverArgs: Record<string, unknown>) =>
    driver.use(async (open) => {
      acting.push(open);
      try {
        return await open.call(name, driverArgs);
      } finally {
        acting.splice(acting.indexOf(open), 1);
      }
    });

  function learn(result: CuaResult) {
    const listed = Windows.safeParse(result.structured).data?.windows;
    const read = Snapshot.safeParse(result.structured).data;
    if (listed) {
      windows.clear();
    }
    const rows = listed ?? [];
    for (const row of read ? [...rows, read] : rows) {
      windows.set(row.window_id, {
        pid: row.pid,
        title: row.title ?? row.window_title ?? "",
        app: row.app_name ?? "",
      });
    }
    if (read) {
      const tagged = (read.tree_markdown ?? "").split("\n").flatMap((line) => {
        const match = /\[(\d+)\] (.+?)(?: \[[a-z_]+=.*)?$/.exec(line);
        return match?.[1] && match[2] ? [[Number(match[1]), match[2]] as const] : [];
      });
      snapshots.set(read.snapshot_id, { windowId: read.window_id, rows: new Map(tagged) });
      for (const old of snapshots.keys()) {
        if (snapshots.size <= maxSnapshots) {
          break;
        }
        snapshots.delete(old);
      }
    }
  }

  async function windowOf(session: string, windowId: number) {
    if (!windows.has(windowId)) {
      learn(await drive("list_windows", { session }));
    }
    const found = windows.get(windowId);
    if (!found) {
      throw new ScreenRefusal(`No window ${windowId} is open. Find it with computer_windows.`);
    }
    if (found.app.toLowerCase() === deps.ownApp.toLowerCase() || deps.ownPids.includes(found.pid)) {
      throw new ScreenRefusal(ownWindow);
    }
    return found;
  }

  function elementOf(token: string) {
    const snapshot = snapshots.get(token.split(":")[0] ?? "");
    if (!snapshot) {
      throw new ScreenRefusal(
        "That element token is from a look Bee doesn't know. Look at the window again with " +
          "computer_look.",
      );
    }
    return snapshot;
  }

  const windowName = (id: number) => {
    const found = windows.get(id);
    return found?.title ? `"${found.title}"` : found?.app || `window ${id}`;
  };
  function elementName(token: string) {
    const snapshot = snapshots.get(token.split(":")[0] ?? "");
    const row = snapshot?.rows.get(Number(token.split(":")[1]));
    const where = snapshot ? ` in ${windowName(snapshot.windowId)}` : "";
    return `${row ?? `element ${token}`}${where}`;
  }

  // What an action did, in words for the owner, who reads an approved action's outcome too.
  function done(tool: string, input: unknown) {
    if (!isCuaTool(tool)) {
      return undefined;
    }
    switch (tool) {
      case "computer_window_click": {
        const parsed = args[tool].safeParse(input).data;
        return (
          parsed &&
          (parsed.element !== undefined
            ? `Clicked ${elementName(parsed.element)}`
            : `Clicked in ${windowName(parsed.window_id ?? 0)}`)
        );
      }
      case "computer_window_type": {
        const parsed = args[tool].safeParse(input).data;
        const window = parsed && snapshots.get(parsed.element.split(":")[0] ?? "")?.windowId;
        return (
          parsed &&
          (parsed.replace
            ? `Set ${elementName(parsed.element)}`
            : `Typed into ${window === undefined ? "the window" : windowName(window)}`)
        );
      }
      case "computer_window_key": {
        const parsed = args[tool].safeParse(input).data;
        return parsed && `Pressed ${parsed.keys}`;
      }
      case "computer_window_scroll": {
        const parsed = args[tool].safeParse(input).data;
        return parsed && `Scrolled ${parsed.direction} in ${windowName(parsed.window_id)}`;
      }
      case "computer_window_drag": {
        const parsed = args[tool].safeParse(input).data;
        return parsed && `Dragged in ${windowName(parsed.window_id)}`;
      }
      // What these return is what the bot asked for, such as the window ids an opened app got.
      default:
        return undefined;
    }
  }

  // In words for the owner's approval card. Titles and labels come from the screen, so the exact
  // element token or window id stays beside them.
  function describe(tool: string, input: unknown) {
    if (!isCuaTool(tool)) {
      return undefined;
    }
    switch (tool) {
      case "computer_windows":
      case "computer_look":
      case "computer_desktop":
        return undefined;
      case "computer_open": {
        const parsed = args[tool].safeParse(input).data;
        return parsed && `Open ${JSON.stringify(parsed.app)}`;
      }
      case "computer_window_click": {
        const parsed = args[tool].safeParse(input).data;
        if (!parsed) {
          return undefined;
        }
        const verb = parsed.double
          ? "Double-click"
          : parsed.button === "right"
            ? "Right-click"
            : "Click";
        const middle = parsed.button === "middle" ? " with the middle button" : "";
        return parsed.element !== undefined
          ? `${verb} ${elementName(parsed.element)}${middle}\n(element ${parsed.element})`
          : `${verb} at ${parsed.x},${parsed.y} in ${windowName(parsed.window_id ?? 0)}${middle}\n(window ${parsed.window_id})`;
      }
      case "computer_window_type": {
        const parsed = args[tool].safeParse(input).data;
        return (
          parsed &&
          (parsed.replace
            ? `Set ${elementName(parsed.element)} to ${JSON.stringify(parsed.text)}`
            : `Type ${JSON.stringify(parsed.text)} into ${elementName(parsed.element)}`) +
            `\n(element ${parsed.element})`
        );
      }
      case "computer_window_key": {
        const parsed = args[tool].safeParse(input).data;
        if (!parsed) {
          return undefined;
        }
        return parsed.element !== undefined
          ? `Press ${parsed.keys} at ${elementName(parsed.element)}\n(element ${parsed.element})`
          : `Press ${parsed.keys} in ${windowName(parsed.window_id ?? 0)}\n(window ${parsed.window_id})`;
      }
      case "computer_window_scroll": {
        const parsed = args[tool].safeParse(input).data;
        return (
          parsed &&
          `Scroll ${parsed.direction} ${parsed.amount ?? 3} in ${windowName(parsed.window_id)}\n(window ${parsed.window_id})`
        );
      }
      case "computer_window_drag": {
        const parsed = args[tool].safeParse(input).data;
        return (
          parsed &&
          `Drag from ${parsed.from.join(",")} to ${parsed.to.join(",")} in ${windowName(parsed.window_id)}\n(window ${parsed.window_id})`
        );
      }
    }
  }

  // Background input some windows drop, such as Chromium's typing, is sent in front once the owner
  // pauses. Undefined when it may go, or words for the bot when it may not.
  async function waitForPause(run: BrowserRun) {
    const deadline = now() + waitMs;
    for (;;) {
      const refusal = deps.refuse(run);
      if (refusal) {
        throw new ScreenRefusal(refusal);
      }
      const reading = deps.idle();
      if (!reading) {
        return noPause;
      }
      if (ownerPaused(reading, now(), ownInputEnded)) {
        return undefined;
      }
      if (now() >= deadline) {
        return noPause;
      }
      await sleep(pollMs);
    }
  }

  async function act(run: BrowserRun, tool: CuaTool, input: unknown): Promise<CuaResult> {
    const session = run.id;
    const failed = (words: string): CuaResult => ({
      isError: true,
      content: text(words),
      structured: {},
    });
    const inFrontOnce = async (name: string, driverArgs: Record<string, unknown>) => {
      const refusal = await waitForPause(run);
      if (refusal) {
        return failed(refusal);
      }
      try {
        return await driveAction(name, { session, ...driverArgs, delivery_mode: "foreground" });
      } finally {
        ownInputEnded = now();
      }
    };
    // The driver forgets a window's older element tokens once it is looked at again, as it may be
    // while the owner decides. The control at the same index in a fresh look, with the same role
    // and label, is the one meant, so the call goes once more with its new token.
    const renew = async (token: string) => {
      const index = Number(token.split(":")[1]);
      const was = elementOf(token);
      const read = await drive("get_window_state", {
        session,
        ...(await target(was.windowId)),
        include_screenshot: false,
      });
      learn(read);
      const fresh = Snapshot.safeParse(read.structured).data?.snapshot_id;
      const row = was.rows.get(index);
      return fresh !== undefined &&
        row !== undefined &&
        snapshots.get(fresh)?.rows.get(index) === row
        ? `${fresh}:${index}`
        : undefined;
    };
    // `inFront` is whether input the window drops in the background may go in front, or why not.
    // `window` is the one it acts on, forgotten when the call fails, since it may have closed.
    const send = async (
      name: string,
      driverArgs: Record<string, unknown>,
      { inFront = false, window }: { inFront?: boolean | string; window?: number } = {},
    ) => {
      let sent = await driveAction(name, { session, ...driverArgs });
      const token = driverArgs.element_token;
      if (typeof token === "string" && staleToken(sent)) {
        const fresh = await renew(token);
        if (fresh === undefined) {
          return failed(controlChanged);
        }
        driverArgs = { ...driverArgs, element_token: fresh };
        sent = await driveAction(name, { session, ...driverArgs });
      }
      if (inFront !== false && backgroundRefused(sent)) {
        sent = typeof inFront === "string" ? failed(inFront) : await inFrontOnce(name, driverArgs);
      }
      if (sent.isError && window !== undefined) {
        windows.delete(window);
      }
      return sent;
    };
    const target = async (windowId: number) => ({
      pid: (await windowOf(session, windowId)).pid,
      window_id: windowId,
    });
    switch (tool) {
      case "computer_windows": {
        const { app } = args[tool].parse(input);
        return send("list_windows", app === undefined ? {} : { app });
      }
      case "computer_open": {
        const { app } = args[tool].parse(input);
        if (opensShell(app)) {
          throw new ScreenRefusal(shellRefused);
        }
        return send("launch_app", /[\\/]/.test(app) ? { path: app } : { name: app });
      }
      case "computer_look": {
        const { window_id, query, screenshot = false } = args[tool].parse(input);
        return send(
          "get_window_state",
          {
            ...(await target(window_id)),
            include_screenshot: screenshot,
            max_image_dimension: lookImage,
            ...(query !== undefined && { query }),
          },
          { window: window_id },
        );
      }
      case "computer_desktop":
        return send("get_desktop_state", { max_image_dimension: lookImage });
      case "computer_window_click": {
        const { element, window_id, x, y, button = "left", double } = args[tool].parse(input);
        const window = element !== undefined ? elementOf(element).windowId : (window_id ?? 0);
        const { pid } = await windowOf(session, window);
        const at =
          element !== undefined ? { element_token: element } : { pid, window_id: window, x, y };
        return send("click", { ...at, button, count: double ? 2 : 1 }, { window });
      }
      case "computer_window_type": {
        const { element, text: typed, replace } = args[tool].parse(input);
        const window = elementOf(element).windowId;
        await windowOf(session, window);
        return replace
          ? send("set_value", { element_token: element, value: typed }, { window })
          : send("type_text", { element_token: element, text: typed }, { inFront: true, window });
      }
      case "computer_window_key": {
        const { keys, element, window_id } = args[tool].parse(input);
        const at =
          element !== undefined
            ? { element_token: element, window_id: elementOf(element).windowId }
            : await target(window_id ?? 0);
        await windowOf(session, at.window_id);
        const parts = keys.toLowerCase().split("+");
        const pressed = parts.length === 1 ? { key: parts[0] } : { keys: parts };
        const sent = element !== undefined ? { element_token: element } : at;
        return send(
          parts.length === 1 ? "press_key" : "hotkey",
          { ...sent, ...pressed },
          { inFront: systemWide(parts) ? systemRefused : true, window: at.window_id },
        );
      }
      case "computer_window_scroll": {
        const { window_id, direction, amount = 3 } = args[tool].parse(input);
        return send(
          "scroll",
          { ...(await target(window_id)), direction, amount },
          { inFront: true, window: window_id },
        );
      }
      case "computer_window_drag": {
        const { window_id, from, to } = args[tool].parse(input);
        return send(
          "drag",
          {
            ...(await target(window_id)),
            from_x: from[0],
            from_y: from[1],
            to_x: to[0],
            to_y: to[1],
          },
          { window: window_id },
        );
      }
    }
  }

  function refuse(run: BrowserRun, tool: string, reason: string, words: string) {
    deps.appendAudit({
      runId: run.id,
      botId: run.botId,
      status: "refused",
      reason,
      tool,
      initiator: "bot",
      attended: run.attended,
    });
    return { ok: false, content: text(refused(words)) };
  }

  // Acts without asking the broker: for a call it allowed, or one the owner approved.
  async function perform(
    run: BrowserRun,
    tool: string,
    input: unknown,
  ): Promise<{ ok: boolean; content: ToolContent[] }> {
    if (!isCuaTool(tool) || !args[tool].safeParse(input).success) {
      return { ok: false, content: text(refused(`invalid_arguments for ${tool}`)) };
    }
    const refusal = deps.refuse(run);
    if (refusal) {
      return refuse(run, tool, "screen_refused", refusal);
    }
    try {
      const result = await act(run, tool, input);
      learn(result);
      return { ok: !result.isError, content: renamed(result.content) };
    } catch (error) {
      if (error instanceof ScreenRefusal) {
        return refuse(run, tool, "screen_refused", error.message);
      }
      // Taking control stops the driver mid-action.
      const stopped = deps.refuse(run);
      if (stopped) {
        return refuse(run, tool, "screen_refused", stopped);
      }
      console.error(`beebotd: computer ${tool} failed: ${(error as Error)?.message}`);
      return { ok: false, content: text(refused("computer_unavailable")) };
    }
  }

  async function call(run: BrowserRun, name: string, input: unknown): Promise<ToolContent[]> {
    const parsed = isCuaTool(name) ? args[name].safeParse(input ?? {}) : undefined;
    if (!parsed?.success) {
      return text(refused(`invalid_arguments for ${name}`));
    }
    const data: Record<string, unknown> = parsed.data;
    const decision = deps.check(run, name, data);
    if (decision.kind === "deny" || decision.kind === "hand_off") {
      return text(refused(decision.reason));
    }
    if (decision.kind === "approve") {
      return text(deps.requestApproval(run, name, data));
    }
    return (await perform(run, name, data)).content;
  }

  return {
    // Whether the driver runs. One that won't start leaves This PC to the PowerShell driver for a
    // while before it is tried again.
    ready: async () => {
      if (failedStartAt !== undefined && now() - failedStartAt < retryStartMs) {
        return false;
      }
      try {
        await driver.use(async () => {});
        failedStartAt = undefined;
        return true;
      } catch (error) {
        failedStartAt = now();
        console.error(
          `beebotd: cua-driver didn't start (${(error as Error)?.message}), so bots on This PC ` +
            "move the owner's own pointer instead",
        );
        return false;
      }
    },
    call,
    perform,
    describe,
    done,
    // The owner took control: whatever a bot is doing through the driver stops now. The next call
    // starts a fresh one.
    interrupt: () => {
      for (const open of new Set(acting)) {
        open.kill();
      }
    },
    frame: async (): Promise<HostFrame> => {
      const shot = await drive("get_desktop_state", {
        session: previewSession,
        max_image_dimension: frameImage,
      });
      const image = shot.content.find((item) => item.type === "image");
      const size = Picture.safeParse(shot.structured).data;
      if (!image || !size) {
        throw new Error("cua_driver: no picture of the desktop");
      }
      return {
        data: image.data,
        width: size.screenshot_width,
        height: size.screenshot_height,
        mime: "image/png",
      };
    },
    close: driver.close,
  };
}

export type CuaScreen = ReturnType<typeof createCuaScreen>;

// The owner approved it, so it runs as attended.
export function cuaExecutors(screen: Pick<CuaScreen, "perform" | "done">) {
  const execute: Execute = async ({ botId, runId, tool, payload }) => {
    const { input } = ApprovedCall.parse(JSON.parse(payload));
    const { ok, content } = await screen.perform({ id: runId, botId, attended: true }, tool, input);
    const said = content.flatMap((item) => (item.type === "text" ? [item.text] : []));
    return { ok, output: (ok && screen.done(tool, input)) || said.join("\n") };
  };
  return [...cuaToolNames].map((name) => [name, execute] as const);
}
