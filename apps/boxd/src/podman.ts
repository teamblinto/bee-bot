import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import type { Readable, Writable } from "node:stream";

export type Result = { code: number; stdout: string; stderr: string };

export type Child = {
  stdin: Writable;
  stdout: Readable;
  kill: () => void;
  exited: Promise<number | null>;
};

// The only door to the container engine. boxd is its sole user; the server never gets one.
// `env` is the container's or exec's environment, never podman's own.
export type Podman = {
  run: (args: string[], env?: Record<string, string>) => Promise<Result>;
  spawn: (args: string[], env: Record<string, string>) => Child;
  host: (command: string, args: string[], stdin?: string) => Promise<Result>;
};

// Env values must stay off argv (`ps` shows argv) and out of podman's own environment, where
// HOME or PATH would redirect podman itself. So they go in a 0600 file on the runtime tmpfs,
// removed once podman is done with it.
function envFile(args: string[], env: Record<string, string>) {
  if (Object.keys(env).length === 0) {
    return { args, remove: () => {} };
  }
  const dir = NodePath.join(process.env.XDG_RUNTIME_DIR ?? NodeOs.tmpdir(), "beebot-boxd");
  NodeFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = NodePath.join(dir, `${NodeCrypto.randomUUID()}.env`);
  const lines = Object.entries(env).map(([key, value]) => `${key}=${value}\n`);
  NodeFs.writeFileSync(path, lines.join(""), { mode: 0o600 });
  const [verb = "", ...rest] = args;
  return {
    args: [verb, "--env-file", path, ...rest],
    remove: () => NodeFs.rmSync(path, { force: true }),
  };
}

function collect(command: string, args: string[], stdin = "") {
  return new Promise<Result>((resolve) => {
    const child = NodeChildProcess.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => resolve({ code: -1, stdout: "", stderr: error.message }));
    child.on("close", (code) =>
      resolve({
        code: code ?? -1,
        stdout: String(Buffer.concat(out)),
        stderr: String(Buffer.concat(err)),
      }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

export function createPodman(binary = "podman"): Podman {
  return {
    run: async (args, env = {}) => {
      const file = envFile(args, env);
      try {
        return await collect(binary, file.args);
      } finally {
        file.remove();
      }
    },
    host: (command, args, stdin) => collect(command, args, stdin),
    spawn: (args, env) => {
      const file = envFile(args, env);
      const child = NodeChildProcess.spawn(binary, file.args, {
        stdio: ["pipe", "pipe", "ignore"],
      });
      child.stdin.on("error", () => {});
      const exited = new Promise<number | null>((resolve) => {
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code));
      });
      void exited.finally(file.remove);
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        kill: () => child.kill("SIGKILL"),
        exited,
      };
    },
  };
}
