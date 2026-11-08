import { describe, expect, it } from "vite-plus/test";

import { keyInput, mouseInput, pagePoint } from "./HandoffMapping";

const box = { left: 100, top: 50, width: 640, height: 400 };
const frame = { width: 1280, height: 800 };

describe("handoff input mapping", () => {
  it("maps a point on the scaled frame back to page pixels", () => {
    expect(pagePoint(420, 250, box, frame)).toEqual({ x: 640, y: 400 });
    expect(pagePoint(0, 0, box, frame)).toEqual({ x: 0, y: 0 });
    expect(pagePoint(5000, 5000, box, frame)).toEqual({ x: 1280, y: 800 });
  });

  it("names the button only for a press or release", () => {
    const event = { clientX: 100, clientY: 50, button: 2 };
    expect(mouseInput("down", event, box, frame)).toMatchObject({ button: "right" });
    expect(mouseInput("move", event, box, frame)).toMatchObject({ button: "none" });
    expect(mouseInput("wheel", { ...event, deltaY: 120 }, box, frame)).toMatchObject({
      button: "none",
      deltaY: 120,
    });
  });

  it("drops keys the server would refuse", () => {
    expect(keyInput("down", { key: "a", code: "KeyA" })).toEqual({
      type: "key",
      action: "down",
      key: "a",
      code: "KeyA",
    });
    expect(keyInput("down", { key: "x".repeat(33), code: "" })).toBeUndefined();
  });
});
