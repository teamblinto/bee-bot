import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import type { BoxAvailability, BoxState } from "@beebot/contracts";
import { z } from "zod";

import type { SidecarEndpoint } from "./browserCdp.ts";
import { machineSsh, podmanEnv } from "./boxdRuntime.ts";
import { boxRoot } from "./boxHost.ts";
import type { BoxAttach, BoxRuntime } from "./boxRuntime.ts";

// Bee's own machine, so creating and starting it never touches one the owner made.
export const defaultBoxMachine = "beebot";

// A box is a 2 GiB engine container and a 1 GiB browser container. WSL ignores this and shares
// the host's memory.
const machineMemoryMiB = 4096;

const imageDir = NodePath.join(boxRoot, "images/box");

export type MachineProbe = {
  found: boolean;
  running: boolean;
  boxdInstalled: boolean;
  imageBuilt: boolean;
  // Podman itself is missing or broken.
  podmanProblem?: string;
};

function podman(bin: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = NodeChildProcess.spawn(bin, args, { env: podmanEnv(), windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout = (stdout + String(chunk)).slice(-64_000)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + String(chunk)).slice(-4000)));
    child.on("error", (error) => resolve({ code: null, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

const boxImage = () =>
  z
    .object({ image: z.string() })
    .parse(JSON.parse(NodeFs.readFileSync(NodePath.join(imageDir, "runSpec.json"), "utf8"))).image;

async function machineCommand(bin: string, args: string[], failed: string) {
  const result = await podman(bin, ["machine", ...args]);
  if (result.code !== 0) {
    throw new Error(`${failed}: ${result.stderr.trim().split("\n").at(-1)}`);
  }
}

// Creates and starts a machine, but never stops or removes one. Rootless: boxd runs as the
// machine's own user either way (see machineSsh).
export function podmanMachine(bin: string, installDir: string) {
  return {
    init: (machine: string) =>
      machineCommand(
        bin,
        ["init", "--memory", String(machineMemoryMiB), machine],
        "The Podman machine wasn't created",
      ),
    start: (machine: string) =>
      machineCommand(bin, ["start", machine], "The Podman machine didn't start"),
    probe: async (machine: string): Promise<MachineProbe> => {
      const none = { found: false, running: false, boxdInstalled: false, imageBuilt: false };
      const inspect = await podman(bin, ["machine", "inspect", machine]);
      if (inspect.code === null) {
        return { ...none, podmanProblem: "Podman isn't installed." };
      }
      if (inspect.code !== 0) {
        return none;
      }
      let state: string | undefined;
      try {
        state = z.array(z.object({ State: z.string() })).safeParse(JSON.parse(inspect.stdout))
          .data?.[0]?.State;
      } catch {
        state = undefined;
      }
      if (state !== "running") {
        return { ...none, found: true };
      }
      const [image, boxd] = await Promise.all([
        podman(bin, ["--connection", machine, "image", "exists", boxImage()]),
        podman(bin, [
          ...machineSsh(inspect.stdout, machine),
          `test -x "$HOME/${installDir}/node/bin/node" && test -f "$HOME/${installDir}/main.ts"`,
        ]),
      ]);
      return {
        found: true,
        running: true,
        boxdInstalled: boxd.code === 0,
        imageBuilt: image.code === 0,
      };
    },
    buildImage: async (machine: string) => {
      const result = await podman(bin, [
        "--connection",
        machine,
        "build",
        "-t",
        boxImage(),
        imageDir,
      ]);
      if (result.code !== 0) {
        throw new Error(`The box image didn't build: ${result.stderr.trim().split("\n").at(-1)}`);
      }
    },
  };
}

function problemText(machine: string, probe: MachineProbe) {
  if (probe.podmanProblem) {
    return `${probe.podmanProblem} Run the Podman installer from podman.io, then set up boxes.`;
  }
  if (!probe.found) {
    return `There's no Podman machine named ${machine} yet. Set up boxes to create it.`;
  }
  if (!probe.running) {
    return `The Podman machine ${machine} isn't running. Set up boxes to start it.`;
  }
  return "Boxes aren't set up on this machine yet.";
}

export type BoxHost = {
  runtime: BoxRuntime;
  prepare: (botId: string) => Promise<void>;
  applyEgress: (botId: string) => Promise<void>;
  sidecar: (botId: string) => Promise<SidecarEndpoint>;
  display: (botId: string, lease?: string) => Promise<BoxAttach>;
  control: (botId: string, lease: string) => Promise<BoxAttach>;
  closed: Promise<void>;
  close: () => Promise<void>;
};

// Owns the box host for the configured machine. `runtime` and `sidecar` stay the same objects for
// the server's whole life and refuse while no host is up.
export function createBoxService({
  machine,
  probe,
  initMachine,
  startMachine,
  buildImage,
  startHost,
  setUpBefore,
  markSetUp,
}: {
  machine: () => string;
  probe: (machine: string) => Promise<MachineProbe>;
  initMachine: (machine: string) => Promise<void>;
  startMachine: (machine: string) => Promise<void>;
  buildImage: (machine: string) => Promise<void>;
  startHost: (machine: string) => Promise<BoxHost>;
  // Whether boxes once came up in this machine, which makes it Bee's to start after a reboot.
  setUpBefore: (machine: string) => boolean;
  markSetUp: (machine: string) => void;
}) {
  const listeners = new Set<(availability: BoxAvailability) => void>();
  let host: { machine: string; host: BoxHost } | undefined;
  let status: BoxAvailability = {
    machine: machine(),
    machineFound: false,
    boxdInstalled: false,
    imageBuilt: false,
    available: false,
    settingUp: false,
    problem: "Checking for boxes.",
  };
  let queue = Promise.resolve();

  function set(next: Partial<BoxAvailability>) {
    status = { ...status, ...next };
    for (const listener of listeners) {
      listener(status);
    }
  }

  async function check(setUp: boolean) {
    const name = machine();
    if (host && host.machine !== name) {
      const old = host.host;
      host = undefined;
      await old.close();
    }
    set({ machine: name, settingUp: setUp, available: host !== undefined });
    let found = await probe(name);
    let problem: string | null = null;
    try {
      const recover = found.found && setUpBefore(name);
      if (!found.running && !found.podmanProblem && (setUp || recover)) {
        if (!found.found) {
          set({
            settingUp: true,
            problem: `Creating the Podman machine ${name}. The first time downloads it, which takes a few minutes.`,
          });
          await initMachine(name);
          found = { ...found, found: true };
        }
        set({
          settingUp: true,
          machineFound: true,
          problem: `Starting the Podman machine ${name}.`,
        });
        await startMachine(name);
        found = await probe(name);
      }
      if ((setUp || recover) && found.running && !found.imageBuilt) {
        set({
          settingUp: true,
          machineFound: true,
          problem: "Building the box image. The first time takes several minutes.",
        });
        await buildImage(name);
        found.imageBuilt = true;
      }
      if (!host && found.running && found.imageBuilt && (setUp || found.boxdInstalled)) {
        set({ machineFound: true, imageBuilt: true, problem: "Starting the box daemon." });
        const started = await startHost(name);
        found.boxdInstalled = true;
        markSetUp(name);
        host = { machine: name, host: started };
        void started.closed.then(() => {
          if (host?.host === started) {
            host = undefined;
            set({ available: false, problem: "Boxes stopped unexpectedly. Set them up again." });
          }
        });
      }
      if (!host) {
        problem = problemText(name, found);
      }
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    set({
      machineFound: found.found,
      boxdInstalled: found.boxdInstalled,
      imageBuilt: found.imageBuilt,
      available: host !== undefined,
      settingUp: false,
      problem: host ? null : problem,
    });
  }

  function enqueue(setUp: boolean) {
    queue = queue
      .then(() => check(setUp))
      .catch((error: unknown) => {
        set({ settingUp: false, available: host !== undefined, problem: String(error) });
      });
    return queue;
  }

  function current() {
    if (!host) {
      throw new Error("Boxes aren't set up. Set them up in Settings.");
    }
    return host.host;
  }

  const runtime: BoxRuntime = {
    create: async (botId, account) => current().runtime.create(botId, account),
    writeBotFile: async (botId, name, content) =>
      current().runtime.writeBotFile(botId, name, content),
    cdp: async (botId) => current().runtime.cdp(botId),
    capture: async (botId) => current().runtime.capture(botId),
    screenshot: async (botId) => current().runtime.screenshot(botId),
    input: async (botId, actions, signal) => current().runtime.input(botId, actions, signal),
    display: async (botId, lease) => current().runtime.display(botId, lease),
    control: async (botId, lease) => current().runtime.control(botId, lease),
    collect: async (botId, file, name) => current().runtime.collect(botId, file, name),
    start: async (botId) => current().runtime.start(botId),
    stop: async (botId) => current().runtime.stop(botId),
    snapshot: async (botId): Promise<BoxState> => current().runtime.snapshot(botId),
    execAttach: async (botId, exec) => current().runtime.execAttach(botId, exec),
  };

  return {
    runtime,
    sidecar: async (botId: string) => current().sidecar(botId),
    display: async (botId: string, lease?: string) => current().display(botId, lease),
    control: async (botId: string, lease: string) => current().control(botId, lease),
    prepare: async (botId: string) => current().prepare(botId),
    // With no host up there is no proxy to tell: a box's policy is pushed when it comes up.
    applyEgress: async (botId: string) => host?.host.applyEgress(botId),
    availability: () => status,
    ready: () => host !== undefined,
    onChange: (listener: (availability: BoxAvailability) => void) => {
      listeners.add(listener);
    },
    refresh: () => enqueue(false),
    setUp: () => enqueue(true),
    close: async () => {
      await queue;
      const old = host?.host;
      host = undefined;
      await old?.close();
    },
  };
}

export type BoxService = ReturnType<typeof createBoxService>;
