import * as NodeCrypto from "node:crypto";

import { type InputAction, maxTypedText, screenSize, validKeys } from "@beebot/boxd/protocol";
import { z } from "zod";

import type { Execute } from "./approvals.ts";
import type { AuditRecord } from "./audit.ts";
import type { BoxRuntime } from "./boxRuntime.ts";
import type { PolicyDecision } from "./broker.ts";
import { type Activity, ApprovedCall, type BrowserRun, refused } from "./browser.ts";
import type { Lease } from "./browserLease.ts";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };

const x = {
  type: "integer",
  minimum: 0,
  maximum: screenSize.width - 1,
  description: "Pixels from the left edge of the 1280x800 screen",
};
const y = {
  type: "integer",
  minimum: 0,
  maximum: screenSize.height - 1,
  description: "Pixels from the top edge of the 1280x800 screen",
};
const point = {
  type: "array",
  items: { type: "integer" },
  minItems: 2,
  maxItems: 2,
  description: "[x, y] on the 1280x800 screen",
};
const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
});

export const computerTools = [
  {
    name: "computer_screenshot",
    description: "Returns a 1280x800 PNG screenshot of your computer's whole screen.",
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

export const computerToolNames = new Set(computerTools.map(({ name }) => name));

const X = z
  .number()
  .int()
  .min(0)
  .max(screenSize.width - 1);
const Y = z
  .number()
  .int()
  .min(0)
  .max(screenSize.height - 1);
const Args = {
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
type ComputerTool = keyof typeof Args;
const isComputerTool = (name: string): name is ComputerTool => Object.hasOwn(Args, name);

type Point = { x: number; y: number };
const centre: Point = { x: screenSize.width / 2, y: screenSize.height / 2 };
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
  // A box bot's desktop, or nothing for a bot without one.
  screen: (botId: string) => Pick<BoxRuntime, "screenshot" | "input"> | undefined;
  check: (run: BrowserRun, tool: string, args: unknown) => PolicyDecision;
  appendAudit: (record: AuditRecord) => void;
  requestApproval: (run: BrowserRun, tool: string, args: Record<string, unknown>) => string;
  lease: (botId: string) => Lease | undefined;
  // The bot has seen the screen since the owner handed it back.
  observed: (botId: string) => void;
  activity?: (botId: string, activity: Activity) => void;
};

export function createComputer(deps: ComputerDeps) {
  const cursors = new Map<string, Point>();
  // Only the latest screenshot's hash per bot, for its run: no screenshot is ever kept.
  const lastShot = new Map<string, { runId: string; hash: string }>();

  function plan(botId: string, tool: ComputerTool, data: Record<string, unknown>) {
    const at = cursors.get(botId) ?? centre;
    const show = (kind: Activity["kind"], point: Point, shown: string | null) =>
      deps.activity?.(botId, {
        kind,
        x: point.x / screenSize.width,
        y: point.y / screenSize.height,
        text: shown,
      });
    switch (tool) {
      case "computer_screenshot":
        return { actions: [], show: () => {}, end: at };
      case "computer_click": {
        const { x, y, button = "left", double } = Args[tool].parse(data);
        const actions: InputAction[] = [
          ...glide(at, { x, y }),
          { type: "click", button: buttons[button], count: double ? 2 : 1 },
        ];
        return { actions, show: () => show("click", { x, y }, null), end: { x, y } };
      }
      case "computer_type": {
        const { text: typed } = Args[tool].parse(data);
        // Nothing tells whether the focused field is a password, so typed text is never shown.
        return {
          actions: [{ type: "type", text: typed } as const],
          show: () => show("type", at, "•••"),
          end: at,
        };
      }
      case "computer_key": {
        const { keys } = Args[tool].parse(data);
        return {
          actions: [{ type: "key", keys } as const],
          show: () => show("key", at, keys),
          end: at,
        };
      }
      case "computer_scroll": {
        const { x, y, direction, amount = 3 } = Args[tool].parse(data);
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
        } = Args[tool].parse(data);
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

  // Acts without asking the broker: for a call it allowed, or one the owner approved.
  async function perform(
    run: BrowserRun,
    tool: string,
    args: unknown,
  ): Promise<{ ok: boolean; content: ToolContent[] }> {
    const parsed = isComputerTool(tool) ? Args[tool].safeParse(args) : undefined;
    if (!isComputerTool(tool) || !parsed?.success) {
      return { ok: false, content: text(refused(`invalid_arguments for ${tool}`)) };
    }
    const screen = deps.screen(run.botId);
    if (!screen) {
      return { ok: false, content: text(refused("Only a bot in a box has a computer.")) };
    }
    const lease = deps.lease(run.botId);
    if (lease?.holder === "human") {
      deps.appendAudit({
        runId: run.id,
        botId: run.botId,
        status: "refused",
        reason: "human_has_control",
        tool,
        initiator: "bot",
        attended: run.attended,
      });
      return {
        ok: false,
        content: text(refused("The owner has control of the computer. Try again later.")),
      };
    }
    if (lease?.mustObserve && tool !== "computer_screenshot") {
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
    const { actions, show, end } = plan(run.botId, tool, parsed.data);
    try {
      if (actions.length > 0) {
        show();
        await screen.input(run.botId, actions);
        cursors.set(run.botId, end);
      }
      const png = await screen.screenshot(run.botId);
      deps.observed(run.botId);
      return { ok: true, content: remember(run, png) };
    } catch (error) {
      console.error(`beebotd: computer ${tool} failed: ${(error as Error)?.name}`);
      return { ok: false, content: text(refused("computer_unavailable")) };
    }
  }

  async function call(run: BrowserRun, name: string, args: unknown): Promise<ToolContent[]> {
    const parsed = isComputerTool(name) ? Args[name].safeParse(args ?? {}) : undefined;
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

  return { call, perform };
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
  // A screenshot too: an Operator's first one adds the untrusted-read leg, so it asks.
  return computerTools.map(({ name }) => [name, execute] as const);
}
