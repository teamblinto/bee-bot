import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { Duplex } from "node:stream";

import type { BoxState } from "@beebot/contracts";
import {
  type Hello,
  Kind,
  type Request,
  type Response,
  type Verb,
  boxToken,
  boxdChannels,
  egressId,
  frame,
  frameReader,
  jsonFrame,
} from "@beebot/boxd/protocol";
import { machineInstallScript, nodeBin } from "@beebot/boxd/install";
import { z } from "zod";

import type { BoxAttach, BoxExec, BoxRuntime } from "./boxRuntime.ts";

export type BoxdBootstrap = {
  // Must survive restarts: it signs the labels boxd uses to recognise its own boxes.
  secret: Uint8Array;
  owner: string;
  prefix?: string;
  labels?: Record<string, string>;
  testUpstreams?: Record<string, string>;
};

export type BoxdConnection = {
  runtime: BoxRuntime;
  // A fresh connection to the egress proxy's control socket, for the server's policies.
  egressControl: () => Promise<Duplex>;
  closed: Promise<void>;
};

// `relay` opens a connection to beebotd for each request a box makes to `/bee/*`.
export type BoxdHooks = { relay?: () => Duplex };

const chunkSize = 1024 * 1024;
const maxCaptureBytes = 1024 * 1024;
const maxScreenshotBytes = 8 * 1024 * 1024;
const captureTimeoutMs = 10_000;

// Speaks boxd's framed protocol over any byte stream: boxd's stdio through `podman machine ssh`,
// or a pipe in tests. The server holds this stream and never the Podman socket.
export async function connectBoxd(
  transport: Duplex,
  bootstrap: BoxdBootstrap,
  { relay }: BoxdHooks = {},
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
    if (channel >= boxdChannels) {
      onRelayFrame(channel, kind, payload);
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

  const relays = new Map<number, Duplex>();
  function onRelayFrame(channel: number, kind: Kind, payload: Buffer) {
    if (kind === Kind.open) {
      const socket = relay?.();
      if (socket === undefined) {
        send(frame(channel, Kind.kill));
        return;
      }
      relays.set(channel, socket);
      socket.on("data", (chunk: Buffer) => send(frame(channel, Kind.data, chunk)));
      socket.on("end", () => send(frame(channel, Kind.eof)));
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        if (relays.delete(channel)) {
          send(frame(channel, Kind.kill));
        }
      });
      return;
    }
    const socket = relays.get(channel);
    if (kind === Kind.data) {
      socket?.write(payload);
    } else if (kind === Kind.eof) {
      socket?.end();
    } else if (kind === Kind.kill) {
      relays.delete(channel);
      socket?.destroy();
    }
  }

  const closed = new Promise<void>((resolve) => {
    transport.on("close", () => {
      for (const socket of relays.values()) {
        socket.destroy();
      }
      relays.clear();
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

  type Extra = Omit<Request, "id" | "verb" | "botId" | "token">;
  function request(verb: Verb, botId: string, extra: Extra = {}) {
    return new Promise<Response>((resolve, reject) => {
      if (lost !== null) {
        reject(lost);
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send(jsonFrame({ id, verb, botId, token: boxToken(secret, botId), ...extra }));
    }).then((response) => {
      if (!response.ok) {
        throw new Error(response.error);
      }
      return response;
    });
  }

  async function execAttach(botId: string, { argv, env, cwd }: BoxExec) {
    return attach((channel) =>
      request("exec", botId, {
        exec: { argv, env, channel, ...(cwd === undefined ? {} : { cwd }) },
      }),
    );
  }

  async function attach(open: (channel: number) => Promise<Response>): Promise<BoxAttach> {
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
      await open(channel);
    } catch (error) {
      entry.exited = true;
      channels.delete(channel);
      entry.stream.destroy();
      throw error;
    }
    return { stream: entry.stream, exited };
  }

  // A thumbnail is about 10 KB and a full screenshot under 2 MB; a stuck or oversized output is cut
  // off, which kills its process in the box.
  async function output(open: (channel: number) => Promise<Response>, maxBytes: number) {
    const { stream, exited } = await attach(open);
    const timer = setTimeout(
      () => stream.destroy(new Error("box output timed out")),
      captureTimeoutMs,
    );
    try {
      stream.end();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > maxBytes) {
          throw new Error("box output too large");
        }
        chunks.push(chunk);
      }
      if ((await exited) !== 0) {
        throw new Error("box command failed");
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
      stream.destroy();
    }
  }

  async function image(botId: string, full: boolean) {
    const data = await output(
      (channel) => request("capture", botId, full ? { channel, full } : { channel }),
      full ? maxScreenshotBytes : maxCaptureBytes,
    );
    if (data.length === 0) {
      throw new Error("capture failed");
    }
    return data;
  }

  transport.write(
    jsonFrame({
      secret: Buffer.from(secret).toString("base64"),
      owner: bootstrap.owner,
      prefix: bootstrap.prefix ?? "beebot",
      labels: bootstrap.labels ?? {},
      ...(bootstrap.testUpstreams && { testUpstreams: bootstrap.testUpstreams }),
    }),
  );
  const ready = await hello;
  if ("fatal" in ready) {
    transport.destroy();
    throw new Error(`boxd: ${ready.fatal}`);
  }

  const runtime: BoxRuntime = {
    create: async (botId, account) => {
      await request("create", botId, account === undefined ? {} : { account });
    },
    writeBotFile: async (botId, name, content) => {
      await request("put", botId, { put: { name, content } });
    },
    cdp: (botId) => attach((channel) => request("cdp", botId, { channel })),
    capture: (botId) => image(botId, false),
    screenshot: (botId) => image(botId, true),
    input: async (botId, input) => {
      await output((channel) => request("input", botId, { channel, input }), 0);
    },
    display: (botId, lease) =>
      attach((channel) =>
        request(
          "display",
          botId,
          lease === undefined ? { channel, mode: "view" } : { channel, mode: "control", lease },
        ),
      ),
    control: (botId, lease) => attach((channel) => request("control", botId, { channel, lease })),
    collect: async (botId, file, name) => {
      await request("collect", botId, { collect: { file, name } });
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
  return {
    runtime,
    egressControl: async () =>
      (await attach((channel) => request("egress", egressId, { channel }))).stream,
    closed,
  };
}

// Windows runs boxd in the Podman WSL machine (tested). macOS uses the same path with an applehv
// machine, and Linux runs boxd natively beside the server; both are untested.
export type BoxdHost =
  | { kind: "podman-machine"; podman: string; machine: string }
  | { kind: "native"; node: string };

// Local paths. `boxd[0]` is the entry point; runSpec.json and seccomp-chromium.json come from
// images/box and egress.mjs from apps/boxd/egress, and are installed beside it.
export type BoxdFiles = { boxd: string[]; runSpec: string; seccomp: string; egress?: string };

function installEntries(files: BoxdFiles) {
  return [
    ...files.boxd.map((path) => [NodePath.basename(path), path] as const),
    ["runSpec.json", files.runSpec] as const,
    ["seccomp-chromium.json", files.seccomp] as const,
    ...(files.egress === undefined ? [] : [["egress.mjs", files.egress] as const]),
  ];
}

// `podman machine ssh` runs the first `ssh` on PATH with `UserKnownHostsFile=NUL`. The MSYS ssh
// that ships with Git for Windows takes NUL for a file name and leaves a file called NUL in the
// working directory, so Windows' own OpenSSH goes first.
export function podmanEnv(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  if (platform !== "win32") {
    return env;
  }
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "Path";
  const openSsh = NodePath.win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH");
  return { ...env, [key]: `${openSsh};${env[key] ?? ""}` };
}

// A rootful machine's `podman machine ssh` logs in as root, but boxd is rootless: it runs as the
// machine's own user, the one its default rootless connection uses. `inspect` is `podman machine
// inspect` output.
export function machineSsh(inspect: string, machine: string) {
  let user: string | undefined;
  try {
    user = z
      .array(z.object({ SSHConfig: z.object({ RemoteUsername: z.string().min(1) }) }))
      .safeParse(JSON.parse(inspect)).data?.[0]?.SSHConfig.RemoteUsername;
  } catch {
    user = undefined;
  }
  return ["machine", "ssh", ...(user ? ["--username", user] : []), machine];
}

function inspectMachine(podman: string, machine: string) {
  return new Promise<string>((resolve) => {
    NodeChildProcess.execFile(
      podman,
      ["machine", "inspect", machine],
      { env: podmanEnv(), windowsHide: true },
      (error, stdout) => resolve(error ? "" : stdout),
    );
  });
}

function run(command: string, args: string[], stdin: string) {
  return new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      stdio: ["pipe", "ignore", "pipe"],
      env: podmanEnv(),
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
  hooks,
}: {
  hooks?: BoxdHooks;
  host: BoxdHost;
  // Relative to the host user's home directory.
  installDir: string;
  files: BoxdFiles;
  bootstrap: BoxdBootstrap;
}) {
  const entry = NodePath.basename(files.boxd[0] ?? "");
  let child: NodeChildProcess.ChildProcessWithoutNullStreams;
  if (host.kind === "podman-machine") {
    const ssh = machineSsh(await inspectMachine(host.podman, host.machine), host.machine);
    await run(
      host.podman,
      [...ssh, "bash -s"],
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
      [...ssh, `exec "$HOME/${installDir}/${nodeBin}" "$HOME/${installDir}/${entry}"`],
      { stdio: ["pipe", "pipe", "pipe"], env: podmanEnv(), windowsHide: true },
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
    const connection = await connectBoxd(transport, bootstrap, hooks);
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
