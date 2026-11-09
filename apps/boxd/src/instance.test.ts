import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { afterEach, expect, it } from "vite-plus/test";

import { becomeOnlyBoxd } from "./instance.ts";

const dirs: string[] = [];
const children: NodeChildProcess.ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

function pidFile() {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "boxd-instance-"));
  dirs.push(dir);
  return NodePath.join(dir, "boxd.pid");
}

function running() {
  const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  children.push(child);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { pid: child.pid ?? 0, exited };
}

it("takes the machine from an older boxd and waits for it to exit", async () => {
  const path = pidFile();
  const older = running();
  NodeFs.writeFileSync(path, String(older.pid));
  await becomeOnlyBoxd(path, () => true);
  await older.exited;
  expect(NodeFs.readFileSync(path, "utf8")).toBe(String(process.pid));
});

it("never stops a process that only reused an old boxd's PID", async () => {
  const path = pidFile();
  const stranger = running();
  NodeFs.writeFileSync(path, String(stranger.pid));
  await becomeOnlyBoxd(path, () => false);
  expect(() => process.kill(stranger.pid, 0)).not.toThrow();
  expect(NodeFs.readFileSync(path, "utf8")).toBe(String(process.pid));
});

it("replaces the file of a boxd that is already gone", async () => {
  const path = pidFile();
  NodeFs.writeFileSync(path, "999999");
  await becomeOnlyBoxd(path, () => true);
  expect(NodeFs.readFileSync(path, "utf8")).toBe(String(process.pid));
});
