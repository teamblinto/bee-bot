import * as NodeChildProcess from "node:child_process";
import { once } from "node:events";
import { Duplex, finished, type Readable } from "node:stream";

import type { InputAction, SkillCopy } from "@beebot/boxd/protocol";
import type { BoxState } from "@beebot/contracts";

import type { BoxLayout } from "./boxEngine.ts";
import { killTree } from "./engine.ts";

// Server mode: the user already runs as many boxes as the operator allows.
export class BoxLimitReached extends Error {}

export type BoxExec = { argv: string[]; env: Record<string, string>; cwd?: string };

// `stream` is the process's stdin and stdout. Destroying it kills the process, and a dropped
// attach does the same: a turn never outlives its stream.
export type BoxAttach = { stream: Duplex; exited: Promise<number | null> };

// `create` takes a bot ID and its engine account: boxd derives image, mounts, caps and network
// itself (R24). `writeBotFile` fills the bot's read-only directory in the box, `cdp` attaches to
// the sidecar's DevTools, `display` to its desktop's view-only VNC server (or, with a lease, to that
// lease's input server), `control` runs a lease's input server for as long as the attach lasts,
// `capture` takes a small JPEG of a running box's desktop, `screenshot` a full-size PNG of it, `input`
// runs mouse and keyboard actions on it until done or aborted, and `collect` copies a finished download into the
// workspace. `keepSkills` keeps only those skills in the box and names the ones it lacks, which
// `writeSkill` copies in. `destroy` removes the box, its volumes and the bot's directories in it.
// `inbox` streams a file into the workspace's inbox folder.
export type BoxRuntime = {
  create: (botId: string, account?: string) => Promise<void>;
  destroy: (botId: string) => Promise<void>;
  writeBotFile: (botId: string, name: string, content: string) => Promise<void>;
  keepSkills: (botId: string, keep: { name: string; sha256: string }[]) => Promise<string[]>;
  writeSkill: (botId: string, skill: SkillCopy) => Promise<void>;
  cdp: (botId: string) => Promise<BoxAttach>;
  capture: (botId: string) => Promise<Buffer>;
  screenshot: (botId: string) => Promise<Buffer>;
  input: (botId: string, actions: InputAction[], signal?: AbortSignal) => Promise<void>;
  display: (botId: string, lease?: string) => Promise<BoxAttach>;
  control: (botId: string, lease: string) => Promise<BoxAttach>;
  collect: (botId: string, file: string, name: string) => Promise<void>;
  inbox: (botId: string, name: string, data: Readable) => Promise<void>;
  start: (botId: string) => Promise<void>;
  stop: (botId: string) => Promise<void>;
  snapshot: (botId: string) => Promise<BoxState>;
  // Whether the account's CLI has a login in the credential folder boxes mount. Needs no box.
  hasLogin: (botId: string, account: string) => Promise<boolean>;
  execAttach: (botId: string, exec: BoxExec) => Promise<BoxAttach>;
};

// The mirror of `inbox`: streams a file out of the workspace. The box resolves links itself, so
// none can lead the read outside it. Exit 3 is a path that left the workspace, 2 one that isn't a file.
export function outbox(
  runtime: BoxRuntime,
  { env, workdir }: Pick<BoxLayout, "env" | "workdir">,
  botId: string,
  path: string,
) {
  const script =
    'real=$(realpath -e -- "$2") || exit 2; case "$real" in "$1"/*) ;; *) exit 3;; esac; ' +
    '[ -f "$real" ] || exit 2; exec cat -- "$real"';
  return runtime.execAttach(botId, { argv: ["sh", "-c", script, "sh", workdir, path], env });
}

// Like `outbox`, the box resolves links, so a link out of the workspace is `outside`.
export async function probeFile(
  runtime: BoxRuntime,
  { env, workdir }: Pick<BoxLayout, "env" | "workdir">,
  botId: string,
  path: string,
) {
  const script =
    'real=$(realpath -e -- "$1/$2") || exit 2; case "$real" in "$1"/*) exit 0;; *) exit 3;; esac';
  const { stream, exited } = await runtime.execAttach(botId, {
    argv: ["sh", "-c", script, "sh", workdir, path],
    env,
  });
  stream.end();
  stream.resume();
  const code = await exited;
  return code === 0 ? "present" : code === 3 ? "outside" : "absent";
}

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
    destroy: async (botId) => {
      states.delete(botId);
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
    hasLogin: async () => false,
    writeBotFile: async (botId) => expect(botId, ["stopped", "running"]),
    keepSkills: async (botId) => {
      expect(botId, ["stopped", "running"]);
      return [];
    },
    writeSkill: async (botId) => expect(botId, ["stopped", "running"]),

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
    inbox: async (botId, _name, data) => {
      expect(botId, ["running"]);
      data.resume();
      await once(data, "end");
    },
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
