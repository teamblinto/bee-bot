import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import type { BoxState } from "@beebot/contracts";

import type { SidecarEndpoint } from "./browserCdp.ts";
import { recordingBoxRuntime } from "./boxes.ts";
import type { BoxRuntime } from "./boxRuntime.ts";
import { type BoxdBootstrap, type BoxdFiles, type BoxdHost, launchBoxd } from "./boxdRuntime.ts";
import { createEgressControl, type EgressInput } from "./egress.ts";
import type { Vault } from "./vault.ts";

const secretName = "boxd_secret";

export const windowsPodman = "C:\\Program Files\\RedHat\\Podman\\podman.exe";

// boxd signs its ownership labels with this, so a new one would disown every box made before.
export async function boxdSecret(vault: Vault) {
  const stored = await vault.get(secretName);
  if (stored !== undefined) {
    return Buffer.from(stored, "base64");
  }
  const secret = NodeCrypto.randomBytes(32);
  await vault.put(secretName, secret.toString("base64"));
  return secret;
}

const repo = NodePath.resolve(import.meta.dirname, "../../..");

// boxd ships as its TypeScript sources: the machine's Node runs them as they are.
export function boxdFiles(
  root = repo,
  egress = NodePath.join(root, "apps/boxd/egress/dist/egress.mjs"),
) {
  const src = NodePath.join(root, "apps/boxd/src");
  const sources = NodeFs.readdirSync(src)
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        !["testing.ts", "install.ts"].includes(file),
    )
    .sort((a, b) => Number(b === "main.ts") - Number(a === "main.ts"))
    .map((file) => NodePath.join(src, file));
  if (!NodeFs.existsSync(egress)) {
    throw new Error(`${egress} is missing: build apps/boxd/egress first`);
  }
  return {
    boxd: sources,
    runSpec: NodePath.join(root, "images/box/runSpec.json"),
    seccomp: NodePath.join(root, "images/box/seccomp-chromium.json"),
    egress,
  };
}

// A box comes up on its first use: created with its account's credentials, started, and its
// egress policy pushed again so a changed key or allowlist takes effect at the next turn.
export function readyBoxRuntime(
  runtime: BoxRuntime,
  {
    account,
    applyEgress,
  }: {
    account: (botId: string) => string | undefined;
    applyEgress: (botId: string) => Promise<void>;
  },
): BoxRuntime {
  const queues = new Map<string, Promise<unknown>>();
  function ready(botId: string) {
    const work = async () => {
      const state: BoxState = await runtime.snapshot(botId);
      if (state === "absent") {
        await runtime.create(botId, account(botId));
      }
      if (state !== "running") {
        await runtime.start(botId);
      }
      await applyEgress(botId);
    };
    const run = (queues.get(botId) ?? Promise.resolve()).then(work, work);
    queues.set(
      botId,
      run.catch(() => {}),
    );
    return run;
  }
  return {
    ...runtime,
    execAttach: async (botId, exec) => {
      await ready(botId);
      return runtime.execAttach(botId, exec);
    },
    cdp: async (botId) => {
      await ready(botId);
      return runtime.cdp(botId);
    },
  };
}

// Chromium's DevTools has no authentication, so the server reaches it only through boxd: every
// connection is a fresh attach on boxd's own channel, and nothing listens on the host.
export function sidecarEndpoint(runtime: BoxRuntime, botId: string): SidecarEndpoint {
  return {
    connect: async () => (await runtime.cdp(botId)).stream,
    downloadsDir: "/downloads",
    collect: (file, name) => runtime.collect(botId, file, name),
  };
}

export async function startBoxHost({
  host,
  installDir,
  owner,
  vault,
  account,
  egressInput,
  beebotdPort,
  setBox,
  bootstrap = {},
  files,
}: {
  host: BoxdHost;
  installDir: string;
  owner: string;
  vault: Vault;
  account: (botId: string) => string | undefined;
  egressInput: (botId: string) => EgressInput | null;
  beebotdPort: () => number;
  setBox: (botId: string, state: BoxState, reason?: string | null) => unknown;
  bootstrap?: Partial<BoxdBootstrap>;
  files?: BoxdFiles;
}) {
  const boxd = await launchBoxd({
    host,
    installDir,
    files: files ?? boxdFiles(),
    bootstrap: { owner, ...bootstrap, secret: await boxdSecret(vault) },
    hooks: { relay: () => NodeNet.connect(beebotdPort(), "127.0.0.1") },
  });
  const egress = createEgressControl({ connect: boxd.egressControl, vault, egressInput });
  const runtime = readyBoxRuntime(recordingBoxRuntime(boxd.runtime, setBox), {
    account,
    applyEgress: egress.apply,
  });
  return {
    runtime,
    egress,
    sidecar: async (botId: string) => sidecarEndpoint(runtime, botId),
    stderr: boxd.stderr,
    closed: boxd.closed,
    close: async () => {
      egress.close();
      await boxd.close();
    },
  };
}
