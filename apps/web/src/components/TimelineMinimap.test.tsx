// @vitest-environment jsdom
import type { Bot, ChatMessage } from "@beebot/contracts";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  deriveMinimapItems,
  type MinimapItem,
  minimapCurrentIndex,
  minimapHasPersistentGutter,
  minimapHitStripWidth,
  minimapIndexFromPointer,
  minimapItemsEqual,
  minimapPreview,
  minimapVisibilityClass,
} from "../timelineMinimap";
import { forwardWheelToTimeline } from "../timelineMinimapWheel";
import type { TranscriptItem } from "../transcript";
import { TimelineMinimap } from "./TimelineMinimap";
import { Transcript } from "./Transcript";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let observers: Array<() => void> = [];

beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: () => void) {
        observers.push(() => this.callback());
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    run(0);
    return 1;
  });
  Object.assign(window, { matchMedia: () => ({ matches: false }) });
});

let root: Root | undefined;
let host: HTMLElement;

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

const message = (id: string, author: ChatMessage["author"], body: string): TranscriptItem => ({
  kind: "message",
  at: id,
  sender: author,
  message: {
    id,
    roomId: "r",
    author,
    body,
    tools: [],
    workedMs: null,
    botId: null,
    replyToId: null,
    chainId: null,
    hop: 0,
    createdAt: "2026-11-06T00:00:00.000Z",
  },
});

const turns = [
  message("1", "human", "first"),
  message("2", "bot", "working"),
  message("3", "bot", "final **answer**"),
  message("4", "human", "second"),
  message("5", "human", "third"),
  message("6", "bot", "done"),
];

it("pairs each user message with the final reply of its turn", () => {
  expect(deriveMinimapItems(turns)).toEqual([
    { id: "1", userText: "first", assistantText: "final **answer**" },
    { id: "4", userText: "second", assistantText: null },
    { id: "5", userText: "third", assistantText: "done" },
  ]);
});

it("ignores approvals and a reply with no message before it", () => {
  const approval = { kind: "approval", at: "0", sender: "bot" } as unknown as TranscriptItem;
  expect(deriveMinimapItems([approval, message("9", "bot", "hello")])).toEqual([]);
});

it("strips markdown and markup from the preview", () => {
  const preview = minimapPreview({
    id: "1",
    userText: "  a\n  b ",
    assistantText: "# Title\n\n**bold** `code` <script>alert(1)</script> [link](https://x.test)",
  });
  expect(preview.userText).toBe("a b");
  expect(preview.assistantText).toBe("Title bold code alert(1) link");
});

it("renders message markup in the preview as text, never as HTML", () => {
  const items: MinimapItem[] = [
    { id: "1", userText: "<img src=x onerror=alert(1)>", assistantText: "<b>bold</b> **more**" },
    { id: "2", userText: "two", assistantText: null },
  ];
  mount(
    <TimelineMinimap
      items={items}
      scroller={{ current: document.createElement("div") }}
      content={{ current: document.createElement("div") }}
      onJump={() => {}}
    />,
  );
  const jump = host.querySelector<HTMLButtonElement>('button[aria-label^="Jump"]');
  act(() => jump?.focus());
  const card = host.querySelector("[data-minimap-preview]");
  expect(card?.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(card?.textContent).toContain("bold more");
  expect(card?.querySelector("img, b")).toBeNull();
});

it("maps the pointer to the nearest strip, inside the rail", () => {
  const place = { itemCount: 5, railTop: 100, railHeight: 40 };
  expect(minimapIndexFromPointer({ ...place, pointerY: 100 })).toBe(0);
  expect(minimapIndexFromPointer({ ...place, pointerY: 119 })).toBe(2);
  expect(minimapIndexFromPointer({ ...place, pointerY: 999 })).toBe(4);
  expect(minimapIndexFromPointer({ ...place, railHeight: 0, pointerY: 1 })).toBeNull();
});

it("prefers the first message on screen, then the turn being read", () => {
  const rows = [
    { top: -500, bottom: -450 },
    { top: 100, bottom: 150 },
    { top: 900, bottom: 950 },
  ];
  expect(minimapCurrentIndex(rows, { top: 0, bottom: 600 })).toBe(1);
  expect(minimapCurrentIndex(rows, { top: 200, bottom: 800 })).toBe(1);
  expect(minimapCurrentIndex(rows, { top: 1000, bottom: 1600 })).toBe(2);
  expect(minimapCurrentIndex(rows, { top: -900, bottom: -600 })).toBeNull();
});

it("is always shown with a 48px gutter, and hidden on touch without one", () => {
  expect(minimapHasPersistentGutter(832, 736)).toBe(true);
  expect(minimapHasPersistentGutter(830, 736)).toBe(false);
  expect(minimapVisibilityClass(true)).toBe("opacity-100");
  const narrow = minimapVisibilityClass(false).split(" ");
  expect(narrow).toContain("hidden");
  expect(narrow).toContain("[@media(pointer:fine)]:block");
  expect(minimapHitStripWidth(760, 736)).toBe(0);
  expect(minimapHitStripWidth(2000, 736)).toBe(40);
});

it("renders nothing below two user messages", () => {
  mount(
    <TimelineMinimap
      items={deriveMinimapItems(turns.slice(0, 3))}
      scroller={createRef()}
      content={createRef()}
      onJump={() => {}}
    />,
  );
  expect(host.querySelector('[data-testid="timeline-minimap"]')).toBeNull();
});

it("skips a re-render when the items didn't change", () => {
  const items = deriveMinimapItems(turns);
  expect(minimapItemsEqual(items, deriveMinimapItems(turns))).toBe(true);
  const longer = deriveMinimapItems([...turns, message("7", "bot", "more")]);
  expect(minimapItemsEqual(items, longer)).toBe(false);
});

it("moves with the arrow keys, Home and End, and jumps with Enter and Space", () => {
  const onJump = vi.fn();
  mount(
    <TimelineMinimap
      items={deriveMinimapItems(turns)}
      scroller={{ current: document.createElement("div") }}
      content={{ current: document.createElement("div") }}
      onJump={onJump}
    />,
  );
  const jump = host.querySelector<HTMLButtonElement>('button[aria-label^="Jump"]') as HTMLElement;
  const press = (key: string) =>
    act(() => {
      jump.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  act(() => jump.focus());
  expect(jump.getAttribute("aria-label")).toBe("Jump to message: first");
  press("ArrowDown");
  expect(jump.getAttribute("aria-label")).toBe("Jump to message: second");
  press("End");
  press("ArrowDown");
  expect(jump.getAttribute("aria-label")).toBe("Jump to message: third");
  press("Enter");
  expect(onJump).toHaveBeenLastCalledWith("5");
  press("Home");
  press("ArrowUp");
  press(" ");
  expect(onJump).toHaveBeenLastCalledWith("1");
  expect(host.querySelector('[role="navigation"]')?.getAttribute("aria-label")).toBe(
    "Chat navigator",
  );
});

it("marks in-view strips through data attributes", () => {
  const scroller = { current: document.createElement("div") };
  const lane = document.createElement("div");
  const rows = [
    ["1", -100, -60],
    ["4", 20, 60],
    ["5", 900, 950],
  ] as const;
  for (const [id, top, bottom] of rows) {
    const row = document.createElement("div");
    row.dataset.messageId = id;
    row.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
    lane.append(row);
  }
  scroller.current.getBoundingClientRect = () => ({ top: 0, bottom: 500, width: 900 }) as DOMRect;
  mount(
    <TimelineMinimap
      items={deriveMinimapItems(turns)}
      scroller={scroller}
      content={{ current: lane }}
      onJump={() => {}}
    />,
  );
  const flags = [...host.querySelectorAll<HTMLElement>("[data-minimap-strip]")].map(
    ({ dataset }) => dataset.inView,
  );
  expect(flags).toEqual(["false", "true", "false"]);
});

const bot: Bot = {
  id: "b",
  name: "Ada",
  personality: "",
  summary: null,
  status: "ready",
  pauseReason: null,
  roomId: "r",
  engineAccountId: "fake",
  model: "sonnet",
  effort: null,
  mode: "build",
  access: "supervised",
  profile: "operator",
  boundary: "host",
  manifest: [],
  egressAnySite: true,
  egressHosts: [],
  unattendedLane: "api_key",
  avatarSeed: 7,
  projectPath: null,
};

function renderTranscript(items: TranscriptItem[]) {
  mount(
    <Transcript
      bot={bot}
      items={items}
      connected
      finishedTools={{}}
      draft={undefined}
      liveTools={[]}
      workingSince={undefined}
      endedWork={undefined}
      thought={undefined}
      systemLine=""
      onContinue={undefined}
    />,
  );
  const box = host.querySelector<HTMLDivElement>(".scroller") as HTMLDivElement;
  Object.defineProperties(box, {
    scrollHeight: { value: 5000, configurable: true },
    clientHeight: { value: 500, configurable: true },
  });
  box.scrollTo = vi.fn();
  return box;
}

it("turns off auto-follow on a jump, and sending turns it back on", () => {
  const box = renderTranscript(turns);
  box.scrollTop = 4500;
  act(() => observers.forEach((run) => run()));
  const jump = host.querySelector<HTMLButtonElement>('button[aria-label^="Jump"]') as HTMLElement;
  act(() => jump.focus());
  act(() => {
    jump.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(box.scrollTo).toHaveBeenCalled();
  expect(host.textContent).toContain("Jump to latest");

  // Output keeps growing, and at the very end the jump still holds.
  box.scrollTop = 4500;
  act(() => observers.forEach((run) => run()));
  expect(box.scrollTop).toBe(4500);
  expect(host.textContent).toContain("Jump to latest");

  act(() =>
    root?.render(
      <Transcript
        bot={bot}
        items={[...turns, message("7", "human", "fourth")]}
        connected
        finishedTools={{}}
        draft={undefined}
        liveTools={[]}
        workingSince={undefined}
        endedWork={undefined}
        thought={undefined}
        systemLine=""
        onContinue={undefined}
      />,
    ),
  );
  act(() => observers.forEach((run) => run()));
  expect(host.textContent).not.toContain("Jump to latest");
  expect(box.scrollTop).toBe(5000);
});

function wheelOn(timeline: HTMLElement, init: WheelEventInit, wheelDeltaY?: number) {
  const event = new WheelEvent("wheel", { cancelable: true, ...init });
  if (wheelDeltaY !== undefined) {
    Object.defineProperty(event, "wheelDeltaY", { value: wheelDeltaY });
  }
  forwardWheelToTimeline(event, timeline);
  return event;
}

function timeline() {
  const node = document.createElement("div");
  document.body.append(node);
  Object.defineProperties(node, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 500 },
  });
  node.scrollBy = vi.fn();
  return node;
}

it("passes a trackpad through at once, and glides a mouse wheel", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => frames.push(run));
  const node = timeline();

  wheelOn(node, { deltaY: 7 }, -7);
  expect(node.scrollBy).toHaveBeenCalledWith({ top: 7 });
  expect(frames).toHaveLength(0);

  const started = performance.now();
  wheelOn(node, { deltaY: 100 }, -120);
  expect(frames).toHaveLength(1);
  frames.shift()?.(started + 75);
  expect(node.scrollTop).toBeGreaterThan(50);
  expect(node.scrollTop).toBeLessThan(100);
  frames.shift()?.(started + 1000);
  expect(node.scrollTop).toBeCloseTo(100);
  expect(frames).toHaveLength(0);
  node.remove();
});

it("stops a glide when the owner presses a key or a pointer", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => frames.push(run));
  vi.stubGlobal("cancelAnimationFrame", () => frames.splice(0));
  const node = timeline();
  wheelOn(node, { deltaY: 100 }, -120);
  expect(frames).toHaveLength(1);
  window.dispatchEvent(new Event("pointerdown"));
  expect(frames).toHaveLength(0);
  node.remove();
});

it("is instant under reduced motion, and leaves zoom alone", () => {
  Object.assign(window, { matchMedia: () => ({ matches: true }) });
  const node = timeline();
  wheelOn(node, { deltaY: 100 }, -120);
  expect(node.scrollBy).toHaveBeenCalledWith({ top: 100 });
  const zoom = wheelOn(node, { deltaY: 100, ctrlKey: true });
  expect(zoom.defaultPrevented).toBe(false);
  node.remove();
});
