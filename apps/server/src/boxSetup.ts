import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import type { BoxAvailability, BoxState } from "@beebot/contracts";
import { z } from "zod";

import type { SidecarEndpoint } from "./browserCdp.ts";
import { podmanEnv } from "./boxdRuntime.ts";
import type { BoxAttach, BoxRuntime } from "./boxRuntime.ts";

export const defaultBoxMachine = "podman-machine-default";

const imageDir = NodePath.resolve(import.meta.dirname, "../../../images/box");

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

// Read-only: Bee never creates, starts or removes a Podman machine.
export function podmanMachine(bin: string, installDir: string) {
  return {
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
          "machine",
          "ssh",
          machine,
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
    return `${probe.podmanProblem} Install Podman, then create a machine for boxes.`;
  }
  if (!probe.found) {
    return `There's no Podman machine named ${machine}. Create one in a terminal with "podman machine init ${machine}" and "podman machine start ${machine}", or enter the name of one you have.`;
  }
  if (!probe.running) {
    return `The Podman machine ${machine} isn't running. Start it with "podman machine start ${machine}".`;
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
  buildImage,
  startHost,
}: {
  machine: () => string;
  probe: (machine: string) => Promise<MachineProbe>;
  buildImage: (machine: string) => Promise<void>;
  startHost: (machine: string) => Promise<BoxHost>;
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
    const found = await probe(name);
    let problem = found.running ? null : problemText(name, found);
    try {
      if (setUp && found.running && !found.imageBuilt) {
        await buildImage(name);
        found.imageBuilt = true;
      }
      if (!host && found.running && found.imageBuilt && (setUp || found.boxdInstalled)) {
        const started = await startHost(name);
        found.boxdInstalled = true;
        host = { machine: name, host: started };
        void started.closed.then(() => {
          if (host?.host === started) {
            host = undefined;
            set({ available: false, problem: "Boxes stopped unexpectedly. Set them up again." });
          }
        });
      }
      if (!host && problem === null) {
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
