import { protocolVersion } from "@beebot/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const requests: { url: URL; headers: Record<string, string> }[] = [];
const assign = vi.fn();

async function load(href: string, options: { desktop?: boolean; status?: number } = {}) {
  vi.resetModules();
  requests.length = 0;
  assign.mockClear();
  const url = new URL(href);
  vi.stubGlobal("window", {
    ...(options.desktop && { beeDesktop: {} }),
    location: {
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      assign,
    },
  });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" });
  vi.stubGlobal("WebSocket", vi.fn());
  vi.stubGlobal("fetch", async (target: URL, init: RequestInit = {}) => {
    requests.push({ url: target, headers: { ...(init.headers as Record<string, string>) } });
    return Response.json({}, { status: options.status ?? 200 });
  });
  return import("./serverConnection");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("talks to its own origin with no token outside the desktop app", async () => {
  const { socketUrl, terminalSocketUrl, connect } = await load(
    "https://bee.example/?serverUrl=http://evil.example&token=leak",
  );
  expect(socketUrl("/ws").href).toBe(`wss://bee.example/ws?protocolVersion=${protocolVersion}`);
  expect(terminalSocketUrl("bot", 80, 24).searchParams.has("token")).toBe(false);
  await connect();
  expect(requests[0]?.url.origin).toBe("https://bee.example");
  expect(requests[0]?.headers).toEqual({});
});

it("uses ws on plain http", async () => {
  const { socketUrl, displaySocketUrl } = await load("http://localhost:5833/");
  expect(socketUrl("/ws").protocol).toBe("ws:");
  expect(displaySocketUrl("t").origin).toBe("ws://localhost:5833");
});

it("keeps the desktop's server and token", async () => {
  const { socketUrl, connect } = await load(
    "file:///app/index.html?serverUrl=http://127.0.0.1:9&token=t",
    {
      desktop: true,
    },
  );
  expect(socketUrl("/ws").origin).toBe("ws://127.0.0.1:9");
  expect(socketUrl("/ws").searchParams.get("token")).toBe("t");
  await connect();
  expect(requests[0]?.headers).toEqual({ Authorization: "Bearer t" });
});

it("sends a signed-out user to /login once, back to where they were", async () => {
  const { connect, postCommand } = await load("https://bee.example/?x=1#/bots/a", { status: 401 });
  await connect();
  await postCommand({ type: "acknowledge-automated-access" });
  expect(assign).toHaveBeenCalledTimes(1);
  expect(assign).toHaveBeenCalledWith(`/login?next=${encodeURIComponent("/?x=1#/bots/a")}`);
});

it("never redirects from /login or inside the desktop app", async () => {
  const onLogin = await load("https://bee.example/login?next=%2F", { status: 401 });
  await onLogin.connect();
  expect(assign).not.toHaveBeenCalled();

  const inDesktop = await load("file:///app/index.html?serverUrl=http://127.0.0.1:9&token=t", {
    desktop: true,
    status: 401,
  });
  await inDesktop.postCommand({ type: "acknowledge-automated-access" });
  expect(assign).not.toHaveBeenCalled();
});
