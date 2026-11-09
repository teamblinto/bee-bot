import { expect, it } from "vite-plus/test";

import { type BoxHost, createBoxService, type MachineProbe } from "./boxSetup.ts";
import { createFakeBoxRuntime } from "./boxRuntime.ts";

function setup(machines: Record<string, MachineProbe>) {
  const calls: string[] = [];
  let machine = Object.keys(machines)[0] ?? "";
  const service = createBoxService({
    machine: () => machine,
    probe: async (name) =>
      machines[name] ?? { found: false, running: false, boxdInstalled: false, imageBuilt: false },
    buildImage: async (name) => {
      calls.push(`build ${name}`);
    },
    startHost: async (name): Promise<BoxHost> => {
      calls.push(`start ${name}`);
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
  });
  return { service, calls, use: (name: string) => (machine = name) };
}

const bare = { found: true, running: true, boxdInstalled: false, imageBuilt: false };

it("says how to create a machine it can't find, and starts nothing", async () => {
  const { service, calls, use } = setup({});
  use("beebot-dev");
  await service.setUp();
  expect(service.availability()).toMatchObject({ machineFound: false, available: false });
  expect(service.availability().problem).toContain("podman machine init beebot-dev");
  expect(calls).toEqual([]);
  await expect(service.runtime.snapshot("bot-1")).rejects.toThrow("Set them up");
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

it("starts on its own once set up, and moves to a newly chosen machine", async () => {
  const ready = { ...bare, boxdInstalled: true, imageBuilt: true };
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
  expect(service.availability().problem).toContain("podman machine start other");
});
