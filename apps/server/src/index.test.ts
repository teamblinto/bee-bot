import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { once } from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { noRestartExitCodes, protocolVersion } from "@beebot/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const entry = NodePath.join(import.meta.dirname, "index.ts");
const absentCli = [process.execPath, "-e", "process.exit(1)"];

let dataDir: string;
let child: NodeChildProcess.ChildProcess | undefined;

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-cli-"));
});

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  child = undefined;
  await vi.waitFor(() => NodeFS.rmSync(dataDir, { recursive: true, force: true }));
});

function launch(bootstrap: object) {
  const path = NodePath.join(dataDir, "bootstrap.json");
  NodeFS.writeFileSync(path, JSON.stringify(bootstrap));
  const server = NodeChildProcess.spawn(process.execPath, [entry, "--bootstrap", path], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  child = server;
  return server;
}

it("boots from a bootstrap file and answers /health", async () => {
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  const server = launch({
    port: 0,
    token,
    dataDir,
    allowedOrigins: [],
    claudeCommand: absentCli,
    codexCommand: absentCli,
  });
  const port = await new Promise<string>((resolve, reject) => {
    let output = "";
    server.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(output)?.[1];
      if (port) {
        resolve(port);
      }
    });
    server.once("exit", (code) => reject(new Error(`beebotd exited with ${code}: ${output}`)));
  });

  const response = await fetch(
    `http://127.0.0.1:${port}/health?protocolVersion=${protocolVersion}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  expect(response.status).toBe(200);
});

it("refuses an invalid bootstrap file with the no-restart code", async () => {
  const server = launch({ port: 0, token: "too-short", dataDir, allowedOrigins: [] });
  const [code] = await once(server, "exit");
  expect(code).toBe(noRestartExitCodes.invalidBootstrap);
});
