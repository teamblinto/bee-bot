// @vitest-environment jsdom
import { maxAvatarSeed } from "@beebot/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { Avatar, avatarIndex, avatars, shuffledSeed } from "./Avatar";

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

const edges = [0, 1, 2, 11, 12, 12345, 2 ** 31, maxAvatarSeed - 1, maxAvatarSeed];

it("gives every seed in range one of the designed avatars, and reaches them all", () => {
  const seen = new Set<string>();
  for (const seed of [...edges, ...Array.from({ length: 1_000 }, (_, i) => (i * 214_013) >>> 0)]) {
    const src = avatars[avatarIndex(seed)];
    expect(src).toBeDefined();
    seen.add(src ?? "");
  }
  expect(seen.size).toBe(avatars.length);
  expect(renderToStaticMarkup(<Avatar seed={7} />)).toContain('alt=""');
});

it("always shuffles to a different avatar, within the seed range", () => {
  for (const seed of edges) {
    for (let i = 0; i < 50; i++) {
      const next = shuffledSeed(seed);
      expect(avatarIndex(next)).not.toBe(avatarIndex(seed));
      expect(next).toBeLessThanOrEqual(maxAvatarSeed);
    }
  }
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
  archivedAt: null,
  dailyTokenCap: null,
  dailyUsdCap: null,
} as const;

const preview = () => host.querySelector("img.size-16")?.getAttribute("src");

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
