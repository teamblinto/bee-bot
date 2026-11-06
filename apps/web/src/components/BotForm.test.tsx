// @vitest-environment jsdom
import type { Bot } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { postCommand, models } = vi.hoisted(() => ({
  postCommand: vi.fn(),
  models: {
    claude: [{ id: "sonnet", label: "Sonnet 5.5", efforts: [] }],
    codex: [{ id: "gpt-5.5", label: "GPT-5.5", efforts: [] }],
  },
}));
vi.mock("../serverConnection", () => ({
  postCommand,
  subscribeToConnection: () => () => undefined,
  getConnectionState: () => ({ models }),
}));

const { BotForm } = await import("./BotForm");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  postCommand.mockReset();
  HTMLElement.prototype.hidePopover = vi.fn();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const warning = "~/.codex/rules";

const show = (bot?: Bot) =>
  act(() =>
    root.render(
      <BotForm bot={bot} submitLabel="Create bot" onSaved={vi.fn()}>
        {null}
      </BotForm>,
    ),
  );

function pickCodex() {
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Codex"]')?.click());
  act(() => host.querySelector<HTMLElement>('[role="option"]')?.click());
}

it("creates a bot on Codex with the Codex model it picked, and warns first", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  show();
  expect(host.textContent).not.toContain(warning);

  const name = host.querySelector("input") as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(name, "Ada");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  pickCodex();
  expect(host.textContent).toContain(warning);

  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(postCommand).toHaveBeenCalledWith(
    expect.objectContaining({ type: "create-bot", engineAccountId: "codex", model: "gpt-5.5" }),
  );
});

it("warns when editing a bot that's already on Codex", () => {
  show({
    id: "b",
    name: "Ada",
    personality: "",
    status: "ready",
    pauseReason: null,
    roomId: "r",
    engineAccountId: "codex",
    model: "gpt-5.5",
    effort: null,
    mode: "build",
    access: "supervised",
    avatarSeed: 7,
    projectPath: null,
  });
  expect(host.textContent).toContain(warning);
});
