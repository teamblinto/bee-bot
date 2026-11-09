import { DatabaseSync } from "node:sqlite";

import type { HandoffInput, HandoffServerMessage } from "@beebot/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { openAudit } from "./audit.ts";
import { createBrowserBroker, downloadAllowed, resolveUrl } from "./browser.ts";
import type { PolicyDecision } from "./broker.ts";
import { createFakeBrowserRuntime, type FakePage } from "./browserRuntime.ts";
import { migrate } from "./store.ts";
import { openTakeovers } from "./takeovers.ts";

const run = { id: "run-1", botId: "bot-1", attended: true };

const pages: Record<string, FakePage> = {
  "https://example.com/": {
    title: "Example",
    text: "Welcome",
    elements: [{ role: "a", name: "Sign in", value: null, href: "https://example.com/login" }],
  },
  "https://example.com/login": {
    title: "Sign in",
    passwordField: true,
    elements: [
      { role: "input:text", name: "Email", value: "" },
      { role: "input:password", name: "Password", value: null },
      { role: "button", name: "Next", value: null, href: "https://example.com/home" },
    ],
  },
  "https://example.com/home": {
    title: "Home",
    text: "Signed in as ada@example.org",
    elements: [
      { role: "input:text", name: "Search", value: "" },
      { role: "button", name: "Pay", value: null },
    ],
  },
};

function setup(decision: PolicyDecision = { kind: "allow" }, takeoverTtlMs?: number) {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const { appendAudit } = openAudit(db);
  const takeovers = openTakeovers(db, { transaction: (work) => work(), emit: () => 0 });
  const desktop: string[] = [];
  const fake = createFakeBrowserRuntime(pages);
  const outbound: unknown[] = [];
  const paused = new Map<string, boolean>();
  const checked: unknown[] = [];
  const broker = createBrowserBroker({
    runtime: fake.runtime,
    check: (_run, tool, args) => {
      checked.push([tool, args]);
      return decision;
    },
    appendAudit: (record) => {
      outbound.push(record);
      appendAudit(record);
    },
    setPaused: (botId, value) => {
      outbound.push({ botId, value });
      paused.set(botId, value);
    },
    notify: (_run, text) => outbound.push(text),
    requestApproval: (_run, tool, args) => {
      outbound.push({ tool, args });
      return JSON.stringify({ status: "waiting" });
    },
    desktop: {
      take: (_botId, leaseId) => desktop.push(`take ${leaseId}`) > 0,
      give: (leaseId) => desktop.push(`give ${leaseId}`) > 0,
    },
    takeovers: {
      request: (run, reason) => takeovers.requestTakeover(run.botId, run.id, reason),
      take: (botId) => takeovers.moveTakeover(botId, "waiting", "taken"),
      complete: (botId) => takeovers.moveTakeover(botId, "taken", "completed"),
      expire: (id, release) => {
        const expired = takeovers.expireTakeover(id);
        if (expired) {
          release();
        }
        return expired;
      },
      cancel: (botId) =>
        takeovers.moveTakeover(botId, "waiting", "cancelled") ??
        takeovers.moveTakeover(botId, "taken", "cancelled"),
    },
    ...(takeoverTtlMs !== undefined && { takeoverTtlMs }),
  });
  const takeoverStates = () =>
    db.prepare("SELECT state, reason FROM takeovers ORDER BY rowid").all();
  const audit = () =>
    db.prepare("SELECT status, reason, tool, initiator, digest FROM audit_log ORDER BY id").all();
  const call = async (name: string, args: unknown = {}) => {
    const text = await broker.call(run, name, args);
    outbound.push(text);
    return JSON.parse(text);
  };
  async function owner() {
    const received: HandoffServerMessage[] = [];
    const link = await broker.attach(run.botId, { send: (message) => received.push(message) });
    const send = (message: object) => link.receive(JSON.stringify(message));
    const lease = () => received.findLast(({ type }) => type === "lease");
    return { received, link, send, lease };
  }
  return {
    db,
    fake,
    broker,
    outbound,
    checked,
    paused,
    audit,
    call,
    owner,
    desktop,
    takeoverStates,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser tools", () => {
  it("asks the broker first, then acts and answers with refs", async () => {
    const { call, checked, fake } = setup();
    const answer = await call("browser_navigate", { url: "https://example.com/" });
    expect(answer.status).toBe("ok");
    expect(answer.page.elements).toEqual([{ ref: "1:0", role: "a", name: "Sign in" }]);
    expect(fake.received).toEqual(["navigate https://example.com/"]);
    expect(checked).toEqual([["browser_navigate", { url: "https://example.com/" }]]);
  });

  it("refuses a denied call without opening the browser", async () => {
    const { call, fake, owner } = setup({ kind: "deny", reason: "not_granted" });
    const answer = await call("browser_navigate", { url: "https://example.com/" });
    expect(answer).toMatchObject({ status: "refused", reason: "not_granted" });
    expect(fake.received).toEqual([]);
    expect(fake.opened()).toBe(0);
    await owner();
    expect(fake.opened()).toBe(1);
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pw@example.com/",
    "chrome://settings",
  ])("opens only web pages, not %s", async (url) => {
    const { call, fake } = setup();
    expect((await call("browser_navigate", { url })).status).toBe("refused");
    expect(fake.received).toEqual([]);
  });

  it("passes an approval to the continuation, untouched", async () => {
    const { call, outbound, fake } = setup({ kind: "approve" });
    await call("browser_click", { ref: "1:0" });
    expect(outbound).toContainEqual(
      expect.objectContaining({ tool: "browser_click", args: { ref: "1:0" } }),
    );
    expect(fake.received).toEqual([]);
  });

  it("routes a hand_off to the owner and pauses the bot", async () => {
    const { call, paused, outbound, owner } = setup({ kind: "hand_off", reason: "a payment" });
    const view = await owner();
    const answer = await call("browser_click", { ref: "1:1" });
    expect(answer.status).toBe("handed_off");
    expect(paused.get(run.botId)).toBe(true);
    expect(outbound).toContainEqual(expect.stringContaining("a payment"));
    expect(view.lease()).toMatchObject({ requested: "hand_off", note: "a payment" });
  });

  it("pauses on a sign-in wall, and lifts the pause once the owner signs in", async () => {
    const { call, paused, owner, audit } = setup();
    await call("browser_navigate", { url: "https://example.com/" });
    const wall = await call("browser_click", { ref: "1:0" });
    expect(wall).toMatchObject({ status: "paused", reason: "login" });
    expect(wall).not.toHaveProperty("page");
    expect(paused.get(run.botId)).toBe(true);

    const view = await owner();
    expect(view.lease()).toMatchObject({ requested: "login", holder: "bot" });
    view.send({ type: "take" });
    expect(view.lease()).toMatchObject({ holder: "human", mine: true });
    view.send({
      type: "input",
      input: { type: "mouse", action: "down", x: 10, y: 250, button: "left" },
    });
    view.send({ type: "give" });
    await settle();
    expect(paused.get(run.botId)).toBe(false);
    expect(view.lease()).toMatchObject({ holder: "bot", requested: null });
    expect(audit().map(({ status }) => status)).toContain("handoff_returned");
  });

  it("keeps the bot out while the owner holds control, then shows it a fresh page", async () => {
    const { call, owner, fake } = setup();
    const first = await call("browser_navigate", { url: "https://example.com/" });
    const view = await owner();
    view.send({ type: "take" });
    expect(await call("browser_click", { ref: first.page.elements[0].ref })).toMatchObject({
      status: "refused",
    });
    expect(fake.received).toEqual(["navigate https://example.com/"]);

    view.send({ type: "give" });
    await settle();
    const after = await call("browser_click", { ref: first.page.elements[0].ref });
    expect(after.status).toBe("stale_ref");
    expect(after.page.elements[0].ref).not.toBe(first.page.elements[0].ref);
    expect(fake.received).toEqual(["navigate https://example.com/"]);
  });

  it("gives control to one owner socket at a time, and takes it back when that socket goes", async () => {
    const { owner } = setup();
    const a = await owner();
    const b = await owner();
    a.send({ type: "take" });
    b.send({ type: "take" });
    expect(a.lease()).toMatchObject({ holder: "human", mine: true });
    expect(b.lease()).toMatchObject({ holder: "human", mine: false });
    b.send({ type: "give" });
    expect(a.lease()).toMatchObject({ mine: true });
    a.link.detach();
    await settle();
    expect(b.lease()).toMatchObject({ holder: "bot" });
  });

  it("ignores input from a socket that doesn't hold control", async () => {
    const { owner, fake } = setup();
    const view = await owner();
    view.send({ type: "text", text: "nope" });
    view.send({ type: "input", input: { type: "key", action: "down", key: "x", code: "KeyX" } });
    expect(fake.received).toEqual([]);
  });

  it("refuses an executable download and records only a digest of its name", async () => {
    const { fake, call, audit } = setup();
    await call("browser_snapshot");
    expect(fake.download(run.botId, "setup.EXE")).toBe(false);
    expect(fake.download(run.botId, "report.pdf")).toBe(true);
    await settle();
    expect(audit().map(({ status }) => status)).toEqual(["download_refused", "download"]);
    expect(JSON.stringify(audit())).not.toContain("report");
    expect((await call("browser_snapshot")).page.downloads).toEqual(["report.pdf"]);
  });

  it("checks names and URLs", () => {
    expect(downloadAllowed("notes.txt")).toBe(true);
    expect(downloadAllowed("run.sh ")).toBe(false);
    expect(downloadAllowed("installer.AppImage")).toBe(false);
    expect(resolveUrl("https://example.com/a?b=1")?.host).toBe("example.com");
    expect(resolveUrl("not a url")).toBeUndefined();
  });
});

describe("takeover", () => {
  it("waits for the owner, starts the desktop's input server only for the lease, and resumes", async () => {
    const { call, owner, paused, outbound, desktop, takeoverStates, audit } = setup();
    const view = await owner();
    const other = await owner();
    const asked = await call("request_takeover", { reason: "sign in through the native dialog" });
    expect(asked).toMatchObject({ status: "paused", reason: "takeover" });
    expect(asked.note).toContain("End your turn");
    expect(paused.get(run.botId)).toBe(true);
    expect(outbound).toContainEqual(expect.stringContaining("sign in through the native dialog"));
    expect(view.lease()).toMatchObject({ requested: "takeover", leaseId: null });
    expect(takeoverStates()).toEqual([
      { state: "waiting", reason: "sign in through the native dialog" },
    ]);
    expect(desktop).toEqual([]);

    view.send({ type: "take" });
    const held = view.lease();
    const leaseId = held?.type === "lease" ? held.leaseId : undefined;
    expect(leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(other.lease()).toMatchObject({ holder: "human", mine: false, leaseId: null });
    expect(desktop).toEqual([`take ${leaseId}`]);
    expect(takeoverStates()).toMatchObject([{ state: "taken" }]);
    expect(await call("browser_snapshot")).toMatchObject({ status: "refused" });

    view.send({ type: "give" });
    await settle();
    expect(desktop).toEqual([`take ${leaseId}`, `give ${leaseId}`]);
    expect(takeoverStates()).toMatchObject([{ state: "completed" }]);
    expect(paused.get(run.botId)).toBe(false);
    expect(view.lease()).toMatchObject({ holder: "bot", requested: null });
    const handoffs = audit().filter(({ status }) => String(status).startsWith("handoff_"));
    expect(handoffs).toMatchObject([
      { status: "handoff_taken", tool: "desktop", reason: expect.stringMatching(/^takeover:/) },
      { status: "handoff_returned", tool: "desktop", reason: expect.stringMatching(/^takeover:/) },
    ]);
  });

  it("stops the input server when the holder's socket goes", async () => {
    const { owner, desktop } = setup();
    const view = await owner();
    view.send({ type: "take" });
    view.link.detach();
    await settle();
    expect(desktop.map((line) => line.split(" ")[0])).toEqual(["take", "give"]);
  });

  it("expires a takeover nobody took, and lifts the pause", async () => {
    const { call, owner, paused, takeoverStates } = setup({ kind: "allow" }, 20);
    const view = await owner();
    await call("request_takeover", { reason: "solve the puzzle" });
    expect(paused.get(run.botId)).toBe(true);
    await vi.waitFor(() => expect(takeoverStates()).toMatchObject([{ state: "expired" }]));
    expect(paused.get(run.botId)).toBe(false);
    expect(view.lease()).toMatchObject({ requested: null });
  });

  it("a stopped bot's takeover leaves no pause and no notice behind", async () => {
    const { call, owner, paused, takeoverStates, broker } = setup();
    const view = await owner();
    await call("request_takeover", { reason: "sign in" });
    await broker.stop(run.botId);
    expect(takeoverStates()).toMatchObject([{ state: "cancelled" }]);
    expect(paused.get(run.botId)).toBe(false);
    expect(view.lease()).toMatchObject({ requested: null });
  });

  it("tells watchers when the browser goes away, and ends the person's control", async () => {
    const { owner, fake, desktop } = setup();
    const view = await owner();
    view.send({ type: "take" });
    fake.lose(run.botId);
    await settle();
    expect(view.received).toContainEqual({ type: "unavailable" });
    expect(desktop.map((line) => line.split(" ")[0])).toEqual(["take", "give"]);
    expect(view.lease()).toMatchObject({ holder: "bot" });
    await owner();
    expect(fake.opened()).toBe(2);
  });

  it("refuses a request without a reason", async () => {
    const { call, takeoverStates } = setup();
    expect(await call("request_takeover", { reason: " " })).toMatchObject({ status: "refused" });
    expect(takeoverStates()).toEqual([]);
  });
});

describe("private sign-in channel", () => {
  it("keeps what the owner types out of the bot's answers, the audit log and the logs", async () => {
    const logged: unknown[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => logged.push(args));
    }
    const { call, owner, fake, db, outbound } = setup();
    await call("browser_navigate", { url: "https://example.com/" });
    await call("browser_click", { ref: "1:0" });

    const view = await owner();
    view.send({ type: "take" });
    const press = (key: string): HandoffInput => ({ type: "key", action: "down", key, code: "" });
    view.send({
      type: "input",
      input: { type: "mouse", action: "down", x: 5, y: 50, button: "left" },
    });
    for (const key of "ada@example.org") {
      view.send({ type: "input", input: press(key) });
      view.send({ type: "input", input: { ...press(key), action: "up" } });
    }
    view.send({ type: "input", input: press("Tab") });
    view.send({
      type: "input",
      input: { type: "mouse", action: "down", x: 5, y: 150, button: "left" },
    });
    view.send({ type: "text", text: "correct-horse-battery" });
    // Malformed messages are dropped without a word, even when they carry the secret.
    view.link.receive('{"type":"text","text":"correct-horse-battery"');
    view.link.receive(JSON.stringify({ type: "bogus", text: "correct-horse-battery" }));
    view.send({
      type: "input",
      input: { type: "mouse", action: "down", x: 5, y: 250, button: "left" },
    });
    view.send({ type: "give" });
    await settle();

    expect(fake.received).toContain("text correct-horse-battery");
    expect(fake.received.some((line) => line.includes('"key":"@"'))).toBe(true);

    const snapshot = await call("browser_snapshot");
    expect(snapshot.page.text).toBe("Signed in as [typed by owner]");
    const search = snapshot.page.elements[0].ref;
    const typed = await call("browser_type", { ref: search, text: "news" });
    expect(typed.page.text).toBe("Signed in as [typed by owner] news");

    const everything = JSON.stringify([
      outbound,
      logged,
      db.prepare("SELECT * FROM audit_log").all(),
      view.received.filter(({ type }) => type !== "frame"),
    ]);
    for (const secret of ["ada@example.org", "ada%40example.org", "correct-horse-battery"]) {
      expect(everything).not.toContain(secret);
    }
  });
});
