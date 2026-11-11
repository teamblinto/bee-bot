import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { afterEach, expect, it, vi } from "vite-plus/test";

import { type BoxHost, createBoxService, type MachineProbe, podmanMachine } from "./boxSetup.ts";
import { MachineRestartNeeded } from "./boxdRuntime.ts";
import { createFakeBoxRuntime } from "./boxRuntime.ts";

const absent = { found: false, running: false, boxdInstalled: false, imageBuilt: false };

function setup(
  machines: Record<string, MachineProbe>,
  setUpBefore: string[] = [],
  { restartsNeeded = 0, machineStartFailures = 0 } = {},
) {
  let startFailures = machineStartFailures;
  const calls: string[] = [];
  const closers: (() => void)[] = [];
  let restarts = restartsNeeded;
  const marked = new Set(setUpBefore);
  let machine = Object.keys(machines)[0] ?? "";
  const service = createBoxService({
    machine: () => machine,
    probe: async (name) => ({ ...(machines[name] ?? absent) }),
    initMachine: async (name) => {
      calls.push(`init ${name}`);
      machines[name] = { ...absent, found: true };
    },
    stopMachine: async (name) => {
      calls.push(`stop machine ${name}`);
      const running = machines[name] ?? absent;
      machines[name] = { ...running, running: false };
      restarts -= 1;
    },
    startMachine: async (name) => {
      calls.push(`start machine ${name}`);
      if (startFailures > 0) {
        startFailures -= 1;
        throw new Error("The Podman machine didn't start: it is still stopping");
      }
      const stopped = machines[name] ?? absent;
      machines[name] = { ...stopped, running: true };
    },
    buildImage: async (name, onProgress) => {
      calls.push(`build ${name}`);
      onProgress({ label: "Downloading the computer's software", fraction: 0.5, detail: null });
      const built = machines[name] ?? absent;
      machines[name] = { ...built, imageBuilt: true };
    },
    startHost: async (name): Promise<BoxHost> => {
      calls.push(`start ${name}`);
      if (restarts > 0) {
        throw new MachineRestartNeeded("boxd: container limits are not enforced");
      }
      const installed = machines[name] ?? absent;
      machines[name] = { ...installed, boxdInstalled: true };
      return {
        runtime: createFakeBoxRuntime(),
        prepare: async () => {},
        applyEgress: async () => {},
        sidecar: async () => Promise.reject(new Error("no sidecar")),
        display: async () => Promise.reject(new Error("no display")),
        control: async () => Promise.reject(new Error("no display")),
        stderr: () => "",
        closed: new Promise((resolve) => closers.push(() => resolve())),
        close: async () => {
          calls.push(`close ${name}`);
        },
      };
    },
    setUpBefore: (name) => marked.has(name),
    markSetUp: (name) => {
      marked.add(name);
    },
    reconnectWaitsMs: [0, 0, 0],
  });
  return { service, calls, marked, closers, use: (name: string) => (machine = name) };
}

const bare = { found: true, running: true, boxdInstalled: false, imageBuilt: false };
const ready = { ...bare, boxdInstalled: true, imageBuilt: true };

it("leaves a missing machine alone until the owner sets up, then creates and starts it", async () => {
  const { service, calls, marked, use } = setup({});
  use("beebot");
  await service.refresh();
  expect(calls).toEqual([]);
  expect(service.availability().problem).toContain("Setting up creates it");
  await expect(service.runtime.snapshot("bot-1")).rejects.toThrow("Set them up");
  await service.setUp();
  expect(calls).toEqual(["init beebot", "start machine beebot", "build beebot", "start beebot"]);
  expect(service.availability()).toMatchObject({
    machineFound: true,
    available: true,
    settingUp: false,
    problem: null,
  });
  expect(marked.has("beebot")).toBe(true);
});

it("waits for the owner before installing anything, then builds the image and starts boxd", async () => {
  const { service, calls } = setup({ "beebot-dev": bare });
  await service.refresh();
  expect(service.availability()).toMatchObject({ available: false, imageBuilt: false });
  expect(calls).toEqual([]);
  await service.setUp();
  expect(calls).toEqual(["build beebot-dev", "start beebot-dev"]);
  expect(service.availability()).toMatchObject({
    machineFound: true,
    boxdInstalled: true,
    imageBuilt: true,
    available: true,
    settingUp: false,
    problem: null,
  });
  expect(await service.runtime.snapshot("bot-1")).toBe("absent");
});

it("starts a stopped machine when the owner sets up", async () => {
  const { service, calls } = setup({ "beebot-dev": { ...ready, running: false } });
  await service.setUp();
  expect(calls).toEqual(["start machine beebot-dev", "start beebot-dev"]);
  expect(service.ready()).toBe(true);
});

it("starts the machine on boot when boxes came up in it before", async () => {
  const { service, calls } = setup({ "beebot-dev": { ...ready, running: false } }, ["beebot-dev"]);
  await service.refresh();
  expect(calls).toEqual(["start machine beebot-dev", "start beebot-dev"]);
  expect(service.ready()).toBe(true);
});

it("builds a new box image on boot after an update, in a machine boxes came up in before", async () => {
  const { service, calls } = setup({ "beebot-dev": { ...ready, imageBuilt: false } }, [
    "beebot-dev",
  ]);
  await service.refresh();
  expect(calls).toEqual(["build beebot-dev", "start beebot-dev"]);
  expect(service.ready()).toBe(true);
});

it("never starts a machine on boot that boxes never came up in", async () => {
  const { service, calls } = setup({ "beebot-dev": { ...ready, running: false } }, ["other"]);
  await service.refresh();
  expect(calls).toEqual([]);
  expect(service.availability().problem).toContain("Setting up starts it");
});

it("installs nothing when Podman is missing, and sees it once it is installed", async () => {
  const machines: Record<string, MachineProbe> = {
    beebot: { ...absent, podmanProblem: "Podman isn't installed." },
  };
  const { service, calls } = setup(machines);
  await service.setUp();
  expect(calls).toEqual([]);
  expect(service.availability()).toMatchObject({ podmanFound: false });
  expect(service.availability().problem).toContain("podman.io");
  machines.beebot = absent;
  await service.refresh();
  expect(service.availability()).toMatchObject({ podmanFound: true, machineFound: false });
});

it("starts on its own once set up, and moves to a newly chosen machine", async () => {
  const { service, calls, use } = setup({
    "beebot-dev": ready,
    other: { ...ready, running: false },
  });
  await service.refresh();
  expect(service.ready()).toBe(true);
  use("other");
  await service.refresh();
  expect(calls).toEqual(["start beebot-dev", "close beebot-dev"]);
  expect(service.ready()).toBe(false);
});

it("restarts the machine once when boxd needs it for container limits, then comes up", async () => {
  const { service, calls } = setup({ "beebot-dev": ready }, [], { restartsNeeded: 1 });
  await service.setUp();
  expect(calls).toEqual([
    "start beebot-dev",
    "stop machine beebot-dev",
    "start machine beebot-dev",
    "start beebot-dev",
  ]);
  expect(service.availability()).toMatchObject({ available: true, problem: null, progress: null });
});

it("restarts only once, and says why when limits still fail", async () => {
  const { service, calls } = setup({ "beebot-dev": ready }, [], { restartsNeeded: 5 });
  await service.setUp();
  expect(calls.filter((call) => call.startsWith("stop machine"))).toHaveLength(1);
  expect(service.availability()).toMatchObject({ available: false, settingUp: false });
  expect(service.availability().problem).toContain("container limits are not enforced");
});

it("reports each step while setting up and clears it when done", async () => {
  const { service } = setup({ "beebot-dev": bare });
  const seen: (string | null)[] = [];
  service.onChange(({ progress }) => {
    if (progress && seen.at(-1) !== progress.label) {
      seen.push(progress.label);
    }
  });
  await service.setUp();
  expect(seen).toEqual([
    "Preparing the computer's software",
    "Downloading the computer's software",
    "Starting the computer service",
  ]);
  expect(service.availability().progress).toBeNull();
});

afterEach(() => {
  vi.useRealTimers();
});

it("brings the computers back once when boxd goes away after running a while", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { service, calls, closers } = setup({ "beebot-dev": ready }, ["beebot-dev"]);
  await service.refresh();
  expect(service.ready()).toBe(true);
  vi.setSystemTime(Date.now() + 120_000);
  closers[0]?.();
  await vi.waitFor(() =>
    expect(calls.filter((call) => call === "start beebot-dev")).toHaveLength(2),
  );
  await vi.waitFor(() => expect(service.ready()).toBe(true));
});

it("keeps trying to bring the computers back while the machine is still stopping", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const machines = { "beebot-dev": ready };
  const { service, calls, closers } = setup(machines, ["beebot-dev"], { machineStartFailures: 1 });
  await service.refresh();
  vi.setSystemTime(Date.now() + 120_000);
  machines["beebot-dev"] = { ...ready, running: false };
  closers[0]?.();
  await vi.waitFor(() =>
    expect(calls.filter((call) => call === "start beebot-dev")).toHaveLength(2),
  );
  expect(calls.filter((call) => call === "start machine beebot-dev")).toHaveLength(2);
  expect(service.ready()).toBe(true);
  expect(service.availability().problem).toBeNull();
});

it("leaves computers down when boxd dies right after starting", async () => {
  const { service, calls, closers } = setup({ "beebot-dev": ready }, ["beebot-dev"]);
  await service.refresh();
  closers[0]?.();
  await vi.waitFor(() => expect(service.availability().available).toBe(false));
  expect(calls.filter((call) => call === "start beebot-dev")).toHaveLength(1);
  expect(service.availability().problem).toContain("Set them up again");
});

it("names what an installation is missing instead of running a build that can't succeed", async () => {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "beebot-image-"));
  NodeFs.writeFileSync(
    NodePath.join(dir, "Containerfile"),
    "FROM x\nCOPY a.sh /a\nCOPY xfce/ /etc/xfce/\n",
  );
  NodeFs.writeFileSync(NodePath.join(dir, "a.sh"), "");
  try {
    // The bin doesn't exist: reaching Podman would fail with its error, not this one.
    await expect(
      podmanMachine(NodePath.join(dir, "no-podman"), "beebot", dir).buildImage("m", () => {}),
    ).rejects.toThrow(
      "Bee Bot's installation is missing files the computer needs (xfce/). Reinstall Bee Bot.",
    );
  } finally {
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }
});
