import * as NodeChildProcess from "node:child_process";
import { once } from "node:events";
import { Duplex, finished } from "node:stream";

import type { InputAction } from "@beebot/boxd/protocol";
import type { BoxState } from "@beebot/contracts";

import { killTree } from "./engine.ts";

export type BoxExec = { argv: string[]; env: Record<string, string>; cwd?: string };

// `stream` is the process's stdin and stdout. Destroying it kills the process, and a dropped
// attach does the same: a turn never outlives its stream.
export type BoxAttach = { stream: Duplex; exited: Promise<number | null> };

// `create` takes a bot ID and its engine account: boxd derives image, mounts, caps and network
// itself (R24). `writeBotFile` fills the bot's read-only directory in the box, `cdp` attaches to
// the sidecar's DevTools, `display` to its desktop's view-only VNC server (or, with a lease, to that
// lease's input server), `control` runs a lease's input server for as long as the attach lasts,
// `capture` takes a small JPEG of a running box's desktop, `screenshot` a full-size PNG of it, `input`
// runs mouse and keyboard actions on it, and `collect` copies a finished download into the
// workspace.
export type BoxRuntime = {
  create: (botId: string, account?: string) => Promise<void>;
  writeBotFile: (botId: string, name: string, content: string) => Promise<void>;
  cdp: (botId: string) => Promise<BoxAttach>;
  capture: (botId: string) => Promise<Buffer>;
  screenshot: (botId: string) => Promise<Buffer>;
  input: (botId: string, actions: InputAction[]) => Promise<void>;
  display: (botId: string, lease?: string) => Promise<BoxAttach>;
  control: (botId: string, lease: string) => Promise<BoxAttach>;
  collect: (botId: string, file: string, name: string) => Promise<void>;
  start: (botId: string) => Promise<void>;
  stop: (botId: string) => Promise<void>;
  snapshot: (botId: string) => Promise<BoxState>;
  execAttach: (botId: string, exec: BoxExec) => Promise<BoxAttach>;
};

// For tests: no container, the command runs on this machine as if it were in the box.
export function createFakeBoxRuntime(): BoxRuntime {
  const states = new Map<string, BoxState>();

  function expect(botId: string, wanted: BoxState[]) {
    const state = states.get(botId) ?? "absent";
    if (!wanted.includes(state)) {
      throw new Error(`box ${botId} is ${state}`);
    }
  }

  return {
    create: async (botId) => {
      expect(botId, ["absent"]);
      states.set(botId, "stopped");
    },
    start: async (botId) => {
      expect(botId, ["stopped", "running"]);
      states.set(botId, "running");
    },
    stop: async (botId) => {
      expect(botId, ["stopped", "running"]);
      states.set(botId, "stopped");
    },
    snapshot: async (botId) => states.get(botId) ?? "absent",
    writeBotFile: async (botId) => expect(botId, ["stopped", "running"]),
    cdp: async () => {
      throw new Error("no sidecar in the fake box runtime");
    },
    capture: async () => {
      throw new Error("no display in the fake box runtime");
    },
    screenshot: async () => {
      throw new Error("no display in the fake box runtime");
    },
    input: async () => {
      throw new Error("no display in the fake box runtime");
    },
    display: async () => {
      throw new Error("no display in the fake box runtime");
    },
    control: async () => {
      throw new Error("no display in the fake box runtime");
    },
    collect: async (botId) => expect(botId, ["running"]),
    execAttach: async (botId, { argv: [command = "", ...args], env, cwd }) => {
      expect(botId, ["running"]);
      const child = NodeChildProcess.spawn(command, args, {
        env,
        cwd,
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const exited = once(child, "close").then(
        () => child.exitCode,
        () => null,
      );
      const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
      finished(stream, () => {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          killTree(child.pid);
        }
      });
      return { stream, exited };
    },
  };
}
