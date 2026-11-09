// @vitest-environment jsdom
import type { Bot, HostControlAvailability } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { postCommand, models, chat, server } = vi.hoisted(() => ({
  postCommand: vi.fn(),
  server: { hostControl: undefined as HostControlAvailability | undefined },
  chat: {
    accounts: [{ id: "codex", label: "Codex", lane: "subscription", blockedUntil: null }],
    vault: { apiKeys: [] as string[] },
    automatedAccessAcknowledgedAt: "2026-11-08T00:00:00.000Z" as string | null,
  },
  models: {
    claude: [{ id: "sonnet", label: "Sonnet 5.5", efforts: [] }],
    codex: [{ id: "gpt-5.5", label: "GPT-5.5", efforts: [] }],
  },
}));
vi.mock("../serverConnection", () => ({
  postCommand,
  subscribeToConnection: () => () => undefined,
  getConnectionState: () => ({ models, chat, hostControl: server.hostControl }),
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

it("switches the engine's login before saving, and only when it changed", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  show();
  const name = host.querySelector("input") as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(name, "Ada");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  pickCodex();
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(postCommand.mock.calls.map(([command]) => command.type)).toEqual(["create-bot"]);

  postCommand.mockReset();
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  const login = host.querySelector("select") as HTMLSelectElement;
  act(() => {
    login.value = "api_key";
    login.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(postCommand).toHaveBeenCalledOnce();
  expect(postCommand).toHaveBeenCalledWith({
    type: "set-account-lane",
    engineAccountId: "codex",
    lane: "api_key",
  });
});

const ada: Bot = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Ada",
  personality: "",
  summary: null,
  status: "ready",
  pauseReason: null,
  roomId: "r",
  engineAccountId: "claude",
  model: "sonnet",
  effort: null,
  mode: "build",
  access: "supervised",
  profile: "operator",
  boundary: "host",
  manifest: [],
  control: "none",
  egressAnySite: true,
  egressHosts: [],
  unattendedLane: "api_key",
  avatarSeed: 7,
  projectPath: null,
};

const radio = (control: string) =>
  host.querySelector<HTMLInputElement>(`input[type="radio"][value="${control}"]`);
const submitButton = () => host.querySelector<HTMLButtonElement>('button[type="submit"]');

it("saves the control mode the owner picks", async () => {
  postCommand.mockResolvedValue({ ok: true, body: ada });
  show(ada);
  act(() => radio("computer")?.click());
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(postCommand.mock.calls.map(([command]) => command)).toEqual([
    expect.objectContaining({ type: "update-bot" }),
    { type: "set-bot-control", botId: ada.id, control: "computer" },
  ]);
});

it("keeps the form open with the refusal when the mode can't change yet", async () => {
  const onSaved = vi.fn();
  postCommand.mockImplementation(async ({ type }: { type: string }) =>
    type === "set-bot-control"
      ? { ok: false, message: "This bot is working." }
      : { ok: true, body: ada },
  );
  act(() =>
    root.render(
      <BotForm bot={ada} submitLabel="Save" onSaved={onSaved}>
        {null}
      </BotForm>,
    ),
  );
  act(() => radio("browser")?.click());
  act(() =>
    [...host.querySelectorAll("label")]
      .find(({ textContent }) => textContent === "Any site")
      ?.querySelector("input")
      ?.click(),
  );
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(postCommand.mock.calls.map(([command]) => command.type)).toContain("set-bot-egress-hosts");
  expect(onSaved).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("This bot is working.");
});

it("moves a bot onto this computer only after the owner consents", async () => {
  server.hostControl = { available: true, problem: null, held: false };
  try {
    postCommand.mockResolvedValue({ ok: true, body: ada });
    show(ada);
    act(() => radio("host")?.click());
    expect(submitButton()?.disabled).toBe(true);
    await act(async () => host.querySelector("form")?.requestSubmit());
    expect(postCommand).not.toHaveBeenCalled();

    const consent = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (box) => box.closest("fieldset"),
    );
    act(() => consent?.click());
    expect(submitButton()?.disabled).toBe(false);
    await act(async () => host.querySelector("form")?.requestSubmit());
    expect(postCommand).toHaveBeenLastCalledWith({
      type: "set-bot-control",
      botId: ada.id,
      control: "host",
    });
  } finally {
    server.hostControl = undefined;
  }
});

it("offers this computer only when the server can drive it, saying why not", () => {
  server.hostControl = { available: false, problem: "Only the Windows app can.", held: false };
  try {
    show(ada);
    expect(radio("host")?.disabled).toBe(true);
    expect(host.textContent).toContain("Only the Windows app can.");
    act(() => root.render(null));
    show({ ...ada, control: "host" });
    expect(radio("host")?.disabled).toBe(false);
    expect(submitButton()?.disabled).toBe(false);
  } finally {
    server.hostControl = undefined;
  }
});

it("saves a boxed bot's sites and its opt-in to the subscription", async () => {
  const bot: Bot = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Ada",
    personality: "",
    summary: null,
    status: "ready",
    pauseReason: null,
    roomId: "r",
    engineAccountId: "claude",
    model: "sonnet",
    effort: null,
    mode: "build",
    access: "supervised",
    profile: "operator",
    boundary: "box",
    manifest: [],
    control: "none",
    egressAnySite: false,
    egressHosts: ["pypi.org"],
    unattendedLane: "api_key",
    avatarSeed: 7,
    projectPath: null,
  };
  chat.vault.apiKeys = ["claude"];
  try {
    postCommand.mockResolvedValue({ ok: true, body: bot });
    show(bot);
    const site = host.querySelector<HTMLInputElement>('input[aria-label="Site to allow"]');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setValue?.call(site, " Files.PythonHosted.org ");
      site?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() =>
      [...host.querySelectorAll("button")]
        .find(({ textContent }) => textContent === "Add")
        ?.click(),
    );
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove pypi.org"]')?.click());
    const lane = [...host.querySelectorAll("label")]
      .find(({ textContent }) => textContent?.startsWith("On its own, it uses"))
      ?.querySelector("select");
    act(() => {
      if (lane) {
        lane.value = "subscription";
        lane.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await act(async () => host.querySelector("form")?.requestSubmit());
    expect(postCommand.mock.calls.map(([command]) => command)).toEqual([
      expect.objectContaining({ type: "update-bot" }),
      {
        type: "set-bot-egress-hosts",
        botId: bot.id,
        anySite: false,
        hosts: ["files.pythonhosted.org"],
      },
      { type: "set-bot-unattended-lane", botId: bot.id, lane: "subscription" },
    ]);
  } finally {
    chat.vault.apiKeys = [];
  }
});

it("narrows a bot with a browser but no box from any site to its own list", async () => {
  const bot: Bot = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Ada",
    personality: "",
    summary: null,
    status: "ready",
    pauseReason: null,
    roomId: "r",
    engineAccountId: "claude",
    model: "sonnet",
    effort: null,
    mode: "build",
    access: "supervised",
    profile: "operator",
    boundary: "host",
    manifest: [],
    control: "browser",
    egressAnySite: true,
    egressHosts: [],
    unattendedLane: "api_key",
    avatarSeed: 7,
    projectPath: null,
  };
  postCommand.mockResolvedValue({ ok: true, body: bot });
  show(bot);
  expect(host.querySelector('input[aria-label="Site to allow"]')).toBeNull();
  act(() =>
    [...host.querySelectorAll("label")]
      .find(({ textContent }) => textContent === "Any site")
      ?.querySelector("input")
      ?.click(),
  );
  const site = host.querySelector<HTMLInputElement>('input[aria-label="Site to allow"]');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(site, "www.wikipedia.org");
    site?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() =>
    [...host.querySelectorAll("button")].find(({ textContent }) => textContent === "Add")?.click(),
  );
  await act(async () => host.querySelector("form")?.requestSubmit());
  expect(postCommand.mock.calls.map(([command]) => command)).toEqual([
    expect.objectContaining({ type: "update-bot" }),
    {
      type: "set-bot-egress-hosts",
      botId: bot.id,
      anySite: false,
      hosts: ["www.wikipedia.org"],
    },
  ]);
});

it("offers the subscription only after the automated-access notice was read", () => {
  chat.vault.apiKeys = ["claude"];
  chat.automatedAccessAcknowledgedAt = null;
  try {
    show({
      id: "b",
      name: "Ada",
      personality: "",
      summary: null,
      status: "ready",
      pauseReason: null,
      roomId: "r",
      engineAccountId: "claude",
      model: "sonnet",
      effort: null,
      mode: "build",
      access: "supervised",
      profile: "operator",
      boundary: "box",
      manifest: [],
      control: "none",
      egressAnySite: true,
      egressHosts: [],
      unattendedLane: "api_key",
      avatarSeed: 7,
      projectPath: null,
    });
    const lane = [...host.querySelectorAll("label")]
      .find(({ textContent }) => textContent?.startsWith("On its own, it uses"))
      ?.querySelector<HTMLOptionElement>('option[value="subscription"]');
    expect(lane?.disabled).toBe(true);
  } finally {
    chat.vault.apiKeys = [];
    chat.automatedAccessAcknowledgedAt = "2026-11-08T00:00:00.000Z";
  }
});

it("warns when editing a bot that's already on Codex", () => {
  show({
    id: "b",
    name: "Ada",
    personality: "",
    summary: null,
    status: "ready",
    pauseReason: null,
    roomId: "r",
    engineAccountId: "codex",
    model: "gpt-5.5",
    effort: null,
    mode: "build",
    access: "supervised",
    profile: "operator",
    boundary: "host",
    manifest: [],
    control: "none",
    egressAnySite: true,
    egressHosts: [],
    unattendedLane: "api_key",
    avatarSeed: 7,
    projectPath: null,
  });
  expect(host.textContent).toContain(warning);
});
