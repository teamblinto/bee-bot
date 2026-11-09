import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { Duplex } from "node:stream";

import { type BoxdOptions, createBoxd } from "./boxd.ts";
import { noEgress } from "./egress.ts";
import type { Child, Podman, Result } from "./podman.ts";
import type { RunSpec } from "./policy.ts";
import { frameReader, jsonFrame } from "./protocol.ts";

const limits = {
  tmpfs: ["/tmp:rw,size=256m,mode=1777"],
  shm: "64m",
  memory: "2g",
  memorySwap: "2g",
  cpus: "2",
  pids: 512,
};

export const testRunSpec: RunSpec = {
  engine: {
    ...limits,
    image: "localhost/box@sha256:00",
    user: "10001:10001",
    home: "/home/bee",
    command: ["sleep", "infinity"],
    hostname: "engine",
    seccomp: false,
    volumes: { home: "/home/bee", workspace: "/work" },
  },
  browser: {
    ...limits,
    image: "localhost/box@sha256:00",
    user: "10001:10001",
    home: "/browser",
    command: ["chromium"],
    hostname: "bee-browser",
    seccomp: true,
    volumes: { profile: "/browser" },
  },
};

export const testStateDir = () => NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "boxd-state-"));

// boxd in this process behind a byte stream, as the server sees it over stdio. The bootstrap
// frame is read like main.ts does, minus setup.
export function serveInProcess(podman: Podman, overrides: Partial<BoxdOptions> = {}) {
  let boxd: ReturnType<typeof createBoxd> | null = null;
  const transport = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      read(chunk);
      callback();
    },
    final(callback) {
      void boxd?.close().then(() => transport.push(null));
      callback();
    },
  });
  const send = (data: Buffer) => transport.push(data);
  const read = frameReader((channel, kind, payload) => {
    if (boxd !== null) {
      boxd.onFrame(channel, kind, payload);
      return;
    }
    const bootstrap = JSON.parse(String(payload));
    boxd = createBoxd({
      podman,
      egress: noEgress,
      secret: Buffer.from(bootstrap.secret, "base64"),
      owner: bootstrap.owner,
      prefix: bootstrap.prefix,
      labels: bootstrap.labels,
      runSpec: testRunSpec,
      seccomp: "/opt/boxd/seccomp-chromium.json",
      stateDir: testStateDir(),
      send,
      ...overrides,
    });
    send(jsonFrame({ ready: true }));
  });
  return transport;
}

type Resource = { labels: Record<string, string>; args: string[]; running: boolean };

// A podman stand-in for tests: keeps resources in memory, and runs an exec's argv on this
// machine so attach and kill behave like the real thing.
export function createFakePodman({ failCreate }: { failCreate?: (name: string) => boolean } = {}) {
  const resources = {
    container: new Map<string, Resource>(),
    network: new Map<string, Resource>(),
    volume: new Map<string, Resource>(),
  };
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const execs = new Map<string, NodeChildProcess.ChildProcess>();
  const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string): Result => ({ code: 125, stdout: "", stderr });

  function labelsOf(args: string[]) {
    return Object.fromEntries(
      args.flatMap((arg, index) => {
        const value = args[index + 1];
        if (arg !== "--label" || value === undefined) {
          return [];
        }
        const at = value.indexOf("=");
        return [[value.slice(0, at), value.slice(at + 1)]];
      }),
    );
  }

  function inspect(kind: keyof typeof resources, name: string) {
    const item = resources[kind].get(name);
    if (item === undefined) {
      return fail(`Error: no such ${kind} ${name}`);
    }
    const body =
      kind === "container"
        ? {
            Config: {
              Labels: item.labels,
              Image: item.args.find((arg) => arg.startsWith("localhost/")),
            },
            State: { Running: item.running, OOMKilled: false },
          }
        : kind === "network"
          ? { labels: item.labels }
          : { Labels: item.labels };
    return ok(JSON.stringify([body]));
  }

  const podman: Podman = {
    run: async (args, env = {}) => {
      calls.push({ args, env });
      const [verb, sub, ...rest] = args;
      if ((verb === "container" || verb === "network" || verb === "volume") && sub === "inspect") {
        return inspect(verb, rest[0] ?? "");
      }
      if ((verb === "network" || verb === "volume") && sub === "create") {
        const name = args.at(-1) ?? "";
        resources[verb].set(name, { labels: labelsOf(args), args, running: false });
        return ok();
      }
      if (verb === "create") {
        const name = args[args.indexOf("--name") + 1] ?? "";
        if (failCreate?.(name)) {
          return fail("Error: image not known");
        }
        resources.container.set(name, { labels: labelsOf(args), args, running: false });
        return ok();
      }
      if (verb === "start" || verb === "stop") {
        for (const name of args.slice(1).filter((arg) => resources.container.has(arg))) {
          resources.container.get(name)!.running = verb === "start";
        }
        return ok();
      }
      if (verb === "rm") {
        for (const name of args) {
          resources.container.delete(name);
        }
        return ok();
      }
      if (verb === "unshare") {
        return ok();
      }
      if (verb === "ps") {
        const list = [...resources.container].filter(([, item]) => item.running);
        return ok(
          JSON.stringify(list.map(([name, item]) => ({ Names: [name], Labels: item.labels }))),
        );
      }
      if (verb === "exec") {
        const execId = args.at(-1) ?? "";
        execs.get(execId)?.kill("SIGKILL");
        return ok();
      }
      return fail(`fake podman: unhandled ${args.join(" ")}`);
    },
    host: async () => fail("sudo: a password is required"),
    spawn: (args, env): Child => {
      calls.push({ args, env });
      const script = args.indexOf("-c");
      const execId = args[script + 2] ?? "";
      const [command = "", ...rest] = args.slice(script + 3);
      const child = NodeChildProcess.spawn(command, rest, {
        env,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      execs.set(execId, child);
      const exited = new Promise<number | null>((resolve) => {
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code));
      });
      child.stdin.on("error", () => {});
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        kill: () => child.kill("SIGKILL"),
        exited,
      };
    },
  };
  return { podman, resources, calls };
}
