import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Duplex, PassThrough } from "node:stream";

import { protocolVersion } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

import { type BoxLayout, boxLayout } from "./boxEngine.ts";
import {
  type BoxAttach,
  type BoxExec,
  type BoxRuntime,
  createFakeBoxRuntime,
} from "./boxRuntime.ts";
import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";
import { attachArgs, createControlParser, keysCommand } from "./terminal.ts";

describe("keysCommand", () => {
  it("sends ASCII as hex, so typed text can't become a tmux command", () => {
    expect(keysCommand("a; kill-server\r")).toBe(
      "send-keys -t bee-login -H 61 3b 20 6b 69 6c 6c 2d 73 65 72 76 65 72 d\n",
    );
  });

  it("sends other characters as a literal", () => {
    expect(keysCommand("é\x1b")).toBe(
      "send-keys -t bee-login -l 'é'\nsend-keys -t bee-login -H 1b\n",
    );
  });
});

describe("createControlParser", () => {
  it("turns %output lines back into bytes and ignores the rest", () => {
    const out: Buffer[] = [];
    const parse = createControlParser((data) => out.push(data));
    parse(Buffer.from("%begin 1 2 0\n%end 1 2 0\n%output %0 code: \\134 ok\\015\\0"));
    parse(Buffer.from("12\n%window-add @1\n%output %0 é\n"));
    expect(Buffer.concat(out).toString("utf8")).toBe("code: \\ ok\r\né");
  });
});

it("logs in with a device code for Codex, with the box's own environment", () => {
  expect(
    attachArgs("codex", { cols: 80, rows: 24 }, "/home/bee", { CODEX_HOME: "/home/bee/.codex" }),
  ).toEqual([
    "tmux",
    "-C",
    "new-session",
    "-s",
    "bee-login",
    "-c",
    "/home/bee",
    "-x",
    "80",
    "-y",
    "24",
    "-e",
    "CODEX_HOME=/home/bee/.codex",
    "codex",
    "login",
    "--device-auth",
  ]);
});

// What tmux control mode does with `send-keys -H`: the pane echoes the bytes back as %output.
function controlModeTmux(): BoxAttach {
  const output = new PassThrough();
  let pending = "";
  const input = new PassThrough();
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    const lines = (pending + chunk).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const hex = /^send-keys -t bee-login -H (.*)$/.exec(line)?.[1];
      if (hex) {
        const text = hex
          .split(" ")
          .map((code) => String.fromCharCode(Number.parseInt(code, 16)))
          .join("");
        const escaped = text.replace(
          /[\x00-\x1f\\]/g,
          (char) => `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`,
        );
        output.write(`%output %0 ${escaped}\n`);
      }
    }
  });
  const stream = Duplex.from({ readable: output, writable: input });
  const { promise: exited, resolve } = Promise.withResolvers<number | null>();
  stream.on("close", () => resolve(0));
  return { stream, exited };
}

const done = (): BoxAttach => {
  const stream = new PassThrough();
  stream.end();
  return { stream, exited: Promise.resolve(0) };
};

describe("the login terminal", () => {
  const token = "t".repeat(43);
  const secret = "sk-ant-oat01-NEVER-STORE-THIS";
  let dataDir: string;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-terminal-"));
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
    vi.restoreAllMocks();
    NodeFS.rmSync(dataDir, { recursive: true, force: true });
  });

  it("carries the bytes both ways and never puts them in the store, the events or the logs", async () => {
    const printed: string[] = [];
    for (const method of ["log", "error", "warn", "info", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      });
    }
    const execs: BoxExec[] = [];
    const runtime: BoxRuntime = {
      ...createFakeBoxRuntime(),
      execAttach: async (_botId, exec) => {
        execs.push(exec);
        return exec.argv[1] === "-C" ? controlModeTmux() : done();
      },
    };
    const layout: BoxLayout = boxLayout(dataDir);
    const store = openEventStore(dataDir);
    const server = await startServer({
      port: 0,
      token,
      dataDir,
      allowedOrigins: [],
      store,
      probeEngine: async () => ({
        cliFound: true,
        version: null,
        auth: "authenticated",
        email: null,
        pauseReason: null,
      }),
      box: { runtime, layout },
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
    });
    const base = `http://127.0.0.1:${server.port}`;
    const created = await fetch(`${base}/commands?protocolVersion=${protocolVersion}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: "create-bot", name: "Ada", personality: "" }),
    });
    const { id: botId } = (await created.json()) as { id: string };
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(NodePath.join(dataDir, "beebot.db"));
    db.prepare("UPDATE bots SET boundary = 'box' WHERE id = ?").run(botId);
    db.close();

    const query = new URLSearchParams({
      protocolVersion: String(protocolVersion),
      token,
      botId,
      cols: "100",
      rows: "30",
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/terminal?${query}`);
    const received: Buffer[] = [];
    socket.on("message", (data: Buffer) => received.push(data));
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ cols: 120, rows: 40 }));
    socket.send(Buffer.from(`${secret}\r`), { binary: true });
    await vi.waitFor(() => expect(Buffer.concat(received).toString()).toBe(`${secret}\r`));
    socket.close();
    await vi.waitFor(() =>
      expect(execs.at(-1)?.argv).toEqual(["tmux", "kill-session", "-t", "bee-login"]),
    );

    const attach = execs.find(({ argv }) => argv[1] === "-C");
    expect(attach?.argv.slice(-4)).toEqual(["claude", "auth", "login", "--claudeai"]);
    expect(JSON.stringify(store.eventsAfter(0))).not.toContain(secret);
    expect(JSON.stringify(store.state())).not.toContain(secret);
    for (const file of NodeFS.readdirSync(dataDir, { recursive: true, encoding: "utf8" })) {
      const path = NodePath.join(dataDir, file);
      if (NodeFS.statSync(path).isFile()) {
        expect(NodeFS.readFileSync(path).includes(secret), file).toBe(false);
      }
    }
    expect(printed.join("\n")).not.toContain(secret);
  });

  it("is only for box bots", async () => {
    const store = openEventStore(dataDir);
    const server = await startServer({
      port: 0,
      token,
      dataDir,
      allowedOrigins: [],
      store,
      probeEngine: async () => ({
        cliFound: true,
        version: null,
        auth: "authenticated",
        email: null,
        pauseReason: null,
      }),
      box: { runtime: createFakeBoxRuntime(), layout: boxLayout(dataDir) },
    });
    cleanups.push(async () => {
      await server.close();
      store.close();
    });
    const created = await fetch(
      `http://127.0.0.1:${server.port}/commands?protocolVersion=${protocolVersion}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: "create-bot", name: "Ada", personality: "" }),
      },
    );
    const { id: botId } = (await created.json()) as { id: string };
    const query = new URLSearchParams({
      protocolVersion: String(protocolVersion),
      token,
      botId,
      cols: "100",
      rows: "30",
    });
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/terminal?${query}`);
      socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.on("open", () => resolve(101));
      socket.on("error", () => {});
    });
    expect(status).toBe(404);
  });
});
