import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { Duplex } from "node:stream";

import type { BoxState } from "@beebot/contracts";
import {
  type ExecRequest,
  type Hello,
  Kind,
  type Response,
  type Verb,
  boxToken,
  frame,
  frameReader,
  jsonFrame,
} from "@beebot/boxd/protocol";
import { machineInstallScript, nodeBin } from "@beebot/boxd/install";

import type { BoxAttach, BoxExec, BoxRuntime } from "./boxRuntime.ts";

export type BoxdBootstrap = {
  // Must survive restarts: it signs the labels boxd uses to recognise its own boxes.
  secret: Uint8Array;
  owner: string;
  prefix?: string;
  labels?: Record<string, string>;
};

export type BoxdConnection = { runtime: BoxRuntime; closed: Promise<void> };

const chunkSize = 1024 * 1024;

// Speaks boxd's framed protocol over any byte stream: boxd's stdio through `podman machine ssh`,
// or a pipe in tests. The server holds this stream and never the Podman socket.
export async function connectBoxd(
  transport: Duplex,
  bootstrap: BoxdBootstrap,
): Promise<BoxdConnection> {
  const { secret } = bootstrap;
  type Channel = {
    stream: Duplex;
    exit: (code: number | null) => void;
    stdoutEnded: boolean;
    exited: boolean;
  };
  const pending = new Map<
    number,
    { resolve: (response: Response) => void; reject: (error: Error) => void }
  >();
  const channels = new Map<number, Channel>();
  let nextId = 1;
  let nextChannel = 1;
  let lost: Error | null = null;
  let onHello: ((hello: Hello) => void) | null = null;
  const hello = new Promise<Hello>((resolve) => {
    onHello = resolve;
  });

  const read = frameReader((channel, kind, payload) => {
    if (channel === 0) {
      const message: unknown = JSON.parse(String(payload));
      if (onHello !== null) {
        const resolve = onHello;
        onHello = null;
        resolve(message as Hello);
        return;
      }
      const response = message as Response;
      pending.get(response.id)?.resolve(response);
      pending.delete(response.id);
      return;
    }
    const entry = channels.get(channel);
    if (entry === undefined) {
      return;
    }
    if (kind === Kind.data) {
      entry.stream.push(Buffer.from(payload));
    } else if (kind === Kind.eof) {
      entry.stdoutEnded = true;
      entry.stream.push(null);
    } else if (kind === Kind.exit) {
      entry.exited = true;
      channels.delete(channel);
      entry.exit(JSON.parse(String(payload)) as number | null);
    }
  });

  const closed = new Promise<void>((resolve) => {
    transport.on("close", () => {
      lost = new Error("boxd connection lost");
      onHello?.({ fatal: "boxd exited before it was ready" });
      for (const { reject } of pending.values()) {
        reject(lost);
      }
      pending.clear();
      for (const entry of channels.values()) {
        entry.exited = true;
        entry.exit(null);
        entry.stream.destroy();
      }
      channels.clear();
      resolve();
    });
  });
  transport.on("error", () => {});
  transport.on("data", (chunk: Buffer) => {
    try {
      read(chunk);
    } catch (error) {
      transport.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });

  function send(data: Buffer, callback?: (error?: Error | null) => void) {
    if (lost !== null) {
      callback?.(lost);
      return;
    }
    transport.write(data, callback);
  }

  function request(verb: Verb, botId: string, exec?: ExecRequest) {
    return new Promise<Response>((resolve, reject) => {
      if (lost !== null) {
        reject(lost);
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send(
        jsonFrame({ id, verb, botId, token: boxToken(secret, botId), ...(exec ? { exec } : {}) }),
      );
    }).then((response) => {
      if (!response.ok) {
        throw new Error(response.error);
      }
      return response;
    });
  }

  async function execAttach(botId: string, { argv, env, cwd }: BoxExec): Promise<BoxAttach> {
    const channel = nextChannel++;
    let exit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => {
      exit = resolve;
    });
    const entry: Channel = {
      exit: (code) => exit(code),
      stdoutEnded: false,
      exited: false,
      stream: new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          for (let offset = 0; offset < chunk.length; offset += chunkSize) {
            const last = offset + chunkSize >= chunk.length;
            send(
              frame(channel, Kind.data, chunk.subarray(offset, offset + chunkSize)),
              last ? callback : undefined,
            );
          }
          if (chunk.length === 0) {
            callback();
          }
        },
        final(callback) {
          send(frame(channel, Kind.eof));
          callback();
        },
        destroy(error, callback) {
          // A dropped attach kills the turn. Once stdout has ended the process is normally
          // exiting on its own, so it gets a moment before the kill.
          if (!entry.exited) {
            const kill = () => entry.exited || send(frame(channel, Kind.kill));
            if (entry.stdoutEnded) {
              setTimeout(kill, 1000).unref();
            } else {
              kill();
            }
          }
          callback(error);
        },
      }),
    };
    channels.set(channel, entry);
    try {
      await request("exec", botId, { argv, env, channel, ...(cwd === undefined ? {} : { cwd }) });
    } catch (error) {
      entry.exited = true;
      channels.delete(channel);
      entry.stream.destroy();
      throw error;
    }
    return { stream: entry.stream, exited };
  }

  transport.write(
    jsonFrame({
      secret: Buffer.from(secret).toString("base64"),
      owner: bootstrap.owner,
      prefix: bootstrap.prefix ?? "beebot",
      labels: bootstrap.labels ?? {},
    }),
  );
  const ready = await hello;
  if ("fatal" in ready) {
    transport.destroy();
    throw new Error(`boxd: ${ready.fatal}`);
  }

  const runtime: BoxRuntime = {
    create: async (botId) => {
      await request("create", botId);
    },
    start: async (botId) => {
      await request("start", botId);
    },
    stop: async (botId) => {
      await request("stop", botId);
    },
    snapshot: async (botId): Promise<BoxState> =>
      (await request("snapshot", botId)).state ?? "absent",
    execAttach,
  };
  return { runtime, closed };
}

// Windows runs boxd in the Podman WSL machine (tested). macOS uses the same path with an applehv
// machine, and Linux runs boxd natively beside the server; both are untested.
export type BoxdHost =
  | { kind: "podman-machine"; podman: string; machine: string }
  | { kind: "native"; node: string };

// Local paths. `boxd[0]` is the entry point; runSpec.json and seccomp-chromium.json come from
// images/box and are installed beside it.
export type BoxdFiles = { boxd: string[]; runSpec: string; seccomp: string };

function installEntries(files: BoxdFiles) {
  return [
    ...files.boxd.map((path) => [NodePath.basename(path), path] as const),
    ["runSpec.json", files.runSpec] as const,
    ["seccomp-chromium.json", files.seccomp] as const,
  ];
}

function run(command: string, args: string[], stdin: string) {
  return new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    const err: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${String(Buffer.concat(err)).trim()} (exit ${code})`)),
    );
    child.stdin.end(stdin);
  });
}

export async function launchBoxd({
  host,
  installDir,
  files,
  bootstrap,
}: {
  host: BoxdHost;
  // Relative to the host user's home directory.
  installDir: string;
  files: BoxdFiles;
  bootstrap: BoxdBootstrap;
}) {
  const entry = NodePath.basename(files.boxd[0] ?? "");
  let child: NodeChildProcess.ChildProcessWithoutNullStreams;
  if (host.kind === "podman-machine") {
    await run(
      host.podman,
      ["machine", "ssh", host.machine, "bash -s"],
      machineInstallScript(
        installDir,
        await Promise.all(
          installEntries(files).map(
            async ([name, path]) => [name, await NodeFs.readFile(path)] as const,
          ),
        ),
      ),
    );
    child = NodeChildProcess.spawn(
      host.podman,
      [
        "machine",
        "ssh",
        host.machine,
        `exec "$HOME/${installDir}/${nodeBin}" "$HOME/${installDir}/${entry}"`,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
  } else {
    const dir = NodePath.join(NodeOs.homedir(), installDir);
    await NodeFs.mkdir(dir, { recursive: true });
    await NodeFs.writeFile(NodePath.join(dir, "package.json"), '{"type":"module"}');
    for (const [name, path] of installEntries(files)) {
      await NodeFs.copyFile(path, NodePath.join(dir, name));
    }
    child = NodeChildProcess.spawn(host.node, [NodePath.join(dir, entry)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
  }
  // boxd writes no secrets to stderr; keep only the tail for failures.
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });
  child.on("error", () => {});
  const transport = Duplex.from({ readable: child.stdout, writable: child.stdin });
  // The wrapper does not always close when the process ends; the process ending is what counts.
  child.on("close", () => transport.destroy());
  try {
    const connection = await connectBoxd(transport, bootstrap);
    return {
      ...connection,
      stderr: () => stderr,
      // boxd kills every attached turn when its stdin closes, then exits.
      close: async () => {
        child.stdin.end();
        await connection.closed;
      },
    };
  } catch (error) {
    child.kill();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`.trim(), {
      cause: error,
    });
  }
}
