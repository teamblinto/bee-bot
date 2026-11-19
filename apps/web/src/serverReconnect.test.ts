import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

class FakeSocket {
  static opened: FakeSocket[] = [];
  onopen: (() => void) | undefined;
  onclose: (() => void) | undefined;
  onmessage: ((event: MessageEvent<string>) => void) | undefined;
  sent: string[] = [];
  constructor() {
    FakeSocket.opened.push(this);
  }
  send(text: string) {
    this.sent.push(text);
  }
}

let healthStatus: number | "unreachable";
const healthChecks = vi.fn();

async function load() {
  vi.resetModules();
  vi.stubGlobal("window", {
    beeDesktop: {},
    location: { search: "?serverUrl=http://127.0.0.1:1&token=t" },
  });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("document", { addEventListener: () => {}, visibilityState: "visible" });
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", async (url: URL) => {
    if (url.pathname !== "/health") {
      return Response.json({ code: "engine_check_failed" }, { status: 500 });
    }
    healthChecks();
    if (healthStatus === "unreachable") {
      throw new TypeError("fetch failed");
    }
    return Response.json({}, { status: healthStatus });
  });
  return import("./serverConnection");
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.opened = [];
  healthChecks.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("backs off between failed attempts up to a cap, and starts over once connected", async () => {
  healthStatus = "unreachable";
  const { connect, getConnectionState } = await load();
  await connect();
  expect(getConnectionState().status).toBe("disconnected");

  const waits: number[] = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    const before = healthChecks.mock.calls.length;
    let waited = 0;
    while (healthChecks.mock.calls.length === before) {
      await vi.advanceTimersByTimeAsync(500);
      waited += 500;
    }
    waits.push(waited);
  }
  expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);

  healthStatus = 200;
  await vi.advanceTimersByTimeAsync(30_000);
  const socket = FakeSocket.opened.at(-1);
  socket?.onopen?.();
  expect(getConnectionState().status).toBe("connected");
  expect(JSON.parse(socket?.sent[0] ?? "")).toEqual({ type: "subscribe", afterSeq: 0 });

  const before = healthChecks.mock.calls.length;
  socket?.onclose?.();
  expect(getConnectionState().status).toBe("disconnected");
  await vi.advanceTimersByTimeAsync(1000);
  expect(healthChecks.mock.calls.length).toBe(before + 1);
});

it("stops on a protocol mismatch instead of retrying", async () => {
  healthStatus = 426;
  const { connect, getConnectionState } = await load();
  await connect();
  expect(getConnectionState().status).toBe("incompatible");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(healthChecks).toHaveBeenCalledTimes(1);
  expect(FakeSocket.opened).toEqual([]);
});
