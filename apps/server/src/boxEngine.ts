import * as NodeChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as NodePath from "node:path";
import { type Duplex, finished, PassThrough, type Readable, type Writable } from "node:stream";

import type { BoxExec, BoxRuntime } from "./boxRuntime.ts";
import { killTree } from "./engine.ts";

// What a driver needs of a running engine, on this machine or in a box.
export type EngineProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | undefined;
  // `spawnError`: the binary never started. `exit` and `close` come once each.
  events: EventEmitter<{ spawnError: []; exit: []; close: [] }>;
  kill: () => void;
  alive: () => boolean;
  // The box's attach went away under a live process: the turn is lost, the login is not in doubt.
  dropped: () => boolean;
  // Settles once the process is gone, which in a box can be after its stream closed.
  gone: Promise<void>;
};

type HostSpawn = { cwd: string; env: NodeJS.ProcessEnv; stderr: boolean };

export function spawnHost(
  command: readonly string[],
  args: string[],
  { cwd, env, stderr }: HostSpawn,
): EngineProcess {
  const [file = "", ...prefix] = command;
  const options = {
    cwd,
    env,
    windowsHide: true,
    // Its own group, so a POSIX stop reaches the whole tree.
    detached: process.platform !== "win32",
  };
  const child = stderr
    ? NodeChildProcess.spawn(file, [...prefix, ...args], { ...options, stdio: "pipe" })
    : NodeChildProcess.spawn(file, [...prefix, ...args], {
        ...options,
        stdio: ["pipe", "pipe", "ignore"],
      });
  const events = new EventEmitter<{ spawnError: []; exit: []; close: [] }>();
  const { promise: gone, resolve: markGone } = Promise.withResolvers<void>();
  child.once("error", () => {
    if (child.pid === undefined) {
      markGone();
      events.emit("spawnError");
    }
  });
  child.once("exit", () => {
    markGone();
    events.emit("exit");
  });
  child.once("close", () => events.emit("close"));
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr ?? undefined,
    events,
    // Also after the exit: a detached grandchild can still hold the group.
    kill: () => {
      if (child.pid !== undefined) {
        killTree(child.pid);
      }
    },
    alive: () => child.exitCode === null && child.signalCode === null,
    dropped: () => false,
    gone,
  };
}

// The box has no stderr channel, so a driver gets none. A failed attach counts as a drop: the box
// is the problem, not the CLI or its login.
export function spawnInBox(runtime: BoxRuntime, botId: string, exec: BoxExec): EngineProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const events = new EventEmitter<{ spawnError: []; exit: []; close: [] }>();
  const { promise: gone, resolve: markGone } = Promise.withResolvers<void>();
  let stream: Duplex | undefined;
  let killed = false;
  let ended = false;
  let lost = false;

  function end(dropped: boolean) {
    if (ended) {
      return;
    }
    ended = true;
    lost = dropped && !killed;
    stdin.unpipe();
    stdout.end();
  }

  // Only once the driver has read every byte, or let go of the stream.
  finished(stdout, () => {
    events.emit("exit");
    events.emit("close");
  });

  runtime.execAttach(botId, exec).then(
    (attach) => {
      void attach.exited.then(
        () => markGone(),
        () => markGone(),
      );
      if (killed) {
        attach.stream.destroy();
        end(false);
        return;
      }
      stream = attach.stream;
      stdin.pipe(attach.stream);
      attach.stream.on("data", (chunk: Buffer) => stdout.write(chunk));
      attach.stream.on("error", () => {});
      finished(attach.stream, { writable: false }, (error) => end(Boolean(error)));
    },
    () => {
      markGone();
      end(true);
    },
  );

  return {
    stdin,
    stdout,
    stderr: undefined,
    events,
    kill: () => {
      killed = true;
      stream?.destroy();
    },
    alive: () => !ended,
    dropped: () => lost,
    gone,
  };
}

// Paths as the box sees them, from images/box: a non-root user with a persistent home, the
// workspace at /work, and no route out except the egress proxy.
export type BoxLayout = {
  home: string;
  workdir: string;
  // Where the vendor installer puts the CLI, for reading what it supports.
  claudeBinary: string;
  // Mount point of the account's credential directory, when it is shared (R19).
  credentialDir: string;
  // Read-only per-bot directory Bee writes the persona into: never a prompt on argv.
  beeDir: { host: (botId: string) => string; box: string };
  // Origin of the egress proxy's API lane, which injects the key (R3): the key never enters a box.
  apiLane: string;
  // How the box reaches a beebotd URL, such as the MCP endpoint.
  beeUrl: (hostUrl: string) => string;
  // The whole environment of an engine process apart from what the driver adds.
  env: Record<string, string>;
};

export const proxyHost = "proxy.beebot";

export function boxLayout(dataDir: string): BoxLayout {
  const home = "/home/bee";
  return {
    home,
    workdir: "/work",
    claudeBinary: `${home}/.local/bin/claude`,
    credentialDir: "/run/bee/credential",
    beeDir: { host: (botId) => NodePath.join(dataDir, "bots", botId, "box"), box: "/run/bee/bot" },
    apiLane: `http://${proxyHost}:8080`,
    beeUrl: (hostUrl) => {
      const url = new URL(hostUrl);
      return `http://${proxyHost}:8080/bee${url.pathname}`;
    },
    env: {
      HOME: home,
      PATH: `${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      HTTPS_PROXY: `http://${proxyHost}:3128`,
      NO_PROXY: proxyHost,
    },
  };
}

// Not a key: the proxy strips it and injects the real one. The CLI only needs something there.
export const proxyKeyPlaceholder = "beebot-proxy-injects-the-key";

export type BoxEngine = "claude" | "codex";

// R19. Both CLIs replace their credential file by temp file plus rename, which breaks a single-file
// bind mount and replaces a symlinked file, so only a directory is ever shared. Claude can be
// pointed at that directory only by `CLAUDE_SECURESTORAGE_CONFIG_DIR`, so a CLI without it logs in
// once per box. Codex reads `$CODEX_HOME/auth.json`, which links into the directory.
export type CredentialMapping =
  | { kind: "shared"; hostDir: string; boxDir: string; env: Record<string, string>; link?: string }
  | { kind: "per_box" };

export function credentialMapping({
  engine,
  accountId,
  dataDir,
  layout,
  secureStorageDir,
}: {
  engine: BoxEngine;
  accountId: string;
  dataDir: string;
  layout: Pick<BoxLayout, "credentialDir">;
  secureStorageDir: boolean;
}): CredentialMapping {
  const hostDir = NodePath.join(dataDir, "credentials", accountId);
  const boxDir = layout.credentialDir;
  if (engine === "codex") {
    return { kind: "shared", hostDir, boxDir, env: {}, link: `${boxDir}/auth.json` };
  }
  return secureStorageDir
    ? { kind: "shared", hostDir, boxDir, env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: boxDir } }
    : { kind: "per_box" };
}

const secureStorageVariable = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

// Undocumented, so it is looked for in the installed binary rather than assumed from a version.
export async function supportsSecureStorageDir(
  runtime: BoxRuntime,
  botId: string,
  claudeBinary: string,
  env: Record<string, string>,
) {
  try {
    const { stream, exited } = await runtime.execAttach(botId, {
      argv: ["grep", "-qF", secureStorageVariable, claudeBinary],
      env,
    });
    stream.resume();
    stream.end();
    return (await exited) === 0;
  } catch {
    return false;
  }
}

// R5: one Codex subscription session per account at a time, held for the whole life of the
// app-server, not just the turn. Resolves to the release, or undefined if `signal` aborted first.
export function createAccountGate() {
  const tails = new Map<string, Promise<void>>();
  return async (key: string, signal: AbortSignal) => {
    const previous = tails.get(key) ?? Promise.resolve();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const tail = previous.then(() => released);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    });
    const { promise: aborted, resolve: abort } = Promise.withResolvers<"aborted">();
    const onAbort = () => abort("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    const won = await Promise.race([previous.then(() => "turn" as const), aborted]);
    signal.removeEventListener("abort", onAbort);
    if (won === "aborted") {
      release();
      return undefined;
    }
    return () => release();
  };
}
export type AccountGate = ReturnType<typeof createAccountGate>;

export type BoxOptions = {
  runtime: BoxRuntime;
  layout: BoxLayout;
};
