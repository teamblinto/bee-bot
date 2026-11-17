import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { once } from "node:events";
import * as NodeNet from "node:net";
import * as NodeTimers from "node:timers/promises";

import {
  type Bootstrap,
  type DesktopError,
  type DesktopUsage,
  type IdleSignal,
  noRestartExitCodes,
  type PowerSignal,
  ProtocolNotice,
  protocolVersion,
  toErrorReport,
  type UsageProperties,
} from "@beebot/contracts";
import { dialog } from "electron";

const readyTimeoutMs = 15_000;
const stopTimeoutMs = 5000;
const maxRestarts = 3;
const stableUptimeMs = 60_000;
const maxPendingLines = 50;
const maxUptimeMs = 30 * 24 * 60 * 60_000;

type Options = Pick<
  Bootstrap,
  "dataDir" | "allowedOrigins" | "fakeEngine" | "vault" | "hostControl" | "cuaDriver" | "telemetry"
> & {
  entry: string;
};

let child: ReturnType<typeof spawnServer> | undefined;
let stopping = false;
let failed = false;
let restarts = 0;
// Usage and error lines written while no server is up, for the next one after its bootstrap line.
const pendingLines: string[] = [];

async function findFreePort() {
  const probe = NodeNet.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as NodeNet.AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function fail(reason: string) {
  if (!failed) {
    failed = true;
    dialog.showErrorBox("Bee Bot server stopped", reason);
  }
}

function spawnServer(entry: string, bootstrap: Bootstrap) {
  const server = NodeChildProcess.spawn(process.execPath, [entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  const startedAt = Date.now();

  // stdin stays open: the server treats EOF as the order to stop, which also covers our crash.
  server.stdin.on("error", () => {});
  server.stdin.write(`${JSON.stringify(bootstrap)}\n`);
  for (const line of pendingLines.splice(0)) {
    server.stdin.write(line);
  }

  server.once("error", (error) => fail(error.message));
  server.once("exit", (code, signal) => {
    if (stopping) {
      return;
    }
    child = undefined;
    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs > stableUptimeMs) {
      restarts = 0;
    }
    const noRestart = Object.values<number | null>(noRestartExitCodes).includes(code);
    sendUsage("server_crashed", {
      exit_code: code,
      signal,
      uptime_ms: Math.min(uptimeMs, maxUptimeMs),
      will_restart: !noRestart && restarts < maxRestarts,
    });
    if (noRestart || restarts >= maxRestarts) {
      fail(`The server exited with code ${code}.`);
      return;
    }
    const delayMs = 500 * 2 ** restarts;
    restarts += 1;
    setTimeout(() => {
      if (!stopping) {
        child = spawnServer(entry, bootstrap);
      }
    }, delayMs);
  });
  return server;
}

async function waitForReady(url: string, token: string) {
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (failed) {
      throw new Error("Server failed");
    }
    try {
      const response = await fetch(`${url}/health?protocolVersion=${protocolVersion}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return;
      }
      if (response.status === 426) {
        fail(ProtocolNotice.parse(await response.json()).message);
      }
    } catch {
      // Not listening yet.
    }
    await NodeTimers.setTimeout(100);
  }
  fail("The server did not become ready.");
  throw new Error("Server not ready");
}

export async function startServer({ entry, ...options }: Options) {
  const port = await findFreePort();
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  const url = `http://127.0.0.1:${port}`;
  child = spawnServer(entry, { port, token, ...options });
  await waitForReady(url, token);
  return { url, token };
}

export function sendPower(power: PowerSignal["power"]) {
  if (child?.stdin.writable) {
    child.stdin.write(`${JSON.stringify({ power } satisfies PowerSignal)}
`);
  }
}

export function sendIdle(idleSeconds: IdleSignal["idleSeconds"]) {
  if (child?.stdin.writable) {
    child.stdin.write(`${JSON.stringify({ idleSeconds } satisfies IdleSignal)}\n`);
  }
}

function sendLine(line: DesktopUsage | DesktopError) {
  const text = `${JSON.stringify(line)}\n`;
  if (child?.stdin.writable) {
    child.stdin.write(text);
    return;
  }
  pendingLines.push(text);
  pendingLines.splice(0, pendingLines.length - maxPendingLines);
}

export function sendUsage<E extends DesktopUsage["usage"]["event"]>(
  event: E,
  properties: UsageProperties<E>,
) {
  sendLine({ usage: { event, properties } });
}

export function sendError(error: unknown) {
  sendLine({ error: toErrorReport(error, "desktop") });
}

export async function stopServer() {
  stopping = true;
  const server = child;
  if (!server || server.exitCode !== null || server.signalCode !== null) {
    return;
  }
  const exited = once(server, "exit");
  server.stdin.end();
  await Promise.race([exited, NodeTimers.setTimeout(stopTimeoutMs)]);
  if (server.exitCode === null && server.signalCode === null) {
    server.kill();
    await exited;
  }
}
