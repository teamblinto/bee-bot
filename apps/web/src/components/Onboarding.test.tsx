// @vitest-environment jsdom
import type { BoxAvailability, EngineStatus } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import type { ConnectionState } from "../serverConnection";

const { postCommand, current } = vi.hoisted(() => ({
  postCommand: vi.fn(),
  current: { state: undefined as ConnectionState | undefined },
}));
vi.mock("../serverConnection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../serverConnection")>();
  return {
    ...actual,
    postCommand,
    requestNotifications: vi.fn(),
    checkEngine: vi.fn(),
    fetchHost: vi.fn(async () => ({ os: "windows", linuxFamily: null })),
    subscribeToConnection: () => () => undefined,
    getConnectionState: () => current.state ?? actual.getConnectionState(),
  };
});

const { getConnectionState } =
  await vi.importActual<typeof import("../serverConnection")>("../serverConnection");
const { Onboarding } = await import("./Onboarding");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  postCommand.mockReset();
  postCommand.mockResolvedValue({ ok: true, body: { ok: true } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const healthy: EngineStatus = {
  cliFound: true,
  version: "2.1.0",
  auth: "authenticated",
  email: "owner@example.com",
  pauseReason: null,
};

const ready: BoxAvailability = {
  machine: "beebot",
  podmanFound: true,
  machineFound: true,
  boxdInstalled: true,
  imageBuilt: true,
  available: true,
  settingUp: false,
  progress: null,
  problem: null,
};

async function show(
  engine: EngineStatus,
  boxAvailability: BoxAvailability = ready,
  usageData: boolean | null = false,
) {
  const initial = getConnectionState();
  const state: ConnectionState = {
    ...initial,
    status: "connected",
    engine,
    boxAvailability,
    chat: { ...initial.chat, usageData, vault: { apiKeys: ["claude"] } },
  };
  current.state = state;
  await act(async () =>
    root.render(<Onboarding connection={state} onCreated={vi.fn()} onNotNow={vi.fn()} />),
  );
}

const button = (label: string) =>
  [...host.querySelectorAll("button")].find(({ textContent }) => textContent === label);

it("installs a missing Claude Code from a terminal window, showing the command too", async () => {
  await show({
    ...healthy,
    cliFound: false,
    version: null,
    email: null,
    pauseReason: "cli_missing",
  });
  expect(button("Continue")?.disabled).toBe(true);
  expect(host.textContent).toContain("irm https://claude.ai/install.ps1 | iex");
  await act(async () => button("Install")?.click());
  expect(postCommand).toHaveBeenCalledWith({ type: "open-setup-terminal", step: "claude-install" });
  expect(host.textContent).toContain("Finish in the terminal window");
});

it("shows a refused terminal window, keeping the command to copy", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "No terminal found." });
  await show({ ...healthy, auth: "unauthenticated", email: null, pauseReason: "auth_failed" });
  await act(async () => button("Sign in")?.click());
  expect(postCommand).toHaveBeenCalledWith({ type: "open-setup-terminal", step: "claude-login" });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("No terminal found.");
  expect(host.textContent).toContain("claude auth login");
});

it("offers to install Podman when it's missing", async () => {
  await show(healthy, { ...ready, podmanFound: false, machineFound: false, available: false });
  await act(async () => button("Install Podman")?.click());
  expect(postCommand).toHaveBeenCalledWith({ type: "open-setup-terminal", step: "podman-install" });
  expect(host.textContent).toContain("winget install");
});

it("looks for Podman again when the owner comes back from installing it", async () => {
  await show(healthy, { ...ready, podmanFound: false, machineFound: false, available: false });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(postCommand).toHaveBeenCalledWith({ type: "set-up-boxes" });
});

it("doesn't start setup on focus when Podman is already there", async () => {
  await show(healthy, { ...ready, available: false, problem: "Not set up yet" });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(postCommand).not.toHaveBeenCalledWith({ type: "set-up-boxes" });
});

it("lets the owner skip computers once Claude works, and continue only with both", async () => {
  await show(healthy, { ...ready, available: false, problem: "The box image isn't built." });
  expect(button("Continue")?.disabled).toBe(true);
  expect(button("Skip for now")?.disabled).toBe(false);
  act(() => button("Skip for now")?.click());
  expect(host.textContent).toContain("Create your first bot");

  act(() => root.render(null));
  await show(healthy);
  expect(button("Skip for now")).toBeUndefined();
  act(() => button("Continue")?.click());
  expect(host.textContent).toContain("Create your first bot");
});

it("asks about usage data once and hides the question after the answer", async () => {
  await show(healthy, ready, null);
  expect(postCommand).toHaveBeenCalledWith({ type: "track", event: "onboarding_viewed" });
  await act(async () => button("No thanks")?.click());
  expect(postCommand).toHaveBeenCalledWith({ type: "set-usage-data", on: false });

  await show(healthy, ready, false);
  expect(button("No thanks")).toBeUndefined();
  expect(button("Turn on")).toBeUndefined();
});

it("turns usage data on from the question", async () => {
  await show(healthy, ready, null);
  await act(async () => button("Turn on")?.click());
  expect(postCommand).toHaveBeenCalledWith({ type: "set-usage-data", on: true });
});
