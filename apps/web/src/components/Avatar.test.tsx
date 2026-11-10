// @vitest-environment jsdom
import { maxAvatarSeed } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { Avatar, avatarPartCounts, avatarParts } from "./Avatar";

const { postCommand, chat } = vi.hoisted(() => ({
  postCommand: vi.fn(),
  chat: { accounts: [], vault: { apiKeys: [] } },
}));
vi.mock("../serverConnection", () => ({
  getConnectionState: () => ({ models: undefined, chat }),
  subscribeToConnection: () => () => {},
  postCommand,
}));

const { BotForm } = await import("./BotForm");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const edges = [0, 1, 2, 12345, 2 ** 31, maxAvatarSeed - 1, maxAvatarSeed];

it("gives the same seed the same parts and hue", () => {
  for (const seed of edges) {
    expect(avatarParts(seed)).toEqual(avatarParts(seed));
  }
  expect(renderToStaticMarkup(<Avatar seed={7} />)).toBe(renderToStaticMarkup(<Avatar seed={7} />));
});

it("keeps every seed in range valid, and reaches every part", () => {
  const seen = { body: new Set(), eyes: new Set(), mouth: new Set(), accessory: new Set() };
  const seeds = [...edges, ...Array.from({ length: 20_000 }, (_, i) => (i * 214_013) >>> 0)];
  for (const seed of seeds) {
    const parts = avatarParts(seed);
    for (const key of ["body", "eyes", "mouth", "accessory"] as const) {
      expect(parts[key]).toBeLessThan(avatarPartCounts[key]);
      expect(parts[key]).toBeGreaterThanOrEqual(0);
      seen[key].add(parts[key]);
    }
    expect(parts.hue).toBeGreaterThanOrEqual(0);
    expect(parts.hue).toBeLessThan(360);
  }
  for (const key of ["body", "eyes", "mouth", "accessory"] as const) {
    expect(seen[key].size).toBe(avatarPartCounts[key]);
  }
});

it("has the promised parts and stays decorative", () => {
  expect(avatarPartCounts).toEqual({ body: 8, eyes: 8, mouth: 6, accessory: 8 });
  expect(renderToStaticMarkup(<Avatar seed={1} />)).toContain('aria-hidden="true"');
});

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  postCommand.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const bot = {
  id: "00000000-0000-4000-8000-000000000000",
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
  boundary: "host",
  manifest: [] as string[],
  control: "none",
  egressAnySite: true,
  egressHosts: [] as string[],
  unattendedLane: "api_key",
  avatarSeed: 5,
  projectPath: null,
} as const;

const preview = () => host.querySelector("svg.size-20")?.outerHTML;

it("shuffles the preview, and saves nothing until the form is saved", () => {
  act(() =>
    root.render(
      <BotForm bot={bot} submitLabel="Save" onSaved={() => {}}>
        <button type="button">Cancel</button>
      </BotForm>,
    ),
  );
  const first = preview();
  const shuffle = host.querySelector<HTMLButtonElement>('button[aria-label="Shuffle avatar"]');
  act(() => shuffle?.click());
  expect(preview()).not.toBe(first);
  expect(postCommand).not.toHaveBeenCalled();
});

it("saves the shuffled face with the form", async () => {
  postCommand.mockResolvedValue({ ok: false, message: "no" });
  act(() =>
    root.render(
      <BotForm bot={bot} submitLabel="Save" onSaved={() => {}}>
        <button type="button">Cancel</button>
      </BotForm>,
    ),
  );
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Shuffle avatar"]')?.click());
  await act(async () => {
    host.querySelector("form")?.requestSubmit();
  });
  const sent = postCommand.mock.calls[0]?.[0];
  expect(sent.type).toBe("update-bot");
  expect(sent.avatarSeed).not.toBe(bot.avatarSeed);
});
