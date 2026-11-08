import * as NodeHttp from "node:http";
import type { Duplex } from "node:stream";

import type { HandoffInput } from "@beebot/contracts";
import { WebSocket } from "ws";
import { z } from "zod";

import type { BrowserRuntime, BrowserSession, PageSnapshot } from "./browserRuntime.ts";

// Where the broker reaches one bot's sidecar. Chromium's DevTools has no authentication of its own,
// so each `connect` is a private byte stream to it and nothing listens on the host.
// `collect` copies a finished download, which Chromium names by its GUID, out of the sidecar.
export type SidecarEndpoint = {
  connect: () => Promise<Duplex>;
  downloadsDir: string;
  collect?: (file: string, name: string) => Promise<void>;
};

const Message = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ message: z.string() }).optional(),
  sessionId: z.string().optional(),
});

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;

// Over a stream from `SidecarEndpoint.connect`: the host in the URL is never dialled.
export async function fetchJson(stream: Duplex, path: string) {
  const response = await new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
    NodeHttp.get({ host: "127.0.0.1", path, createConnection: () => stream }, resolve).on(
      "error",
      reject,
    );
  });
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(String(Buffer.concat(chunks))) as unknown;
}

async function connectCdp(url: string, stream: Duplex) {
  const socket = new WebSocket(url, { createConnection: () => stream, perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.on("error", () => reject(new Error("cdp_unreachable")));
  });
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  const listeners = new Map<string, Set<Listener>>();

  socket.addEventListener("message", ({ data }) => {
    let message: z.infer<typeof Message> | undefined;
    try {
      message = Message.safeParse(JSON.parse(String(data))).data;
    } catch {
      return;
    }
    if (message?.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        waiter?.reject(new Error(`cdp: ${message.error.message}`));
      } else {
        waiter?.resolve(message.result ?? {});
      }
    } else if (message?.method) {
      for (const listener of listeners.get(message.method) ?? []) {
        listener(message.params ?? {}, message.sessionId);
      }
    }
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error("cdp_closed"));
    }
    pending.clear();
  });

  return {
    send: (method: string, params: object = {}, sessionId?: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error("cdp_closed"));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
      }),
    on: (method: string, listener: Listener) => {
      const set = listeners.get(method) ?? new Set();
      set.add(listener);
      listeners.set(method, set);
      return () => set.delete(listener);
    },
    close: () => socket.close(),
  };
}

const Version = z.object({ webSocketDebuggerUrl: z.string() });
const Targets = z.object({
  targetInfos: z.array(z.object({ targetId: z.string(), type: z.string() })),
});
const Created = z.object({ targetId: z.string() });
const Attached = z.object({ sessionId: z.string() });
const FrameTree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) });
const World = z.object({ executionContextId: z.number() });
const Evaluated = z.object({
  result: z.object({ value: z.unknown().optional() }),
  exceptionDetails: z.unknown().optional(),
});
const Point = z.object({ x: z.number(), y: z.number() }).nullable();
const Download = z.object({ guid: z.string(), suggestedFilename: z.string() });
const Progress = z.object({ guid: z.string(), state: z.string() });
const Frame = z.object({
  data: z.string(),
  sessionId: z.number(),
  metadata: z.object({ deviceWidth: z.number(), deviceHeight: z.number() }),
});
const Snapshot = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
  frames: z.array(z.string()),
  passwordField: z.boolean(),
  elements: z.array(z.object({ role: z.string(), name: z.string(), value: z.string().nullable() })),
});

// Runs in an isolated world: the page shares the DOM but can't see or replace `__beeRefs`.
const collect = `(() => {
  const selector = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],' +
    '[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=textbox],' +
    '[role=combobox],[contenteditable=""],[contenteditable=true]';
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden";
  };
  const clip = (value, max) => (value ?? "").trim().replace(/\\s+/g, " ").slice(0, max);
  const els = [...document.querySelectorAll(selector)].filter(visible).slice(0, 300);
  globalThis.__beeRefs = els;
  return {
    url: location.href,
    title: document.title,
    text: clip(document.body?.innerText, 20000),
    frames: [...document.querySelectorAll("iframe")].map((f) => f.src).filter(Boolean).slice(0, 50),
    passwordField: els.some((el) => el.type === "password"),
    elements: els.map((el) => ({
      role: el.getAttribute("role") || (el.tagName === "INPUT" ? "input:" + el.type : el.tagName.toLowerCase()),
      name: clip(el.getAttribute("aria-label") || el.labels?.[0]?.innerText || el.placeholder ||
        el.title || el.innerText || el.alt || el.name, 100),
      value: el.type === "password" || typeof el.value !== "string" ? null : el.value.slice(0, 200),
    })),
  };
})()`;

const locate = (index: number) => `(() => {
  const el = globalThis.__beeRefs?.[${index}];
  if (!el?.isConnected) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus?.();
  const box = el.getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
})()`;

const keyCodes: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

const mouseTypes = {
  down: "mousePressed",
  up: "mouseReleased",
  move: "mouseMoved",
  wheel: "mouseWheel",
} as const;

export function inputCommand(input: HandoffInput) {
  if (input.type === "mouse") {
    return {
      method: "Input.dispatchMouseEvent",
      params: {
        type: mouseTypes[input.action],
        x: input.x,
        y: input.y,
        button: input.button,
        clickCount: input.action === "down" || input.action === "up" ? 1 : 0,
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY ?? 0,
      },
    };
  }
  const printable = [...input.key].length === 1;
  const text = printable ? input.key : input.key === "Enter" ? "\r" : undefined;
  return {
    method: "Input.dispatchKeyEvent",
    params: {
      type: input.action === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
      key: input.key,
      code: input.code,
      ...(input.action === "down" && text && { text }),
      ...(keyCodes[input.key] && { windowsVirtualKeyCode: keyCodes[input.key] }),
    },
  };
}

async function openSession(
  { connect, downloadsDir, collect: copyOut }: SidecarEndpoint,
  onDownload: (name: string) => boolean,
): Promise<BrowserSession> {
  const { webSocketDebuggerUrl } = Version.parse(await fetchJson(await connect(), "/json/version"));
  const cdp = await connectCdp(webSocketDebuggerUrl, await connect());

  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allowAndName",
    downloadPath: downloadsDir,
    eventsEnabled: true,
  });
  const allowed = new Map<string, string>();
  cdp.on("Browser.downloadWillBegin", (params) => {
    const download = Download.safeParse(params).data;
    if (download && !onDownload(download.suggestedFilename)) {
      cdp.send("Browser.cancelDownload", { guid: download.guid }).catch(() => {});
    } else if (download) {
      allowed.set(download.guid, download.suggestedFilename);
    }
  });
  cdp.on("Browser.downloadProgress", (params) => {
    const progress = Progress.safeParse(params).data;
    const name = progress && allowed.get(progress.guid);
    if (progress && name !== undefined && progress.state !== "inProgress") {
      allowed.delete(progress.guid);
      if (progress.state === "completed") {
        copyOut?.(progress.guid, name).catch(() => {});
      }
    }
  });

  const pages = Targets.parse(await cdp.send("Target.getTargets")).targetInfos;
  const targetId =
    pages.find(({ type }) => type === "page")?.targetId ??
    Created.parse(await cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
  const { sessionId } = Attached.parse(
    await cdp.send("Target.attachToTarget", { targetId, flatten: true }),
  );
  const page = (method: string, params: object = {}) => cdp.send(method, params, sessionId);
  await page("Page.enable");
  let world: number | undefined;

  async function evaluate(expression: string, contextId: number) {
    const { result, exceptionDetails } = Evaluated.parse(
      await page("Runtime.evaluate", { expression, contextId, returnByValue: true }),
    );
    if (exceptionDetails) {
      throw new Error("page_script_failed");
    }
    return result.value;
  }

  // Null when the snapshot's world went with a navigation, or the element left the page.
  async function locateElement(index: number) {
    if (world === undefined) {
      return null;
    }
    try {
      return Point.parse(await evaluate(locate(index), world));
    } catch {
      return null;
    }
  }

  async function click({ x, y }: { x: number; y: number }) {
    for (const action of ["move", "down", "up"] as const) {
      const { method, params } = inputCommand({ type: "mouse", action, x, y, button: "left" });
      await page(method, params);
    }
  }

  return {
    navigate: async (target) => {
      // A page that never finishes loading is still snapshotted, as far as it got.
      const loaded = new Promise<void>((resolve) => {
        const timer = setTimeout(finish, 15_000);
        const off = cdp.on(
          "Page.loadEventFired",
          (_params, from) => from === sessionId && finish(),
        );
        function finish() {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
      await page("Page.navigate", { url: target });
      await loaded;
    },
    snapshot: async (): Promise<PageSnapshot> => {
      const { frameTree } = FrameTree.parse(await page("Page.getFrameTree"));
      const created = World.parse(
        await page("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "bee" }),
      );
      world = created.executionContextId;
      return Snapshot.parse(await evaluate(collect, world));
    },
    click: async (index) => {
      const point = await locateElement(index);
      if (point) {
        await click(point);
      }
      return point !== null;
    },
    type: async (index, text) => {
      const point = await locateElement(index);
      if (point) {
        await click(point);
        await page("Input.insertText", { text });
      }
      return point !== null;
    },
    input: async (input) => {
      const { method, params } = inputCommand(input);
      await page(method, params);
    },
    insertText: async (text) => {
      await page("Input.insertText", { text });
    },
    screencast: async (onFrame) => {
      const off = cdp.on("Page.screencastFrame", (params, from) => {
        const frame = Frame.safeParse(params).data;
        if (from !== sessionId || !frame) {
          return;
        }
        const { deviceWidth: width, deviceHeight: height } = frame.metadata;
        onFrame({ data: frame.data, width, height });
        page("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      });
      await page("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: 1280,
        maxHeight: 800,
      });
      return async () => {
        off();
        await page("Page.stopScreencast").catch(() => {});
      };
    },
    close: async () => cdp.close(),
  };
}

// `endpoint` comes from boxd, which runs the bot's sidecar.
export function createCdpBrowserRuntime(
  endpoint: (botId: string) => Promise<SidecarEndpoint>,
): BrowserRuntime {
  return { open: async (botId, onDownload) => openSession(await endpoint(botId), onDownload) };
}
