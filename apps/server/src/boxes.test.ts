import { describe, expect, it } from "vite-plus/test";

import { recordingBoxRuntime } from "./boxes.ts";
import { createFakeBoxRuntime } from "./boxRuntime.ts";

describe("recorded box runtime", () => {
  it("records each step and the state boxd reports after it", async () => {
    const seen: [string, string | null][] = [];
    const runtime = recordingBoxRuntime(createFakeBoxRuntime(), (_botId, state, reason = null) =>
      seen.push([state, reason]),
    );
    await runtime.create("b");
    await runtime.start("b");
    await runtime.stop("b");
    await expect(runtime.create("b")).rejects.toThrow("box b is stopped");
    expect(seen).toEqual([
      ["creating", null],
      ["stopped", null],
      ["starting", null],
      ["running", null],
      ["stopped", null],
      ["creating", null],
      ["stopped", "box b is stopped"],
    ]);
  });

  it("marks a box that never came up as failed", async () => {
    const seen: [string, string | null][] = [];
    const runtime = recordingBoxRuntime(createFakeBoxRuntime(), (_botId, state, reason = null) =>
      seen.push([state, reason]),
    );
    await expect(runtime.start("b")).rejects.toThrow();
    expect(seen.at(-1)).toEqual(["failed", "box b is absent"]);
  });
});
