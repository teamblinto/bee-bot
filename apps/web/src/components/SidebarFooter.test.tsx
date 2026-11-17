// @vitest-environment jsdom
import type { DesktopUpdateState } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { getConnectionState } from "../serverConnection";
import { SidebarFooter } from "./SidebarFooter";

const { sendCommand } = vi.hoisted(() => ({ sendCommand: vi.fn() }));
vi.mock("../serverConnection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../serverConnection")>()),
  sendCommand,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete window.beeDesktop;
});

const render = () =>
  act(async () =>
    root.render(<SidebarFooter connection={getConnectionState()} onUsage={() => {}} />),
  );

it("shows no update line in a desktop build without updates", async () => {
  window.beeDesktop = { pickFolder: async () => null };
  await render();
  expect(host.textContent).not.toMatch(/update/i);
});

it("follows pushed update state and restarts into a ready update", async () => {
  let push = (_: DesktopUpdateState) => {};
  const install = vi.fn(async () => {});
  window.beeDesktop = {
    pickFolder: async () => null,
    updates: {
      getState: async () => ({ status: "idle" }),
      onState: (listener) => {
        push = listener;
        return () => {};
      },
      install,
    },
  };
  await render();
  expect(host.textContent).not.toMatch(/update/i);

  act(() => push({ status: "downloading", version: "1.2.0", percent: 41.6 }));
  expect(host.textContent).toContain("Downloading update · 42%");

  act(() => push({ status: "ready", version: "1.2.0" }));
  const restart = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Restart"),
  );
  act(() => restart?.click());
  expect(install).toHaveBeenCalledOnce();
});

it("turns usage data on and off from its switch", async () => {
  const chat = { ...getConnectionState().chat, usageData: true };
  await act(async () =>
    root.render(
      <SidebarFooter connection={{ ...getConnectionState(), chat }} onUsage={() => {}} />,
    ),
  );
  const toggle = host.querySelector<HTMLInputElement>('input[role="switch"]');
  expect(toggle?.checked).toBe(true);
  act(() => toggle?.click());
  expect(sendCommand).toHaveBeenCalledWith({ type: "set-usage-data", on: false });
});
