import { expect, it } from "vite-plus/test";

import { type BoxHost, createBoxService, type MachineProbe } from "./boxSetup.ts";
import { createFakeBoxRuntime } from "./boxRuntime.ts";

const absent = { found: false, running: false, boxdInstalled: false, imageBuilt: false };

function setup(machines: Record<string, MachineProbe>, setUpBefore: string[] = []) {
  const calls: string[] = [];
  const marked = new Set(setUpBefore);
  let machine = Object.keys(machines)[0] ?? "";
  const service = createBoxService({
    machine: () => machine,
    probe: async (name) => ({ ...(machines[name] ?? absent) }),
    initMachine: async (name) => {
      calls.push(`init ${name}`);
      machines[name] = { ...absent, found: true };
    },
    startMachine: async (name) => {
      calls.push(`start machine ${name}`);
      const stopped = machines[name] ?? absent;
      machines[name] = { ...stopped, running: true };
    },
    buildImage: async (name) => {
      calls.push(`build ${name}`);
      const built = machines[name] ?? absent;
      machines[name] = { ...built, imageBuilt: true };
    },
    startHost: async (name): Promise<BoxHost> => {
      calls.push(`start ${name}`);
      const installed = machines[name] ?? absent;
      machines[name] = { ...installed, boxdInstalled: true };
      return {
        runtime: createFakeBoxRuntime(),
        prepare: async () => {},
        applyEgress: async () => {},
        sidecar: async () => Promise.reject(new Error("no sidecar")),
        display: async () => Promise.reject(new Error("no display")),
        control: async () => Promise.reject(new Error("no display")),
        closed: new Promise(() => {}),
        close: async () => {
          calls.push(`close ${name}`);
        },
      };
    },
    setUpBefore: (name) => marked.has(name),
    markSetUp: (name) => {
      marked.add(name);
    },
  });
  return { service, calls, marked, use: (name: string) => (machine = name) };
}

const bare = { found: true, running: true, boxdInstalled: false, imageBuilt: false };
const ready = { ...bare, boxdInstalled: true, imageBuilt: true };

it("leaves a missing machine alone until the owner sets up, then creates and starts it", async () => {
  const { service, calls, marked, use } = setup({});
  use("beebot");
  await service.refresh();
  expect(calls).toEqual([]);
  expect(service.availability().problem).toContain("Set up boxes to create it");
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
  expect(service.availability().problem).toContain("Set up boxes to start it");
});

it("installs nothing when Podman is missing", async () => {
  const { service, calls } = setup({
    beebot: { ...absent, podmanProblem: "Podman isn't installed." },
  });
  await service.setUp();
  expect(calls).toEqual([]);
  expect(service.availability().problem).toContain("Podman installer");
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
