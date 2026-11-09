import * as NodeCrypto from "node:crypto";

import {
  HandoffClientMessage,
  type HandoffReason,
  type HandoffServerMessage,
  type ServerMessage,
} from "@beebot/contracts";
import type { WebSocket } from "ws";
import { z } from "zod";

import type { Execute } from "./approvals.ts";
import type { AuditRecord } from "./audit.ts";
import type { PolicyDecision } from "./broker.ts";
import { detectChallenge } from "./browserChallenge.ts";
import {
  afterSnapshot,
  botMay,
  elementRef,
  freshLease,
  giveLease,
  type Lease,
  parseRef,
  takeLease,
} from "./browserLease.ts";
import {
  addSecret,
  flushTyping,
  noTyping,
  redact,
  shownTyping,
  trackTyping,
  type Typing,
} from "./browserRedact.ts";
import type {
  BrowserRuntime,
  BrowserSession,
  PageSnapshot,
  ScreenTarget,
} from "./browserRuntime.ts";
import type { DesktopControl } from "./display.ts";
import type { EventStore } from "./store.ts";
import { type Takeover, takeoverTtlMs } from "./takeovers.ts";

const text = { type: "string" };
const ref = { type: "string", description: "An element ref from your latest snapshot" };
const schema = (properties: Record<string, object>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
});

export const browserTools = [
  {
    name: "browser_navigate",
    description: "Opens an http or https URL in your browser and returns a snapshot of the page.",
    inputSchema: schema({ url: text }),
  },
  {
    name: "browser_snapshot",
    description: "Returns the page's text and its interactive elements, each with a ref.",
    inputSchema: schema({}),
  },
  {
    name: "browser_click",
    description: "Clicks an element by its ref, then returns a new snapshot.",
    inputSchema: schema({ ref }),
  },
  {
    name: "browser_type",
    description: "Types text into an element by its ref, then returns a new snapshot.",
    inputSchema: schema({ ref, text }),
  },
];

// Asking grants nothing: the owner decides whether to take over, and the bot waits either way.
export const takeoverTool = {
  name: "request_takeover",
  description:
    "Asks the owner to take over your computer for a step only a person can do, such as a sign-in " +
    "through a native dialog. Your turn ends and you wait until they hand control back.",
  inputSchema: schema({ reason: { type: "string", description: "What the owner should do" } }),
};

export const browserToolNames = new Set([...browserTools, takeoverTool].map(({ name }) => name));

const Args = {
  browser_navigate: z.object({ url: z.string().trim().min(1).max(2048) }),
  browser_snapshot: z.object({}),
  browser_click: z.object({ ref: z.string().max(32) }),
  browser_type: z.object({ ref: z.string().max(32), text: z.string().max(4000) }),
  request_takeover: z.object({ reason: z.string().trim().min(1).max(300) }),
};
type BrowserTool = keyof typeof Args;
const isBrowserTool = (name: string): name is BrowserTool => Object.hasOwn(Args, name);

// The sidecar's own egress policy still applies: this only keeps the bot to web pages.
export function resolveUrl(raw: string) {
  const url = URL.parse(raw);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return undefined;
  }
  return url;
}

const executable =
  /\.(exe|msi|msix|bat|cmd|com|scr|ps1|vbs|js|jse|wsf|hta|cpl|lnk|jar|sh|bash|run|bin|appimage|deb|rpm|apk|dmg|pkg|app|command)$/i;

// Downloads land in one folder of the sidecar, named by GUID, and nothing opens them. A refused one
// is cancelled, but a small file can finish first: it is still never offered to the bot.
export const downloadAllowed = (name: string) => !executable.test(name.trim());

const digestOf = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const answer = (fields: Record<string, unknown>) => JSON.stringify(fields);
const refused = (reason: string) =>
  answer({ status: "refused", reason, note: "This is an answer, not an error. Tell the user." });
const endTurn = "End your turn now. The owner was asked to step in.";

export type BrowserRun = { id: string; botId: string; attended: boolean };

export type HandoffPeer = { send: (message: HandoffServerMessage) => void };

export type Activity = Omit<Extract<ServerMessage, { type: "activity" }>, "type" | "botId">;

export type BrowserDeps = {
  runtime: BrowserRuntime;
  // The broker's check, which keeps the session's legs and audits the call.
  check: (run: BrowserRun, tool: string, args: unknown) => PolicyDecision;
  appendAudit: (record: AuditRecord) => void;
  // Sets or clears the bot's `browser_session` pause.
  setPaused: (botId: string, paused: boolean) => void;
  notify: (run: BrowserRun, text: string) => void;
  // A continuation: answers the bot now, and calls `perform` once the owner approves.
  requestApproval: (run: BrowserRun, tool: string, args: Record<string, unknown>) => string;
  desktop: Pick<DesktopControl, "take" | "give">;
  takeovers: {
    request: (run: BrowserRun, reason: string) => Takeover;
    take: (botId: string) => Takeover | undefined;
    // Completing one resumes the bot that asked.
    complete: (botId: string) => Takeover | undefined;
    expire: (id: string) => Takeover | undefined;
  };
  takeoverTtlMs?: number;
  // What the bot just did on its screen, for the owner's overlay.
  activity?: (botId: string, activity: Activity) => void;
};

type Tab = {
  session: BrowserSession;
  lease: Lease;
  typing: Typing;
  requested: { reason: HandoffReason; note: string | null } | null;
  downloads: string[];
  peers: Set<HandoffPeer>;
  holder: HandoffPeer | null;
  stopScreencast: Promise<() => Promise<void>> | null;
};

const notices: Record<HandoffReason, (detail: string) => string> = {
  login: (host) => `${host} wants a sign-in. Open Browser in my menu, take control and sign in.`,
  captcha: (host) => `${host} wants a person to solve a challenge. Open Browser in my menu.`,
  hand_off: (reason) => `This browser step is yours to do: ${reason}. Open Browser in my menu.`,
  takeover: (reason) => `Please take over my computer: ${reason}. Open Browser in my menu.`,
};

const takeoverAudit = (takeover: Takeover | undefined) =>
  takeover && { runId: takeover.runId, reason: `takeover:${takeover.id}` };

export function createBrowserBroker(deps: BrowserDeps) {
  const tabs = new Map<string, Promise<Tab>>();
  // Opened tabs, for the wall's synchronous checks.
  const opened = new Map<string, Tab>();

  function open(botId: string) {
    const existing = tabs.get(botId);
    if (existing) {
      return existing;
    }
    const opening = deps.runtime
      .open(botId, (name) => {
        const allowed = downloadAllowed(name);
        deps.appendAudit({
          runId: null,
          botId,
          status: allowed ? "download" : "download_refused",
          reason: null,
          tool: "browser_download",
          initiator: "system",
          digest: digestOf(name),
        });
        if (allowed) {
          void opening.then((tab) => tab.downloads.push(name));
        }
        return allowed;
      })
      .then((session): Tab => ({
        session,
        lease: freshLease,
        typing: noTyping,
        requested: null,
        downloads: [],
        peers: new Set(),
        holder: null,
        stopScreencast: null,
      }));
    tabs.set(botId, opening);
    opening.then(
      (tab) => opened.set(botId, tab),
      () => tabs.delete(botId),
    );
    return opening;
  }

  function leaseMessage(tab: Tab, peer: HandoffPeer): HandoffServerMessage {
    return {
      type: "lease",
      holder: tab.lease.holder,
      mine: tab.holder === peer,
      leaseId: tab.holder === peer ? tab.lease.leaseId : null,
      requested: tab.requested?.reason ?? null,
      note: tab.requested?.note ?? null,
    };
  }

  function broadcastLease(tab: Tab) {
    for (const peer of tab.peers) {
      peer.send(leaseMessage(tab, peer));
    }
  }

  async function snapshot(tab: Tab) {
    const page = await tab.session.snapshot();
    tab.lease = afterSnapshot(tab.lease);
    return page;
  }

  // Everything the bot reads of the page passes through here, so nothing the owner typed reaches it.
  function present(tab: Tab, page: PageSnapshot) {
    const clean = (value: string) => redact(value, tab.typing);
    return {
      url: clean(page.url),
      title: clean(page.title),
      text: clean(page.text),
      elements: page.elements.map(({ role, name, value }, index) => ({
        ref: elementRef(tab.lease.generation, index),
        role,
        name: clean(name),
        ...(value !== null && value !== "" && { value: clean(value) }),
      })),
      downloads: tab.downloads,
    };
  }

  function requestHandoff(run: BrowserRun, tab: Tab, reason: HandoffReason, note: string | null) {
    tab.requested = { reason, note };
    deps.setPaused(run.botId, true);
    deps.notify(run, notices[reason](note ?? "A site"));
    broadcastLease(tab);
  }

  // Expiry lifts the pause, so a request nobody answers can't leave the bot stuck.
  function requestTakeover(run: BrowserRun, tab: Tab, reason: string) {
    const takeover = deps.takeovers.request(run, reason);
    requestHandoff(run, tab, "takeover", takeover.reason);
    setTimeout(() => {
      if (deps.takeovers.expire(takeover.id) && tab.requested?.reason === "takeover") {
        tab.requested = null;
        deps.setPaused(run.botId, false);
        broadcastLease(tab);
      }
    }, deps.takeoverTtlMs ?? takeoverTtlMs).unref();
    return answer({ status: "paused", reason: "takeover", note: endTurn });
  }

  async function observe(run: BrowserRun, tab: Tab) {
    const page = await snapshot(tab);
    const challenge = detectChallenge(page);
    if (challenge) {
      const host = URL.parse(page.url)?.host ?? "A site";
      requestHandoff(run, tab, challenge, host);
      return answer({ status: "paused", reason: challenge, note: endTurn });
    }
    return answer({ status: "ok", page: present(tab, page) });
  }

  // Acts without asking the broker: for a call it allowed, or one the owner approved.
  async function perform(run: BrowserRun, tool: BrowserTool, args: unknown) {
    const tab = await open(run.botId);
    const parsed = Args[tool].safeParse(args);
    if (!parsed.success) {
      return refused(`invalid_arguments for ${tool}`);
    }
    const data: Record<string, string> = parsed.data;
    const may = botMay(tab.lease, data.ref);
    if (may === "human_has_control") {
      return refused("The owner has control of the browser. Try again later.");
    }
    const index = data.ref === undefined ? undefined : parseRef(data.ref)?.index;
    if (may === "stale_ref" || (data.ref !== undefined && index === undefined)) {
      const page = await snapshot(tab);
      return answer({
        status: "stale_ref",
        note: "The page changed since that ref. Here is a fresh snapshot: act again.",
        page: present(tab, page),
      });
    }
    let target: ScreenTarget | null | undefined;
    if (tool === "browser_navigate") {
      await tab.session.navigate(data.url ?? "");
    } else if (tool === "browser_click") {
      target = await tab.session.click(index ?? -1);
    } else if (tool === "browser_type") {
      target = await tab.session.type(index ?? -1, data.text ?? "");
    }
    if (target === null) {
      return refused("That element is gone. Take a new snapshot.");
    }
    if (target) {
      const typed = tool === "browser_type" ? (data.text ?? "") : undefined;
      deps.activity?.(run.botId, {
        kind: typed === undefined ? "click" : "type",
        x: Math.min(1, Math.max(0, target.x)),
        y: Math.min(1, Math.max(0, target.y)),
        text: typed === undefined ? null : shownTyping(typed, tab.typing, target.secret),
      });
    }
    return observe(run, tab);
  }

  async function call(run: BrowserRun, name: string, args: unknown) {
    if (!isBrowserTool(name)) {
      return refused(`unknown tool ${name}`);
    }
    const parsed = Args[name].safeParse(args);
    if (!parsed.success) {
      return refused(`invalid_arguments for ${name}`);
    }
    const data: Record<string, string> = parsed.data;
    if (data.url !== undefined && !resolveUrl(data.url)) {
      return refused("Only http and https URLs without credentials can be opened.");
    }
    // Before the sidecar is touched, so a bot without the grant never opens a page.
    const decision = deps.check(run, name, data);
    if (decision.kind === "deny") {
      return refused(decision.reason);
    }
    // `perform` checks who holds the browser once the owner has approved.
    if (decision.kind === "approve") {
      return deps.requestApproval(run, name, data);
    }
    let tab: Tab;
    try {
      tab = await open(run.botId);
    } catch (error) {
      console.error(`beebotd: browser unavailable: ${(error as Error)?.name}`);
      return refused("browser_unavailable");
    }
    if (tab.lease.holder === "human") {
      deps.appendAudit({
        runId: run.id,
        botId: run.botId,
        status: "refused",
        reason: "human_has_control",
        tool: name,
        initiator: "bot",
        attended: run.attended,
      });
      return refused("The owner has control of the browser. Try again later.");
    }
    switch (decision.kind) {
      case "hand_off":
        requestHandoff(run, tab, "hand_off", decision.reason);
        return answer({ status: "handed_off", reason: decision.reason, note: endTurn });
      case "allow":
        if (name === "request_takeover") {
          return requestTakeover(run, tab, data.reason ?? "");
        }
        try {
          return await perform(run, name, data);
        } catch (error) {
          // The next call opens the sidecar's page afresh, in case the browser restarted.
          console.error(`beebotd: browser ${name} failed: ${(error as Error)?.name}`);
          tabs.delete(run.botId);
          opened.delete(run.botId);
          void tab.session.close().catch(() => {});
          return refused("browser_unavailable");
        }
    }
  }

  // Back to the bot. The page is checked again, and the pause lifts once nothing wants a person. A
  // takeover the owner took is done, and its bot resumes.
  async function handBack(botId: string, tab: Tab) {
    const { leaseId } = tab.lease;
    const given = leaseId ? giveLease(tab.lease, leaseId) : undefined;
    if (!leaseId || !given?.lease) {
      return;
    }
    tab.lease = given.lease;
    tab.holder = null;
    tab.typing = flushTyping(tab.typing);
    const desktop = deps.desktop.give(leaseId);
    const requested = tab.requested?.reason;
    try {
      const settled =
        requested === "hand_off" ||
        requested === "takeover" ||
        !detectChallenge(await tab.session.snapshot());
      if (settled) {
        tab.requested = null;
        deps.setPaused(botId, false);
      }
    } catch (error) {
      console.error(`beebotd: browser check after handback failed: ${(error as Error)?.name}`);
    }
    deps.appendAudit({
      runId: null,
      botId,
      status: "handoff_returned",
      reason: requested ?? null,
      tool: desktop ? "desktop" : null,
      initiator: "human",
      attended: true,
      ...takeoverAudit(deps.takeovers.complete(botId)),
    });
    broadcastLease(tab);
  }

  function receive(botId: string, tab: Tab, peer: HandoffPeer, raw: string) {
    let message: HandoffClientMessage | undefined;
    try {
      message = HandoffClientMessage.safeParse(JSON.parse(raw)).data;
    } catch {
      message = undefined;
    }
    // Never logged, not even when malformed: it can hold what the owner typed.
    if (!message) {
      return;
    }
    if (message.type === "take") {
      const taken = takeLease(tab.lease, NodeCrypto.randomUUID());
      if (taken.lease) {
        tab.lease = taken.lease;
        tab.holder = peer;
        const desktop = deps.desktop.take(botId, taken.lease.leaseId);
        deps.appendAudit({
          runId: null,
          botId,
          status: "handoff_taken",
          reason: tab.requested?.reason ?? null,
          tool: desktop ? "desktop" : null,
          initiator: "human",
          attended: true,
          ...takeoverAudit(deps.takeovers.take(botId)),
        });
      }
      broadcastLease(tab);
      return;
    }
    if (tab.holder !== peer) {
      return;
    }
    if (message.type === "give") {
      void handBack(botId, tab);
    } else if (message.type === "input") {
      tab.typing = trackTyping(tab.typing, message.input);
      tab.session.input(message.input).catch(() => {});
    } else {
      tab.typing = addSecret(flushTyping(tab.typing), message.text);
      tab.session.insertText(message.text).catch(() => {});
    }
  }

  // A socket that watches the bot's browser, and may take control of it.
  async function attach(botId: string, peer: HandoffPeer) {
    let tab: Tab;
    try {
      tab = await open(botId);
    } catch (error) {
      console.error(`beebotd: browser unavailable: ${(error as Error)?.name}`);
      peer.send({ type: "unavailable" });
      return { receive: () => {}, detach: () => {} };
    }
    tab.peers.add(peer);
    peer.send(leaseMessage(tab, peer));
    // Frames go only to the owner's sockets: never stored, and never to the bot.
    tab.stopScreencast ??= tab.session.screencast((frame) => {
      for (const watcher of tab.peers) {
        watcher.send({ type: "frame", ...frame });
      }
    });
    tab.stopScreencast.catch(() => {
      tab.stopScreencast = null;
    });
    return {
      receive: (raw: string) => receive(botId, tab, peer, raw),
      detach: () => {
        tab.peers.delete(peer);
        if (tab.holder === peer) {
          void handBack(botId, tab);
        }
        if (tab.peers.size === 0 && tab.stopScreencast) {
          void tab.stopScreencast.then((stop) => stop()).catch(() => {});
          tab.stopScreencast = null;
        }
      },
    };
  }

  return {
    call,
    perform: (run: BrowserRun, tool: string, args: unknown) =>
      isBrowserTool(tool)
        ? perform(run, tool, args)
        : Promise.resolve(refused(`unknown tool ${tool}`)),
    attach,
    held: (botId: string) => opened.get(botId)?.lease.holder === "human",
    // A thumbnail from a tab that is already open, while the bot has control.
    screenshot: async (botId: string) => {
      const tab = opened.get(botId);
      if (!tab || tab.lease.holder === "human") {
        throw new Error("no open tab");
      }
      return Buffer.from(await tab.session.screenshot(), "base64");
    },
    close: async () => {
      const open = [...tabs.values()];
      tabs.clear();
      opened.clear();
      await Promise.allSettled(open.map(async (tab) => (await tab).session.close()));
    },
  };
}

export type BrowserBroker = ReturnType<typeof createBrowserBroker>;

const ApprovedCall = z.object({ input: z.record(z.string(), z.unknown()) });
const Answer = z.object({ status: z.string() });

// The owner approved it, so it runs as attended. Only a page actually acted on counts as done.
export function browserExecutors(broker: Pick<BrowserBroker, "perform">) {
  const execute: Execute = async ({ botId, runId, tool, payload }) => {
    const { input } = ApprovedCall.parse(JSON.parse(payload));
    const text = await broker.perform({ id: runId, botId, attended: true }, tool, input);
    return { ok: Answer.safeParse(JSON.parse(text)).data?.status === "ok", output: text };
  };
  return browserTools.map(({ name }) => [name, execute] as const);
}

const handedBack =
  "The owner finished the takeover and handed control back. What you saw before is stale: take " +
  "a fresh snapshot or screenshot before you act.";

export function storeBrowserDeps(store: EventStore) {
  return {
    check: (run: BrowserRun, tool: string, args: unknown) => store.policy.check(run, tool, args),
    appendAudit: store.appendAudit,
    // The owner's own pause, or one for the engine, is left alone.
    setPaused: (botId: string, paused: boolean) => {
      const bot = store.getBot(botId);
      if (paused && bot?.status === "ready") {
        store.setBotPause(botId, "browser_session");
      } else if (!paused && bot?.pauseReason === "browser_session") {
        store.setBotPause(botId, null);
      }
    },
    notify: (run: BrowserRun, text: string) => {
      const grant = store.tasks.runGrant(run.id);
      const room = store.tasks.dmRoom(run.botId);
      if (grant && room) {
        const { chainId, hop, depth } = grant;
        store.tasks.postFrom({ botId: run.botId, chainId, hop, depth }, room, "notify", text);
      }
    },
    takeovers: {
      request: (run: BrowserRun, reason: string) =>
        store.takeovers.requestTakeover(run.botId, run.id, reason),
      take: (botId: string) => store.takeovers.moveTakeover(botId, "waiting", "taken"),
      // Answers the bot's waiting reply in its room, like a continuation's outcome. The fixed ID
      // makes a repeat a no-op.
      complete: (botId: string) => {
        const takeover = store.takeovers.moveTakeover(botId, "taken", "completed");
        const target = takeover && store.takeovers.takeoverTarget(takeover.id);
        if (takeover && target) {
          store.sendMessage({
            id: `takeover:${takeover.id}`,
            roomId: target.roomId,
            body: handedBack,
            attended: true,
            ...(target.replyToId && { replyToId: target.replyToId }),
          });
        }
        return takeover;
      },
      expire: (id: string) => store.takeovers.expireTakeover(id),
    },
  } satisfies Omit<BrowserDeps, "runtime" | "requestApproval" | "desktop">;
}

export const noBrowser: BrowserRuntime = {
  open: () => Promise.reject(new Error("no_sidecar")),
};

// A slow viewer drops frames rather than queueing them.
const maxBufferedFrameBytes = 1_000_000;

export function serveHandoff(broker: BrowserBroker, client: WebSocket, botId: string) {
  const linking = broker.attach(botId, {
    send: (message) => {
      if (
        client.readyState === client.OPEN &&
        (message.type !== "frame" || client.bufferedAmount < maxBufferedFrameBytes)
      ) {
        client.send(JSON.stringify(message));
      }
    },
  });
  client.on("message", (data) => void linking.then((link) => link.receive(String(data))));
  client.on("close", () => void linking.then((link) => link.detach()));
  client.on("error", () => client.terminate());
}
