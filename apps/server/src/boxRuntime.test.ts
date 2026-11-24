import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createFakeBoxRuntime, probeFile } from "./boxRuntime.ts";

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

describe("probeFile", () => {
  it.runIf(process.platform === "linux")(
    "finds a file in the workspace and refuses a link that leads out of it",
    async () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-probe-"));
      try {
        const workdir = NodePath.join(root, "work");
        NodeFS.mkdirSync(NodePath.join(workdir, "out"), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(workdir, "out", "report.pdf"), "pdf");
        NodeFS.writeFileSync(NodePath.join(root, "secret"), "s");
        NodeFS.symlinkSync(NodePath.join(root, "secret"), NodePath.join(workdir, "leak"));
        const boxes = createFakeBoxRuntime();
        await boxes.create("b");
        await boxes.start("b");
        const layout = { workdir, env: { PATH: process.env.PATH ?? "" } };
        expect(await probeFile(boxes, layout, "b", "out/report.pdf")).toBe("present");
        expect(await probeFile(boxes, layout, "b", "out/missing.pdf")).toBe("absent");
        expect(await probeFile(boxes, layout, "b", "leak")).toBe("outside");
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
