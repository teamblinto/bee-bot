import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { type Bot, type ChatState, type Command, protocolVersion } from "@beebot/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

import { openEventStore } from "./store.ts";

// The real `beebotd` on plain Node, driving the stand-in Claude CLI as a child process.
const entry = NodePath.join(import.meta.dirname, "index.ts");
const fakeCli = NodePath.join(import.meta.dirname, "fixtures", "claude", "fake-claude.mjs");
const token = "t".repeat(43);

let dataDir: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-daemon-"));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  await vi.waitFor(() => NodeFS.rmSync(dataDir, { recursive: true, force: true }));
});

async function freePort() {
  const probe = NodeNet.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as NodeNet.AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startDaemon(scenario: string, env: NodeJS.ProcessEnv = {}) {
  const port = await freePort();
  const child = NodeChildProcess.spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const exited = once(child, "exit");
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const claudeCommand = [process.execPath, fakeCli, scenario, NodePath.join(dataDir, "cli.log")];
  const bootstrap = { port, token, dataDir, allowedOrigins: [], claudeCommand };
  child.stdin.write(`${JSON.stringify(bootstrap)}\n`);
  await vi.waitFor(() => expect(output).toContain("listening"), { timeout: 10_000 });

  const url = (path: string) =>
    `http://127.0.0.1:${port}${path}?protocolVersion=${protocolVersion}`;
  const headers = { Authorization: `Bearer ${token}` };
  const state = async () =>
    ((await (await fetch(url("/state"), { headers })).json()) as { state: ChatState }).state;
  const command = async (body: Command) =>
    (await fetch(url("/commands"), { method: "POST", headers, body: JSON.stringify(body) })).json();
  // A turn needs an owner watching, so a socket stays subscribed.
  const params = new URLSearchParams({ protocolVersion: String(protocolVersion), token });
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${params}`);
  cleanups.push(() => socket.terminate());
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "subscribe", afterSeq: 0 }));
  const stop = async () => {
    socket.terminate();
    child.stdin.end();
    await exited;
  };
  return { state, command, stop, output: () => output };
}

async function chatWithTwoBots(daemon: Awaited<ReturnType<typeof startDaemon>>) {
  const bots: Bot[] = [];
  for (const name of ["Ada", "Grace"]) {
    bots.push((await daemon.command({ type: "create-bot", name, personality: "" })) as Bot);
  }
  for (const bot of bots) {
    await daemon.command({
      type: "send-message",
      messageId: NodeCrypto.randomUUID(),
      roomId: bot.roomId,
      body: `hello ${bot.name}`,
    });
  }
  await vi.waitFor(
    async () =>
      expect((await daemon.state()).messages.filter((m) => m.author === "bot")).toHaveLength(2),
    { timeout: 15_000 },
  );
  return bots;
}

const history = (state: ChatState, bot: Bot) =>
  state.messages
    .filter((m) => m.roomId === bot.roomId)
    .map(({ author, body }) => ({ author, body }));

function everyFile(dir: string): string[] {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = NodePath.join(dir, item.name);
    return item.isDirectory() ? everyFile(path) : [NodeFS.readFileSync(path, "latin1")];
  });
}

describe("the daemon with a Claude login", () => {
  it("keeps two bots' chats through a restart", async () => {
    const first = await startDaemon("success");
    const bots = await chatWithTwoBots(first);
    const before = await first.state();
    await first.stop();

    const second = await startDaemon("success");
    const after = await second.state();
    expect(after.bots.map(({ id, status }) => ({ id, status }))).toEqual(
      bots.map(({ id }) => ({ id, status: "ready" })),
    );
    for (const bot of bots) {
      expect(history(after, bot)).toEqual([
        { author: "human", body: `hello ${bot.name}` },
        { author: "bot", body: "noted" },
      ]);
    }
    expect(after.messages).toEqual(before.messages);
    await second.stop();
  }, 60_000);

  it("leaves no planted credential in the database files, its folder or the logs", async () => {
    const secret = "sk-ant-planted-7c1e9b";
    const settingsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-settings-"));
    cleanups.push(() => NodeFS.rmSync(settingsDir, { recursive: true, force: true }));
    const settings = { apiKeyHelper: `echo ${secret}-helper`, env: { ANTHROPIC_API_KEY: secret } };
    NodeFS.writeFileSync(NodePath.join(settingsDir, "settings.json"), JSON.stringify(settings));
    NodeFS.writeFileSync(NodePath.join(settingsDir, ".credentials.json"), `{"token":"${secret}"}`);
    const env = {
      ANTHROPIC_API_KEY: `${secret}-key`,
      ANTHROPIC_AUTH_TOKEN: `${secret}-auth`,
      CLAUDE_CODE_OAUTH_TOKEN: `${secret}-oauth`,
      CLAUDE_CONFIG_DIR: settingsDir,
    };

    const first = await startDaemon("success", env);
    await chatWithTwoBots(first);
    const live = everyFile(dataDir).join("");
    await first.stop();
    const second = await startDaemon("success", env);
    await second.state();
    await second.stop();

    const files = everyFile(dataDir);
    expect(files.length).toBeGreaterThan(1);
    for (const text of [live, ...files, first.output(), second.output()]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(settingsDir);
    }
  }, 60_000);

  it("pauses a Claude bot when the CLI is outside the tested version", async () => {
    const seeded = openEventStore(dataDir);
    seeded.createBot({ name: "Ada", personality: "", engineAccountId: "claude" });
    seeded.close();
    const daemon = await startDaemon("gate-version");
    await vi.waitFor(
      async () =>
        expect((await daemon.state()).bots[0]).toMatchObject({
          status: "paused",
          pauseReason: "cli_version",
        }),
      { timeout: 10_000 },
    );
    expect(daemon.output()).toContain("Claude bots paused: cli_version");
    await daemon.stop();
  }, 30_000);
});
