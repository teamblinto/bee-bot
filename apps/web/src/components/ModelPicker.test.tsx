// @vitest-environment jsdom
import type { Bot, EngineModel, ModelCatalog } from "@beebot/contracts";
import { act, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ComposerControls } from "./ComposerControls";
import { effortBarHeights, resolveEffortGlyph } from "./EffortGlyph";
import { ModelPickerContent } from "./ModelPicker";
import { rankModelSearch } from "./modelPickerSearch";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const allEfforts: EngineModel["efforts"] = ["low", "medium", "high", "xhigh", "max"];
const catalog: ModelCatalog = {
  claude: [
    { id: "opus", label: "Opus 5.5", efforts: allEfforts },
    { id: "sonnet", label: "Sonnet 5.5", efforts: allEfforts },
    { id: "claude-opus-4-6", label: "Opus 4.6", efforts: ["low", "medium", "high", "max"] },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", efforts: [] },
  ],
  fake: [{ id: "sonnet", label: "Sonnet", efforts: allEfforts }],
};

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function renderPicker(
  props: Partial<Parameters<typeof ModelPickerContent>[0]> = {},
  searchRef: RefObject<HTMLInputElement | null> = createRef(),
) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  act(() =>
    root.render(
      <ModelPickerContent
        accountId="claude"
        model="sonnet"
        catalog={catalog}
        locked={false}
        searchRef={searchRef}
        onPick={onPick}
        onClose={onClose}
        {...props}
      />,
    ),
  );
  return { onPick, onClose };
}

const search = () => host.querySelector<HTMLInputElement>('[role="combobox"]') as HTMLInputElement;
const rows = () => [...host.querySelectorAll('[role="option"]')].map((row) => row.textContent);
const rail = (name: string) =>
  host.querySelector<HTMLButtonElement>(`[data-model-picker-rail] button[aria-label^="${name}"]`);
const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });

function type(text: string) {
  const input = search();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const activeRow = () => {
  const id = search().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.textContent : undefined;
};

it("searches by name and id, and says so when nothing matches", () => {
  renderPicker();
  type("sonnet");
  expect(rows()).toEqual(["Sonnet 5.5, Claude", "Sonnet, Test engine"]);
  type("claude-opus");
  expect(rows()[0]).toContain("Opus 4.6");
  type("nothing here");
  expect(rows()).toEqual([]);
  expect(host.textContent).toContain("No models found");
});

it("folds pinned versions under Show more, but never the selected model", () => {
  renderPicker();
  expect(rows()).toEqual(["Opus 5.5, Claude", "Sonnet 5.5, Claude", "Show more"]);
  act(() => root.render(null));
  renderPicker({ model: "claude-opus-4-6" });
  expect(rows()).toContain("Opus 4.6, Claude");
  expect(rows()).not.toContain("Haiku 4.5, Claude");
});

it("searches only the bot's provider once it's locked", () => {
  renderPicker({ locked: true });
  type("sonnet");
  expect(rows()).toEqual(["Sonnet 5.5, Claude"]);
});

it("ranks an exact name first and fuzzy matches last", () => {
  const items = ["Opus 5.5", "Sonnet 5.5"].map((name) => ({
    accountId: "claude",
    providerLabel: "Claude",
    name,
    id: name,
    isFavorite: false,
  }));
  expect(rankModelSearch(items, "sonnet 5.5", (item) => item)[0]?.name).toBe("Sonnet 5.5");
  expect(rankModelSearch(items, "snt", (item) => item).map(({ name }) => name)).toEqual([
    "Sonnet 5.5",
  ]);
});

it("keeps favorites across renders and opens on them when the model is one", () => {
  const { onPick } = renderPicker();
  act(() =>
    host.querySelector<HTMLButtonElement>('[aria-label="Add Sonnet 5.5 to favorites"]')?.click(),
  );
  expect(localStorage.getItem("beebot.modelFavorites")).toBe('["claude:sonnet"]');
  expect(rows()[0]).toContain("Sonnet 5.5");

  act(() => rail("Favorites")?.click());
  expect(rows()).toEqual(["Sonnet 5.5, Claude"]);
  act(() => root.render(null));
  renderPicker();
  expect(rail("Favorites")?.getAttribute("aria-pressed")).toBe("true");
  expect(onPick).not.toHaveBeenCalled();

  act(() =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Remove Sonnet 5.5 from favorites"]')
      ?.click(),
  );
  expect(host.textContent).toContain("No favorites yet");
});

it("moves with the arrow keys, wraps, picks with Enter and stops the form submitting", () => {
  const { onPick, onClose } = renderPicker();
  expect(activeRow()).toContain("Sonnet 5.5");
  press(search(), "ArrowUp");
  expect(activeRow()).toContain("Opus 5.5");
  press(search(), "ArrowUp");
  expect(activeRow()).toBe("Show more");
  press(search(), "Enter");
  expect(rows()).toContain("Opus 4.6, Claude");
  press(search(), "ArrowUp");
  expect(activeRow()).toContain("Haiku 4.5");

  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  act(() => {
    search().dispatchEvent(enter);
  });
  expect(enter.defaultPrevented).toBe(true);
  expect(onPick).toHaveBeenCalledWith("claude", "claude-haiku-4-5");
  expect(onClose).toHaveBeenCalled();
});

it("walks between the rail and the search box", () => {
  const searchRef = createRef<HTMLInputElement>();
  renderPicker({}, searchRef);
  press(search(), "ArrowLeft");
  expect(document.activeElement).toBe(rail("Claude"));
  press(rail("Claude") as Element, "ArrowUp");
  expect(document.activeElement).toBe(rail("Favorites"));
  press(rail("Favorites") as Element, "ArrowRight");
  expect(document.activeElement).toBe(search());
});

const withCodex: ModelCatalog = {
  ...catalog,
  codex: [{ id: "gpt-5.5", label: "GPT-5.5", efforts: allEfforts }],
};

it.each([
  ["missing", catalog],
  ["empty", { ...catalog, codex: [] }],
  ["not loaded", undefined],
])("shows Codex as disabled, reachable and doing nothing while it's %s", (_, models) => {
  renderPicker({ catalog: models });
  const codex = rail("Codex");
  expect(codex?.getAttribute("aria-label")).not.toBe("Codex");
  expect(codex?.getAttribute("aria-disabled")).toBe("true");
  expect(codex?.disabled).toBe(false);
  act(() => codex?.click());
  expect(codex?.getAttribute("aria-pressed")).toBe("false");
});

it("offers Codex's models once the catalog has them, named as Codex's", () => {
  const { onPick } = renderPicker({ catalog: withCodex });
  expect(rail("Codex")?.getAttribute("aria-disabled")).toBe("false");
  act(() => rail("Codex")?.click());
  expect(rows()).toEqual(["GPT-5.5, Codex"]);
  press(search(), "Enter");
  expect(onPick).toHaveBeenCalledWith("codex", "gpt-5.5");
});

it("keeps a Codex bot on Codex", () => {
  renderPicker({ catalog: withCodex, accountId: "codex", model: "gpt-5.5", locked: true });
  expect(rows()).toEqual(["GPT-5.5, Codex"]);
  expect(rail("Claude")?.getAttribute("aria-disabled")).toBe("true");
});

it("locks other providers once the bot exists", () => {
  renderPicker({ locked: true });
  expect(rail("Test engine")?.getAttribute("aria-disabled")).toBe("true");
  expect(rail("Claude")?.getAttribute("aria-disabled")).toBe("false");
});

it("shows a saved model missing from the catalog as unavailable, and won't pick it", () => {
  const { onPick } = renderPicker({ model: "claude-old" });
  expect(rows()[0]).toContain("Unavailable");
  press(search(), "Enter");
  expect(onPick).not.toHaveBeenCalled();
});

it("keeps the search box's Enter out of the form while nothing matches", () => {
  const { onPick } = renderPicker();
  type("zzz");
  press(search(), "Enter");
  expect(onPick).not.toHaveBeenCalled();
});

const bot = (model: string, effort: Bot["effort"] = null): Bot => ({
  id: "b",
  name: "Ada",
  personality: "",
  summary: null,
  status: "ready",
  pauseReason: null,
  roomId: "r",
  engineAccountId: "claude",
  model,
  effort,
  mode: "build",
  access: "supervised",
  profile: "operator",
  boundary: "host",
  avatarSeed: 7,
  projectPath: null,
});

function renderControls(current: Bot) {
  const onChange = vi.fn();
  act(() =>
    root.render(<ComposerControls bot={current} catalog={catalog} connected onChange={onChange} />),
  );
  return onChange;
}

const levels = () =>
  [...host.querySelectorAll('[aria-label="Reasoning"] [role="menuitemradio"]')].map(
    (item) => item.textContent,
  );

it("offers only the levels the model supports", () => {
  renderControls(bot("opus"));
  expect(levels()).toEqual(["Default", "Low", "Medium", "High", "Extra high", "Max"]);
  renderControls(bot("claude-opus-4-6"));
  expect(levels()).toEqual(["Default", "Low", "Medium", "High", "Max"]);
  renderControls(bot("claude-haiku-4-5"));
  expect(host.querySelector('[aria-label^="Reasoning"]')).toBeNull();
});

it("clears the level, flips Build and Plan, and names every access level", () => {
  const onChange = renderControls(bot("opus", "high"));
  const item = (name: string) =>
    [...host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (node) => node.textContent === name || node.getAttribute("aria-label") === name,
    );
  act(() => item("Default")?.click());
  expect(onChange).toHaveBeenLastCalledWith({ effort: null });
  act(() =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Default mode. Click to enter plan mode"]')
      ?.click(),
  );
  expect(onChange).toHaveBeenLastCalledWith({ mode: "plan" });
  act(() => item("Auto-accept edits")?.click());
  expect(onChange).toHaveBeenLastCalledWith({ access: "auto-edits" });
  expect(item("Auto")).toBeUndefined();
});

it("warns about Codex's own allow list in the access menu, for Codex bots only", () => {
  const warning = "~/.codex/rules";
  renderControls(bot("opus"));
  expect(host.textContent).not.toContain(warning);

  renderControls({ ...bot("gpt-5.5"), engineAccountId: "codex" });
  const level = host.querySelector('[aria-label="Permissions"] [role="menuitemradio"]');
  const described = level?.getAttribute("aria-describedby")?.split(" ") ?? [];
  const lines = described.map((id) => document.getElementById(id)?.textContent);
  expect(lines.some((line) => line?.includes(warning))).toBe(true);
});

it("draws one bar per ordinary level, with Max as the full scale", () => {
  expect(resolveEffortGlyph(allEfforts, "high")).toEqual({ count: 4, filled: 3 });
  expect(resolveEffortGlyph(allEfforts, "max")).toEqual({ count: 4, filled: 4 });
  expect(resolveEffortGlyph(allEfforts, null)).toBeNull();
  expect(effortBarHeights(4, 12)).toEqual([6, 8, 10, 12]);
});
