import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createCdpBrowserRuntime, inputCommand } from "./browserCdp.ts";
import { detectChallenge } from "./browserChallenge.ts";
import type { BrowserSession, ScreencastFrame } from "./browserRuntime.ts";

describe("CDP input", () => {
  it("submits a form on Enter, and leaves a named key without text", () => {
    expect(
      inputCommand({ type: "key", action: "down", key: "Enter", code: "Enter" }).params,
    ).toMatchObject({ type: "keyDown", text: "\r", windowsVirtualKeyCode: 13 });
    expect(
      inputCommand({ type: "key", action: "down", key: "ArrowLeft", code: "ArrowLeft" }).params,
    ).not.toHaveProperty("text");
    expect(inputCommand({ type: "key", action: "up", key: "a", code: "KeyA" }).params).toEqual({
      type: "keyUp",
      key: "a",
      code: "KeyA",
    });
  });
});

// Until workstream 1's image exists: the S3 spike's Chromium image and seccomp profile, which keep
// Chromium's own sandbox on. Headless Chromium binds DevTools to loopback only, so a small relay in
// the sidecar stands in for the broker network.
const image = "localhost/beebot-dev-chromium:s3";
const seccomp = "/home/user/beebot-dev-s3/chromium-seccomp.json";
const windowsPodman = "C:\\Program Files\\RedHat\\Podman\\podman.exe";
const podman =
  process.platform === "win32" && NodeFS.existsSync(windowsPodman) ? windowsPodman : "podman";
const relay = `require("net").createServer((c) => {
  const u = require("net").connect(9222, "127.0.0.1");
  c.pipe(u).pipe(c);
  u.on("error", () => c.destroy());
  c.on("error", () => u.destroy());
}).listen(9223, "0.0.0.0")`;

function run(args: string[]) {
  const result = NodeChildProcess.spawnSync(podman, args, {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

const available = run(["image", "exists", image]).ok;

describe.skipIf(!available)("sidecar Chromium over CDP", { timeout: 120_000 }, () => {
  let containerId = "";
  let session: BrowserSession;
  const offered: string[] = [];

  beforeAll(async () => {
    const started = run([
      "run",
      "-d",
      "--rm",
      "--name",
      `beebot-dev-ws7-${NodeCrypto.randomBytes(4).toString("hex")}`,
      "--label",
      "beebot-dev=1",
      "--user",
      "10001:10001",
      "--cap-drop=all",
      "--security-opt",
      "no-new-privileges",
      "--security-opt",
      `seccomp=${seccomp}`,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,size=256m,mode=1777",
      "--tmpfs",
      "/home/browser:rw,size=512m,mode=1777",
      "--shm-size=1g",
      "--memory",
      "1g",
      "--memory-swap",
      "1g",
      "--cpus",
      "2",
      "--pids-limit",
      "512",
      "-p",
      "127.0.0.1::9223",
      image,
      "sh",
      "-c",
      'mkdir -p /home/browser/downloads && chromium-browser --headless=new --disable-gpu --remote-debugging-port=9222 --user-data-dir=/home/browser/profile about:blank 2>/dev/null & exec node -e "$0"',
      relay,
    ]);
    expect(started.ok).toBe(true);
    containerId = started.out;
    const port = run(["port", containerId, "9223"]).out.split(":").at(-1);
    const http = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 60; attempt++) {
      const ready = await fetch(new URL("/json/version", http)).then(
        (r) => r.ok,
        () => false,
      );
      if (ready) {
        break;
      }
      await sleep(500);
    }
    const runtime = createCdpBrowserRuntime(async () => ({
      connect: async () => NodeNet.connect(Number(port), "127.0.0.1"),
      downloadsDir: "/home/browser/downloads",
    }));
    session = await runtime.open("bot", (name) => {
      offered.push(name);
      return !name.endsWith(".exe");
    });
  }, 90_000);

  afterAll(async () => {
    await session?.close();
    if (containerId) {
      run(["rm", "-f", containerId]);
    }
  }, 60_000);

  const page = `data:text/html,${encodeURIComponent(`<!doctype html><title>Sign in</title>
    <form><input id="user" aria-label="Email"><input type="password" aria-label="Password"></form>
    <p id="echo"></p>
    <a href="data:text/plain;base64,aGk=" download="notes.txt">notes</a>
    <a href="data:application/octet-stream;base64,TVo=" download="tool.exe">tool</a>
    <script>user.oninput = () => (echo.textContent = "Hello " + user.value);</script>`)}`;

  it("reads the page, sees the sign-in wall, and never reads a password", async () => {
    await session.navigate(page);
    const snapshot = await session.snapshot();
    expect(detectChallenge(snapshot)).toBe("login");
    expect(snapshot.elements.map(({ role, name }) => `${role} ${name}`)).toEqual([
      "input:text Email",
      "input:password Password",
      "a notes",
      "a tool",
    ]);
    expect(await session.type(1, "s3cret-value")).toBe(true);
    expect((await session.snapshot()).elements[1]?.value).toBeNull();
  });

  it("takes the owner's keys and private text into the focused field", async () => {
    expect(await session.click(0)).toBe(true);
    for (const key of ["a", "b"]) {
      await session.input({ type: "key", action: "down", key, code: `Key${key.toUpperCase()}` });
      await session.input({ type: "key", action: "up", key, code: `Key${key.toUpperCase()}` });
    }
    await session.insertText("@c.d");
    const snapshot = await session.snapshot();
    expect(snapshot.elements[0]?.value).toBe("ab@c.d");
    expect(snapshot.text).toContain("Hello ab@c.d");
  });

  it("refuses an old ref once the page has moved on", async () => {
    await session.navigate(page);
    expect(await session.click(0)).toBe(false);
  });

  it("streams frames for the handoff view", async () => {
    const frames: ScreencastFrame[] = [];
    const stop = await session.screencast((frame) => frames.push(frame));
    for (let attempt = 0; attempt < 20 && frames.length === 0; attempt++) {
      await sleep(250);
    }
    await stop();
    expect(frames[0]?.data.startsWith("/9j/")).toBe(true);
    expect(frames[0]?.width).toBeGreaterThan(0);
  });

  it("lands downloads in the narrow folder under bare GUID names", async () => {
    await session.snapshot();
    await session.click(2);
    await session.click(3);
    await sleep(1500);
    expect(offered).toEqual(["notes.txt", "tool.exe"]);
    const files = run(["exec", containerId, "ls", "/home/browser/downloads"]).out.split("\n");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
