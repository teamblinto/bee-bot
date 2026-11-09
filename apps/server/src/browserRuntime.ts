import type { HandoffClientMessage, HandoffInput, HandoffServerMessage } from "@beebot/contracts";

import type { PageSignals } from "./browserChallenge.ts";

// A password field's value is never read, so it is null.
export type PageElement = { role: string; name: string; value: string | null };

// Element refs are indexes into `elements` of the latest snapshot.
export type PageSnapshot = PageSignals & { elements: PageElement[] };

export type ScreencastFrame = { data: string; width: number; height: number };

export type PageState = Omit<Extract<HandoffServerMessage, { type: "page" }>, "type">;

export type HistoryDirection = Extract<HandoffClientMessage, { type: "history" }>["direction"];

// Where an action landed, as fractions of the screen, and whether the element may hold a secret.
export type ScreenTarget = { x: number; y: number; secret: boolean };

// One page in the bot's sidecar browser. `click` and `type` answer null when the element is gone.
export type BrowserSession = {
  navigate: (url: string) => Promise<void>;
  snapshot: () => Promise<PageSnapshot>;
  click: (index: number) => Promise<ScreenTarget | null>;
  type: (index: number, text: string) => Promise<ScreenTarget | null>;
  // The owner's own input during a handoff.
  input: (input: HandoffInput) => Promise<void>;
  insertText: (text: string) => Promise<void>;
  screencast: (onFrame: (frame: ScreencastFrame) => void) => Promise<() => Promise<void>>;
  // Calls `onPage` with the page now, then whenever its address, title or history changes.
  watchPage: (onPage: (page: PageState) => void) => Promise<() => void>;
  history: (direction: HistoryDirection) => Promise<void>;
  reload: () => Promise<void>;
  // A small JPEG of the page, base64.
  screenshot: () => Promise<string>;
  close: () => Promise<void>;
  // Settles once the browser is gone, closed or not, for example with its box.
  closed: Promise<void>;
};

// `onDownload` gets the suggested file name and answers whether the download may go on.
export type BrowserRuntime = {
  open: (botId: string, onDownload: (name: string) => boolean) => Promise<BrowserSession>;
};

export type FakePage = Partial<Omit<PageSnapshot, "elements">> & {
  elements?: (PageElement & { href?: string })[];
};

// For tests: pages are scripted, and everything the browser received is in `received`. The page
// text shows every field's value, the way a page echoes what was typed into it. A press at `y`
// clicks element `y / 100`.
export function createFakeBrowserRuntime(pages: Record<string, FakePage> = {}) {
  const received: string[] = [];
  const downloads = new Map<string, (name: string) => boolean>();
  const losers = new Map<string, () => void>();
  let opened = 0;

  const runtime: BrowserRuntime = {
    open: async (botId, onDownload) => {
      opened += 1;
      downloads.set(botId, onDownload);
      const visited = ["about:blank"];
      let at = 0;
      let url = "about:blank";
      const watchers = new Set<(page: PageState) => void>();
      const pageState = () => ({
        url,
        title: pages[url]?.title ?? url,
        canGoBack: at > 0,
        canGoForward: at < visited.length - 1,
      });
      let elements: (PageElement & { href?: string })[] = [];
      let focused: number | undefined;
      const closed = new Promise<void>((resolve) => losers.set(botId, resolve));

      const show = (next: string) => {
        url = next;
        elements = (pages[next]?.elements ?? []).map((element) => ({ ...element }));
        focused = undefined;
        for (const watcher of watchers) {
          watcher(pageState());
        }
      };
      const load = (next: string) => {
        visited.splice(at + 1, Infinity, next);
        at = visited.length - 1;
        show(next);
      };
      const typeInto = (index: number | undefined, text: string) => {
        const element = index === undefined ? undefined : elements[index];
        if (element && element.value !== null) {
          element.value += text;
        }
      };

      return {
        navigate: async (next) => {
          received.push(`navigate ${next}`);
          load(next);
        },
        snapshot: async () => {
          const page = pages[url] ?? {};
          const values = elements.map(({ value }) => value ?? "").join(" ");
          return {
            url,
            title: page.title ?? url,
            text: `${page.text ?? ""} ${values}`.trim(),
            frames: page.frames ?? [],
            passwordField: page.passwordField ?? false,
            elements: elements.map(({ role, name, value }) => ({ role, name, value })),
          };
        },
        click: async (index) => {
          received.push(`click ${index}`);
          const element = elements[index];
          if (!element) {
            return null;
          }
          focused = index;
          if (element.href) {
            load(element.href);
          }
          return { x: 0.5, y: 0.5, secret: element.value === null };
        },
        type: async (index, text) => {
          received.push(`type ${index} ${text}`);
          const element = elements[index];
          if (!element) {
            return null;
          }
          typeInto(index, text);
          return { x: 0.5, y: 0.5, secret: element.value === null };
        },
        input: async (input) => {
          received.push(`input ${JSON.stringify(input)}`);
          if (input.type === "mouse" && input.action === "down") {
            focused = Math.floor(input.y / 100);
            const href = elements[focused]?.href;
            if (href) {
              load(href);
            }
          }
          if (input.type === "key" && input.action === "down" && [...input.key].length === 1) {
            typeInto(focused, input.key);
          }
        },
        insertText: async (text) => {
          received.push(`text ${text}`);
          typeInto(focused, text);
        },
        screencast: async (onFrame) => {
          onFrame({ data: "", width: 1280, height: 800 });
          return async () => {};
        },
        watchPage: async (onPage) => {
          watchers.add(onPage);
          onPage(pageState());
          return () => watchers.delete(onPage);
        },
        history: async (direction) => {
          received.push(`history ${direction}`);
          const next = at + (direction === "back" ? -1 : 1);
          if (next >= 0 && next < visited.length) {
            at = next;
            show(visited[at] ?? url);
          }
        },
        reload: async () => {
          received.push("reload");
          show(url);
        },
        screenshot: async () => "AAAA",
        close: async () => {},
        closed,
      };
    },
  };

  return {
    runtime,
    received,
    opened: () => opened,
    download: (botId: string, name: string) => downloads.get(botId)?.(name),
    // The bot's browser goes away, the way it does when its box stops.
    lose: (botId: string) => losers.get(botId)?.(),
  };
}
