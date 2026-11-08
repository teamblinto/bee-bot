import { Duplex } from "node:stream";

import { describe, expect, it } from "vite-plus/test";

import { applyEdit, boxExecutors } from "./boxExecutors.ts";
import { type BoxExec, createFakeBoxRuntime } from "./boxRuntime.ts";

type Reply = { output?: string; code: number | null };

// Each exec answers with the next reply once its stdin ends, as a box process would.
function scripted(...replies: Reply[]) {
  const calls: Array<{ exec: BoxExec; stdin: string }> = [];
  const runtime = {
    ...createFakeBoxRuntime(),
    execAttach: async (_botId: string, exec: BoxExec) => {
      const reply = replies.shift() ?? { code: 0 };
      const call = { exec, stdin: "" };
      calls.push(call);
      const { promise: exited, resolve } = Promise.withResolvers<number | null>();
      const stream = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, done) {
          call.stdin += chunk.toString();
          done();
        },
        final(done) {
          this.push(reply.output ?? "");
          this.push(null);
          resolve(reply.code);
          done();
        },
      });
      return { stream, exited };
    },
  };
  const layout = { env: { HOME: "/home/bee" }, workdir: "/work" };
  const executors = boxExecutors({ runtime, layout });
  const run = (tool: string, input: Record<string, unknown>) =>
    executors.get(tool)?.({
      botId: "b",
      runId: "r",
      tool,
      payload: JSON.stringify({ tool, input, target: null }),
    });
  return { calls, run };
}

describe("an approved Box call", () => {
  it("runs Bash in the box with the command on stdin, never argv", async () => {
    const { calls, run } = scripted({ output: "hi\n", code: 0 });
    expect(await run("Bash", { command: "echo hi" })).toEqual({ ok: true, output: "hi\n" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.stdin).toBe("echo hi");
    expect(calls[0]?.exec.argv.join(" ")).not.toContain("echo hi");
    expect(calls[0]?.exec.cwd).toBe("/work");
  });

  it("reports a failing command as failed, with its exit code", async () => {
    const { run } = scripted({ output: "no such file\n", code: 2 });
    expect(await run("Bash", { command: "ls nope" })).toEqual({
      ok: false,
      output: "no such file\n\nExit code 2",
    });
  });

  it("throws when the box goes away mid-run, so the outcome is unknown", async () => {
    const { run } = scripted({ output: "half", code: null });
    await expect(run("Bash", { command: "deploy" })).rejects.toThrow();
  });

  it("writes a file with its content on stdin", async () => {
    const { calls, run } = scripted({ code: 0 });
    const result = await run("Write", { file_path: "/work/a.txt", content: "secret plan" });
    expect(result).toEqual({ ok: true, output: "Wrote /work/a.txt" });
    expect(calls[0]?.stdin).toBe("secret plan");
    expect(calls[0]?.exec.argv.at(-1)).toBe("/work/a.txt");
    expect(calls[0]?.exec.argv.join(" ")).not.toContain("secret plan");
  });

  it("edits by reading the file, then writing the change back", async () => {
    const { calls, run } = scripted({ output: "one two\n", code: 0 }, { code: 0 });
    const input = { file_path: "/work/a.txt", old_string: "two", new_string: "three" };
    expect(await run("Edit", input)).toEqual({ ok: true, output: "Edited /work/a.txt" });
    expect(calls.map(({ exec }) => exec.argv[0])).toEqual(["cat", "sh"]);
    expect(calls[1]?.stdin).toBe("one three\n");
  });

  it("writes nothing when the text to replace isn't there", async () => {
    const { calls, run } = scripted({ output: "one\n", code: 0 });
    const input = { file_path: "/work/a.txt", old_string: "two", new_string: "three" };
    expect(await run("Edit", input)).toMatchObject({ ok: false });
    expect(calls).toHaveLength(1);
  });

  it("runs nothing for a payload that doesn't parse", async () => {
    const { calls, run } = scripted();
    expect(await run("Write", { file_path: "/work/a.txt" })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});

describe("applyEdit", () => {
  const edit = (old_string: string, new_string: string, replace_all = false) => ({
    file_path: "f",
    old_string,
    new_string,
    replace_all,
  });

  it("replaces one exact match, and takes the replacement literally", () => {
    expect(applyEdit("a b c", edit("b", "$&$&"))).toEqual({ text: "a $&$& c" });
  });

  it("refuses an ambiguous match unless every match is wanted", () => {
    expect(applyEdit("x x", edit("x", "y"))).toHaveProperty("error");
    expect(applyEdit("x x", edit("x", "y", true))).toEqual({ text: "y y" });
  });

  it("refuses a missing or empty match", () => {
    expect(applyEdit("abc", edit("z", "y"))).toHaveProperty("error");
    expect(applyEdit("abc", edit("", "y"))).toHaveProperty("error");
  });
});
