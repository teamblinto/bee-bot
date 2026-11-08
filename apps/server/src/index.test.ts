import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { noRestartExitCodes, protocolVersion } from "@beebot/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { daemonTestTimeoutMs, spawnBeebotd } from "./fixtures/beebotd.ts";

const absentCli = [process.execPath, "-e", "process.exit(1)"];

let dataDir: string;
let daemon: ReturnType<typeof spawnBeebotd> | undefined;

beforeEach(() => {
  dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-cli-"));
});

afterEach(async () => {
  await daemon?.kill();
  daemon = undefined;
  await vi.waitFor(() => NodeFS.rmSync(dataDir, { recursive: true, force: true }));
});

function launch(bootstrap: object) {
  daemon = spawnBeebotd(bootstrap, { file: NodePath.join(dataDir, "bootstrap.json") });
  return daemon;
}

it(
  "boots from a bootstrap file and answers /health",
  async () => {
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    const { listening } = launch({
      port: 0,
      token,
      dataDir,
      allowedOrigins: [],
      claudeCommand: absentCli,
      codexCommand: absentCli,
    });
    const port = await listening;

    const response = await fetch(
      `http://127.0.0.1:${port}/health?protocolVersion=${protocolVersion}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(response.status).toBe(200);
  },
  daemonTestTimeoutMs,
);

it(
  "refuses an invalid bootstrap file with the no-restart code",
  async () => {
    const { exited } = launch({ port: 0, token: "too-short", dataDir, allowedOrigins: [] });
    expect(await exited).toBe(noRestartExitCodes.invalidBootstrap);
  },
  daemonTestTimeoutMs,
);
