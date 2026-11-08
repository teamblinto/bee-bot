// @vitest-environment jsdom
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

const notice = "consumer terms don't allow automated access";

function show(automatedAccessAcknowledgedAt: string | null) {
  const initial = getConnectionState();
  const state: ConnectionState = {
    ...initial,
    boxAvailability: {
      machine: "beebot",
      machineFound: true,
      boxdInstalled: true,
      imageBuilt: true,
      available: true,
      settingUp: false,
      problem: null,
    },
    chat: {
      ...initial.chat,
      noticeAcknowledgedAt: "2026-11-08T00:00:00.000Z",
      automatedAccessAcknowledgedAt,
      vault: { apiKeys: ["claude"] },
    },
  };
  current.state = state;
  act(() => root.render(<Onboarding connection={state} onCreated={vi.fn()} onNotNow={vi.fn()} />));
}

it("stops at the automated-access notice until the owner has read it", async () => {
  show(null);
  expect(host.textContent).toContain(notice);
  expect(host.textContent).not.toContain("Create your first bot");
  const button = [...host.querySelectorAll("button")].find(
    ({ textContent }) => textContent === "I understand",
  );
  await act(async () => button?.click());
  expect(postCommand).toHaveBeenCalledWith({ type: "acknowledge-automated-access" });
});

it("shows the notice again on a new bot put in a box, which runs on the API key by default", () => {
  show("2026-11-08T00:00:00.000Z");
  expect(host.textContent).toContain("Create your first bot");
  expect(host.textContent).not.toContain(notice);
  const box = [...host.querySelectorAll("label")]
    .find(({ textContent }) => textContent === "Run in a box")
    ?.querySelector("input");
  act(() => box?.click());
  expect(host.textContent).toContain(notice);
  const lane = [...host.querySelectorAll("label")]
    .find(({ textContent }) => textContent?.startsWith("On its own, it uses"))
    ?.querySelector("select");
  expect(lane?.value).toBe("api_key");
});
