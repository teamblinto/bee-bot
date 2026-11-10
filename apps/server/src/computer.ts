import * as NodeCrypto from "node:crypto";

import { type InputAction, maxTypedText, screenSize, validKeys } from "@beebot/boxd/protocol";
import type { Bot } from "@beebot/contracts";
import { z } from "zod";

import type { Execute } from "./approvals.ts";
import type { AuditRecord } from "./audit.ts";
import type { PolicyDecision } from "./broker.ts";
import { type Activity, ApprovedCall, type BrowserRun, refused } from "./browser.ts";
import type { Desk } from "./browserLease.ts";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };

export type ScreenSize = { width: number; height: number };
export const boxScreen: ScreenSize = screenSize;

// Refuses one action with words for the bot, such as Bee Bot's own window being in the way.
export class ScreenRefusal extends Error {}

// What the computer tools drive: a box's desktop, or the owner's own (`host`). Coordinates are in
// `size`, which is what the bot's screenshots measure. `refuse` answers why the run may not use it
// at all right now.
export type Screen = {
  kind: "box" | "host";
  size: ScreenSize;
  screenshot: () => Promise<Buffer>;
  input: (actions: InputAction[], signal: AbortSignal) => Promise<void>;
  refuse?: (run: BrowserRun) => string | undefined;
};

const where = {
  box: (size: ScreenSize) => `your computer's ${size.width}x${size.height} screen`,
  host: (size: ScreenSize) =>
    `the owner's own computer: its main display, shown to you at ${size.width}x${size.height}`,
};

export function computerTools(size: ScreenSize, kind: Screen["kind"]) {
  const screen = where[kind](size);
  const x = {
    type: "integer",
    minimum: 0,
    maximum: size.width - 1,
    description: `Pixels from the left edge of ${screen}`,
  };
  const y = {
    type: "integer",
    minimum: 0,
    maximum: size.height - 1,
    description: `Pixels from the top edge of ${screen}`,
  };
  const point = {
    type: "array",
    items: { type: "integer" },
    minItems: 2,
    maxItems: 2,
    description: `[x, y] on ${screen}`,
  };
  const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({
    type: "object",
    properties,
    required,
  });
  const hostNote =
    kind === "host"
      ? " The owner is watching and can stop you by moving the mouse. Bee Bot's own window is " +
        "off limits."
      : "";
  return [
    {
      name: "computer_screenshot",
      description: `Returns a PNG screenshot of ${screen}.${hostNote}`,
      inputSchema: object({}),
    },
    {
      name: "computer_click",
      description: "Moves the mouse to x,y on the screen and clicks, then returns a screenshot.",
      inputSchema: object(
        {
          x,
          y,
          button: { type: "string", enum: ["left", "middle", "right"] },
          double: { type: "boolean" },
        },
        ["x", "y"],
      ),
    },
    {
      name: "computer_type",
      description: "Types text where the keyboard focus is, then returns a screenshot.",
      inputSchema: object({ text: { type: "string", maxLength: maxTypedText } }),
    },
    {
      name: "computer_key",
      description:
        'Presses one key or key combination, as X keysym names joined by "+", such as "Return", ' +
        '"ctrl+s" or "ctrl+shift+Tab". Then returns a screenshot.',
      inputSchema: object({ keys: { type: "string" } }),
    },
    {
      name: "computer_scroll",
      description: "Moves the mouse to x,y and turns the scroll wheel, then returns a screenshot.",
      inputSchema: object(
        {
          x,
          y,
          direction: { type: "string", enum: ["up", "down", "left", "right"] },
          amount: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description: "Wheel clicks, 3 if left out",
          },
        },
        ["x", "y", "direction"],
      ),
    },
    {
      name: "computer_drag",
      description:
        "Holds the left mouse button from one point to another, then returns a screenshot.",
      inputSchema: object({ from: point, to: point }),
    },
  ];
}

export const computerToolNames = new Set(computerTools(boxScreen, "box").map(({ name }) => name));

// A `browser` bot's box has a desktop too, but only its browser is the bot's to use or the owner's
// to see.
export const hasBoxDesktop = (bot: Pick<Bot, "control"> | undefined) => bot?.control === "computer";

function argsFor({ width, height }: ScreenSize) {
  const X = z
    .number()
    .int()
    .min(0)
    .max(width - 1);
  const Y = z
    .number()
    .int()
    .min(0)
    .max(height - 1);
  return {
    computer_screenshot: z.object({}),
    computer_click: z.object({
      x: X,
      y: Y,
      button: z.enum(["left", "middle", "right"]).optional(),
      double: z.boolean().optional(),
    }),
    computer_type: z.object({
      text: z
        .string()
        .min(1)
        .max(maxTypedText)
        .refine((text) => !text.includes("\0")),
    }),
    computer_key: z.object({ keys: z.string().refine(validKeys) }),
    computer_scroll: z.object({
      x: X,
      y: Y,
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(20).optional(),
    }),
    computer_drag: z.object({ from: z.tuple([X, Y]), to: z.tuple([X, Y]) }),
  };
}
type Args = ReturnType<typeof argsFor>;
type ComputerTool = keyof Args;
const isComputerTool = (name: string): name is ComputerTool => computerToolNames.has(name);

type Point = { x: number; y: number };
const stepMs = 20;
const buttons = { left: 1, middle: 2, right: 3 } as const;

// xdotool jumps the pointer, so it glides there instead: 8 to 15 eased steps, 160 to 300 ms, for
// the owner to see where the bot is going.
export function glide(from: Point, to: Point): InputAction[] {
  const steps = Math.min(15, Math.max(8, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 60)));
  return Array.from({ length: steps }, (_, index): InputAction[] => {
    const t = (index + 1) / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    return [
      {
        type: "move",
        x: Math.round(from.x + (to.x - from.x) * eased),
        y: Math.round(from.y + (to.y - from.y) * eased),
      },
      { type: "wait", ms: stepMs },
    ];
  }).flat();
}

const text = (value: string): ToolContent[] => [{ type: "text", text: value }];
const unchanged = text("The screen is unchanged since your last screenshot.");

export type ComputerDeps = {
  // The screen this bot's control mode names, or nothing for a bot without one or while it's off.
  screen: (botId: string) => Screen | undefined;
  check: (run: BrowserRun, tool: string, args: unknown) => PolicyDecision;
  appendAudit: (record: AuditRecord) => void;
  requestApproval: (run: BrowserRun, tool: string, args: Record<string, unknown>) => string;
  // The box desktop's lease. The host screen keeps its own hold (hostScreen.ts).
  lease: (botId: string) => Desk;
  // The bot has seen the screen since the owner handed it back.
  observed: (botId: string) => void;
  activity?: (botId: string, activity: Activity) => void;
};

export function createComputer(deps: ComputerDeps) {
  const cursors = new Map<string, Point>();
  // Only the latest screenshot's hash per bot, for its run: no screenshot is ever kept.
  const lastShot = new Map<string, { runId: string; hash: string }>();
  // Aborted when the owner takes control, which ends the bot's input still running.
  const takes = new Map<string, AbortController>();

  function plan(botId: string, size: ScreenSize, tool: ComputerTool, data: unknown) {
    const centre = { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
    const at = cursors.get(botId) ?? centre;
    const args = argsFor(size);
    const show = (kind: Activity["kind"], point: Point, shown: string | null) =>
      deps.activity?.(botId, {
        kind,
        x: point.x / size.width,
        y: point.y / size.height,
        text: shown,
      });
    switch (tool) {
      case "computer_screenshot":
        return { actions: [], show: () => {}, end: at };
      case "computer_click": {
        const { x, y, button = "left", double } = args[tool].parse(data);
        const actions: InputAction[] = [
          ...glide(at, { x, y }),
          { type: "click", button: buttons[button], count: double ? 2 : 1 },
        ];
        return { actions, show: () => show("click", { x, y }, null), end: { x, y } };
      }
      case "computer_type": {
        const { text: typed } = args[tool].parse(data);
        // Nothing tells whether the focused field is a password, so typed text is never shown.
        return {
          actions: [{ type: "type", text: typed } as const],
          show: () => show("type", at, "•••"),
          end: at,
        };
      }
      case "computer_key": {
        const { keys } = args[tool].parse(data);
        return {
          actions: [{ type: "key", keys } as const],
          show: () => show("key", at, keys),
          end: at,
        };
      }
      case "computer_scroll": {
        const { x, y, direction, amount = 3 } = args[tool].parse(data);
        const actions: InputAction[] = [
          ...glide(at, { x, y }),
          { type: "scroll", direction, amount },
        ];
        return { actions, show: () => show("scroll", { x, y }, direction), end: { x, y } };
      }
      case "computer_drag": {
        const {
          from: [fromX, fromY],
          to: [toX, toY],
        } = args[tool].parse(data);
        const from = { x: fromX, y: fromY };
        const to = { x: toX, y: toY };
        const actions: InputAction[] = [
          ...glide(at, from),
          { type: "down", button: 1 },
          ...glide(from, to),
          { type: "up", button: 1 },
        ];
        return { actions, show: () => show("click", to, null), end: to };
      }
    }
  }

  function remember(run: BrowserRun, png: Buffer): ToolContent[] {
    const hash = NodeCrypto.createHash("sha256").update(png).digest("hex");
    const last = lastShot.get(run.botId);
    lastShot.set(run.botId, { runId: run.id, hash });
    if (last?.runId === run.id && last.hash === hash) {
      return unchanged;
    }
    return [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }];
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
    args: unknown,
  ): Promise<{ ok: boolean; content: ToolContent[] }> {
    const screen = deps.screen(run.botId);
    if (!screen) {
      return {
        ok: false,
        content: text(refused("Your computer is off. Ask the owner to turn it on.")),
      };
    }
    const parsed = isComputerTool(tool) ? argsFor(screen.size)[tool].safeParse(args) : undefined;
    if (!isComputerTool(tool) || !parsed?.success) {
      return { ok: false, content: text(refused(`invalid_arguments for ${tool}`)) };
    }
    const refusal = screen.refuse?.(run);
    if (refusal) {
      return refuse(run, tool, "screen_refused", refusal);
    }
    const ownerHasControl = () =>
      refuse(
        run,
        tool,
        "human_has_control",
        screen.kind === "host"
          ? "The owner took over the computer, so you stopped. Take a screenshot and ask the " +
              "owner before you go on."
          : "The owner has control of the computer. Try again later.",
      );
    if (screen.kind === "box") {
      const lease = deps.lease(run.botId);
      if (lease.holder === "human") {
        return ownerHasControl();
      }
      if (lease.mustObserve && tool !== "computer_screenshot") {
        return {
          ok: false,
          content: text(
            refused(
              "The owner just handed the computer back, so what you saw is stale. Take a " +
                "screenshot with computer_screenshot before you act.",
            ),
          ),
        };
      }
    }
    const { actions, show, end } = plan(run.botId, screen.size, tool, parsed.data);
    const take = takes.get(run.botId) ?? new AbortController();
    takes.set(run.botId, take);
    try {
      if (actions.length > 0) {
        show();
        await screen.input(actions, take.signal);
        cursors.set(run.botId, end);
      }
      take.signal.throwIfAborted();
      const png = await screen.screenshot();
      deps.observed(run.botId);
      return { ok: true, content: remember(run, png) };
    } catch (error) {
      if (take.signal.aborted) {
        takes.delete(run.botId);
        return ownerHasControl();
      }
      if (error instanceof ScreenRefusal) {
        return refuse(run, tool, "screen_refused", error.message);
      }
      console.error(`beebotd: computer ${tool} failed: ${(error as Error)?.name}`);
      return { ok: false, content: text(refused("computer_unavailable")) };
    }
  }

  async function call(run: BrowserRun, name: string, args: unknown): Promise<ToolContent[]> {
    const size = deps.screen(run.botId)?.size ?? boxScreen;
    const parsed = isComputerTool(name) ? argsFor(size)[name].safeParse(args ?? {}) : undefined;
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
    call,
    perform,
    // The owner is taking control: the bot's input stops now, not when it finishes.
    interrupt: (botId: string) => {
      takes.get(botId)?.abort();
      takes.delete(botId);
    },
  };
}

export type Computer = ReturnType<typeof createComputer>;

// The owner approved it, so it runs as attended. The screenshot isn't stored with the outcome, so
// the bot looks again.
export function computerExecutors(computer: Pick<Computer, "perform">) {
  const execute: Execute = async ({ botId, runId, tool, payload }) => {
    const { input } = ApprovedCall.parse(JSON.parse(payload));
    const { ok, content } = await computer.perform(
      { id: runId, botId, attended: true },
      tool,
      input,
    );
    const said = content.flatMap((item) => (item.type === "text" ? [item.text] : []));
    return {
      ok,
      output: ok ? `${tool} ran. Take a screenshot to see the screen now.` : said.join("\n"),
    };
  };
  // A screenshot too, for an injected policy that asks about one.
  return [...computerToolNames].map((name) => [name, execute] as const);
}
