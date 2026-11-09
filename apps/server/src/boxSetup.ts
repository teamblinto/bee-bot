import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers/promises";

import type { BoxAvailability, BoxState } from "@beebot/contracts";
import { z } from "zod";

import type { SidecarEndpoint } from "./browserCdp.ts";
import { MachineRestartNeeded, machineSsh, podmanEnv } from "./boxdRuntime.ts";
import { boxRoot } from "./boxHost.ts";
import type { BoxAttach, BoxRuntime } from "./boxRuntime.ts";
import {
  buildProgress,
  initProgress,
  noticeable,
  type SetupProgress,
  step,
} from "./setupProgress.ts";

// Bee's own machine, so creating and starting it never touches one the owner made.
export const defaultBoxMachine = "beebot";

// A box is a 2 GiB engine container and a 1 GiB browser container. WSL ignores this and shares
// the host's memory.
const machineMemoryMiB = 4096;

// boxd that ran this long and then went away is brought back once by itself.
const reconnectAfterMs = 60_000;

const imageDir = NodePath.join(boxRoot, "images/box");

export type MachineProbe = {
  found: boolean;
  running: boolean;
  boxdInstalled: boolean;
  imageBuilt: boolean;
  // Podman itself is missing or broken.
  podmanProblem?: string;
};

// `onLine` sees each line of either stream as it arrives; progress bars end lines
// with a carriage return.
function podman(bin: string, args: string[], onLine?: (line: string) => void) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = NodeChildProcess.spawn(bin, args, { env: podmanEnv(), windowsHide: true });
    let stdout = "";
    let stderr = "";
    const partial = { stdout: "", stderr: "" };
    const lines = (stream: keyof typeof partial, chunk: Buffer) => {
      if (onLine) {
        const parts = (partial[stream] + String(chunk)).split(/\r?\n|\r/);
        partial[stream] = parts.pop() ?? "";
        parts.forEach((line) => onLine(line.trim()));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + String(chunk)).slice(-64_000);
      lines("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-4000);
      lines("stderr", chunk);
    });
    child.on("error", (error) => resolve({ code: null, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

const boxImage = () =>
  z
    .object({ image: z.string() })
    .parse(JSON.parse(NodeFs.readFileSync(NodePath.join(imageDir, "runSpec.json"), "utf8"))).image;

async function machineCommand(
  bin: string,
  args: string[],
  failed: string,
  onLine?: (line: string) => void,
) {
  const result = await podman(bin, ["machine", ...args], onLine);
  if (result.code !== 0) {
    throw new Error(`${failed}: ${result.stderr.trim().split("\n").at(-1)}`);
  }
}

// Never removes a machine, and stops one only to restart it. Rootless: boxd runs as the machine's
// own user either way (see machineSsh).
export function podmanMachine(bin: string, installDir: string) {
  return {
    init: (machine: string, onProgress: (progress: SetupProgress) => void) => {
      const follow = initProgress();
      return machineCommand(
        bin,
        ["init", "--memory", String(machineMemoryMiB), machine],
        "The Podman machine wasn't created",
        (line) => {
          const next = follow(line);
          if (next) {
            onProgress(next);
          }
        },
      );
    },
    start: (machine: string) =>
      machineCommand(bin, ["start", machine], "The Podman machine didn't start"),
    stop: (machine: string) =>
      machineCommand(bin, ["stop", machine], "The Podman machine didn't stop"),
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
      // `image exists` answers 1 for a missing image; anything else is the machine unreachable,
      // as it is while stopping, and must not read as an image to build.
      if (image.code !== 0 && image.code !== 1) {
        return { ...none, found: true };
      }
      return {
        found: true,
        running: true,
        boxdInstalled: boxd.code === 0,
        imageBuilt: image.code === 0,
      };
    },
    buildImage: async (machine: string, onProgress: (progress: SetupProgress) => void) => {
      const follow = buildProgress();
      const result = await podman(
        bin,
        ["--connection", machine, "build", "-t", boxImage(), imageDir],
        (line) => {
          const next = follow(line);
          if (next) {
            onProgress(next);
          }
        },
      );
      if (result.code !== 0) {
        throw new Error(`The box image didn't build: ${result.stderr.trim().split("\n").at(-1)}`);
      }
    },
  };
}

function problemText(machine: string, probe: MachineProbe) {
  if (probe.podmanProblem) {
    return `${probe.podmanProblem} Install it from podman.io, then set up again.`;
  }
  if (!probe.found) {
    return `There's no Podman machine named ${machine} yet. Setting up creates it.`;
  }
  if (!probe.running) {
    return `The Podman machine ${machine} isn't running. Setting up starts it.`;
  }
  return "Computers for your bots aren't set up yet.";
}

export type BoxHost = {
  runtime: BoxRuntime;
  prepare: (botId: string) => Promise<void>;
  applyEgress: (botId: string) => Promise<void>;
  sidecar: (botId: string) => Promise<SidecarEndpoint>;
  display: (botId: string, lease?: string) => Promise<BoxAttach>;
  control: (botId: string, lease: string) => Promise<BoxAttach>;
  // The tail of boxd's own log, for when it stops on its own.
  stderr: () => string;
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
  stopMachine,
  buildImage,
  startHost,
  setUpBefore,
  markSetUp,
  reconnectWaitsMs = [5_000, 15_000, 45_000],
}: {
  machine: () => string;
  probe: (machine: string) => Promise<MachineProbe>;
  initMachine: (machine: string, onProgress: (progress: SetupProgress) => void) => Promise<void>;
  startMachine: (machine: string) => Promise<void>;
  stopMachine: (machine: string) => Promise<void>;
  buildImage: (machine: string, onProgress: (progress: SetupProgress) => void) => Promise<void>;
  startHost: (machine: string) => Promise<BoxHost>;
  // Whether boxes once came up in this machine, which makes it Bee's to start after a reboot.
  setUpBefore: (machine: string) => boolean;
  markSetUp: (machine: string) => void;
  reconnectWaitsMs?: number[];
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
    progress: null,
    problem: "Checking for boxes.",
  };
  let queue = Promise.resolve();

  function set(next: Partial<BoxAvailability>) {
    status = { ...status, ...next };
    for (const listener of listeners) {
      listener(status);
    }
  }

  function progress(next: SetupProgress) {
    if (noticeable(status.progress, next)) {
      set({ settingUp: true, progress: next });
    }
  }

  // boxd may first need its machine restarted for container limits to hold; that happens once.
  async function startDaemon(name: string) {
    try {
      return await startHost(name);
    } catch (error) {
      if (!(error instanceof MachineRestartNeeded)) {
        throw error;
      }
      progress(step("Restarting the Linux machine to turn on resource limits"));
      await stopMachine(name);
      await startMachine(name);
      progress(step("Starting the computer service"));
      return startHost(name);
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
          progress(step("Downloading the Linux machine"));
          await initMachine(name, progress);
          found = { ...found, found: true };
          set({ machineFound: true });
        }
        progress(step("Starting the Linux machine"));
        await startMachine(name);
        found = await probe(name);
      }
      if ((setUp || recover) && found.running && !found.imageBuilt) {
        set({ machineFound: true });
        progress(step("Preparing the computer's software"));
        await buildImage(name, progress);
        found.imageBuilt = true;
      }
      if (!host && found.running && found.imageBuilt && (setUp || recover || found.boxdInstalled)) {
        set({ machineFound: true, imageBuilt: true });
        progress(step("Starting the computer service"));
        const started = await startDaemon(name);
        found.boxdInstalled = true;
        markSetUp(name);
        host = { machine: name, host: started };
        const since = Date.now();
        void started.closed.then(() => {
          if (host?.host !== started) {
            return;
          }
          host = undefined;
          console.error(`beebotd: boxd stopped after ${Date.now() - since} ms
${started.stderr()}`);
          set({ available: false });
          // One that ran a while came down from outside (a reboot, the machine stopping); one that
          // dies straight away would only die again.
          if (Date.now() - since > reconnectAfterMs) {
            void reconnect();
          } else {
            set({ problem: "The computers stopped. Set them up again." });
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
      progress: null,
      problem: host ? null : problem,
    });
  }

  // A machine that just went down may still be stopping, so each try waits a little longer.
  async function reconnect() {
    for (const wait of reconnectWaitsMs) {
      set({ settingUp: true, progress: step("Reconnecting to the computers"), problem: null });
      await NodeTimers.setTimeout(wait);
      if (host) {
        return;
      }
      await enqueue(false);
      if (host) {
        return;
      }
    }
  }

  function enqueue(setUp: boolean) {
    queue = queue
      .then(() => check(setUp))
      .catch((error: unknown) => {
        set({
          settingUp: false,
          progress: null,
          available: host !== undefined,
          problem: String(error),
        });
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
