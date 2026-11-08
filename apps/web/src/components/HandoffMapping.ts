import type { HandoffInput } from "@beebot/contracts";

type Box = { left: number; top: number; width: number; height: number };
type Size = { width: number; height: number };

const buttons = ["left", "middle", "right"] as const;

// The frame is drawn scaled, so a point on it maps back to the page's own CSS pixels.
export function pagePoint(clientX: number, clientY: number, box: Box, frame: Size) {
  const scale = (offset: number, shown: number, real: number) =>
    shown > 0 ? Math.min(real, Math.max(0, (offset * real) / shown)) : 0;
  return {
    x: scale(clientX - box.left, box.width, frame.width),
    y: scale(clientY - box.top, box.height, frame.height),
  };
}

export function mouseInput(
  action: "down" | "up" | "move" | "wheel",
  event: { clientX: number; clientY: number; button: number; deltaX?: number; deltaY?: number },
  box: Box,
  frame: Size,
): HandoffInput {
  const button = action === "down" || action === "up" ? (buttons[event.button] ?? "left") : "none";
  return {
    type: "mouse",
    action,
    button,
    ...pagePoint(event.clientX, event.clientY, box, frame),
    ...(action === "wheel" && { deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0 }),
  };
}

export function keyInput(action: "down" | "up", event: { key: string; code: string }) {
  if (event.key.length === 0 || event.key.length > 32 || event.code.length > 32) {
    return undefined;
  }
  return { type: "key", action, key: event.key, code: event.code } satisfies HandoffInput;
}
