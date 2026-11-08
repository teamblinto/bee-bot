import { once } from "node:events";

import { describe, expect, it } from "vite-plus/test";

import { createFakeBoxRuntime } from "./boxRuntime.ts";

const node = (script: string) => ({
  argv: [process.execPath, "-e", script],
  env: { PATH: process.env.PATH ?? "" },
});

describe("fake box runtime", () => {
  it("attaches only to a running box", async () => {
    const boxes = createFakeBoxRuntime();
    await expect(boxes.start("b")).rejects.toThrow("absent");
    await boxes.create("b");
    await expect(boxes.execAttach("b", node(""))).rejects.toThrow("stopped");
    await boxes.start("b");
    expect(await boxes.snapshot("b")).toBe("running");
  });

  it("streams stdin and stdout", async () => {
    const boxes = createFakeBoxRuntime();
    await boxes.create("b");
    await boxes.start("b");
    const { stream, exited } = await boxes.execAttach(
      "b",
      node("process.stdin.pipe(process.stdout)"),
    );
    stream.end("hello");
    const [chunk] = await once(stream, "data");
    expect(String(chunk)).toBe("hello");
    expect(await exited).toBe(0);
  });

  it("kills the process when the stream drops", async () => {
    const boxes = createFakeBoxRuntime();
    await boxes.create("b");
    await boxes.start("b");
    const { stream, exited } = await boxes.execAttach("b", node("setInterval(() => {}, 1000)"));
    stream.destroy();
    expect(await exited).not.toBe(0);
  });
});
