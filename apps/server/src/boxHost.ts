import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

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
): BoxRuntime & { ready: (botId: string) => Promise<void> } {
  const queues = new Map<string, Promise<unknown>>();
  function serially(botId: string, work: () => Promise<void>) {
    const run = (queues.get(botId) ?? Promise.resolve()).then(work, work);
    queues.set(
      botId,
      run.catch(() => {}),
    );
    return run;
  }
  function ready(botId: string) {
    return serially(botId, async () => {
      const state: BoxState = await runtime.snapshot(botId);
      if (state === "absent") {
        await runtime.create(botId, account(botId));
      }
      if (state !== "running") {
        await runtime.start(botId);
      }
      await applyEgress(botId);
    });
  }
  return {
    ...runtime,
    // In the same queue, so a use right after an idle stop starts the box again.
    stop: (botId) => serially(botId, () => runtime.stop(botId)),
    execAttach: async (botId, exec) => {
      await ready(botId);
      return runtime.execAttach(botId, exec);
    },
    cdp: async (botId) => {
      await ready(botId);
      return runtime.cdp(botId);
    },
    display: async (botId, lease) => {
      await ready(botId);
      return runtime.display(botId, lease);
    },
    control: async (botId, lease) => {
      await ready(botId);
      return runtime.control(botId, lease);
    },
    ready,
  };
}

// R16 makes a box two containers, so an idle one is stopped. Its volumes stay, and its next use
// starts it again.
export const boxQuietMs = 15 * 60_000;

export type BoxUse = { attached: number; lastUsedAt: number };

// Idle: nothing attached to the engine, and no byte through the sidecar's DevTools or an open
// display view, for `quietMs`.
export function idleBoxes(uses: ReadonlyMap<string, BoxUse>, now: number, quietMs: number) {
  return [...uses]
    .filter(([, use]) => use.attached === 0 && now - use.lastUsedAt >= quietMs)
    .map(([botId]) => botId);
}

export function stopIdleBoxes(
  runtime: BoxRuntime,
  { quietMs = boxQuietMs, everyMs = 60_000, now = Date.now } = {},
) {
  const uses = new Map<string, BoxUse>();
  function use(botId: string) {
    const entry = uses.get(botId) ?? { attached: 0, lastUsedAt: now() };
    uses.set(botId, entry);
    entry.lastUsedAt = now();
    return entry;
  }
  const timer = setInterval(() => {
    for (const botId of idleBoxes(uses, now(), quietMs)) {
      uses.delete(botId);
      runtime.stop(botId).catch((error: unknown) => {
        console.error(`beebotd: idle box ${botId} didn't stop: ${(error as Error)?.message}`);
      });
    }
  }, everyMs);
  timer.unref();
  return {
    runtime: {
      ...runtime,
      execAttach: async (botId, exec) => {
        use(botId).attached += 1;
        const release = () => {
          use(botId).attached -= 1;
        };
        try {
          const attach = await runtime.execAttach(botId, exec);
          void attach.exited.finally(release);
          return attach;
        } catch (error) {
          release();
          throw error;
        }
      },
    } satisfies BoxRuntime,
    touch: (botId: string) => {
      use(botId);
    },
    close: () => clearInterval(timer),
  };
}

// Idle stop counts DevTools bytes; this passes every one of them on to the caller.
function touching(stream: NodeStream.Duplex, touch: () => void) {
  const tapped = new NodeStream.Duplex({
    read: () => {
      stream.resume();
    },
    write: (chunk, encoding, done) => {
      touch();
      stream.write(chunk, encoding, done);
    },
    final: (done) => {
      stream.end(done);
    },
    destroy: (error, done) => {
      stream.destroy(error ?? undefined);
      done(error);
    },
  });
  stream.on("data", (chunk) => {
    touch();
    if (!tapped.push(chunk)) {
      stream.pause();
    }
  });
  stream.on("end", () => tapped.push(null));
  NodeStream.finished(stream, (error) => {
    if (error) {
      tapped.destroy(error);
    }
  });
  return tapped;
}

// Chromium's DevTools has no authentication, so the server reaches it only through boxd: every
// connection is a fresh attach on boxd's own channel, and nothing listens on the host.
export function sidecarEndpoint(
  runtime: BoxRuntime,
  botId: string,
  touch: (botId: string) => void = () => {},
): SidecarEndpoint {
  return {
    connect: async () => {
      touch(botId);
      return touching((await runtime.cdp(botId)).stream, () => touch(botId));
    },
    downloadsDir: "/downloads",
    collect: (file, name) => runtime.collect(botId, file, name),
  };
}

// The owner watching or driving counts as use, so an open display keeps the box up.
export async function displayView(
  runtime: BoxRuntime,
  botId: string,
  touch: (botId: string) => void = () => {},
  lease?: string,
) {
  touch(botId);
  const attach = await runtime.display(botId, lease);
  return { ...attach, stream: touching(attach.stream, () => touch(botId)) };
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
  const ready = readyBoxRuntime(recordingBoxRuntime(boxd.runtime, setBox), {
    account,
    applyEgress: egress.apply,
  });
  const idle = stopIdleBoxes(ready);
  return {
    runtime: idle.runtime,
    // Brings a box up ahead of its first turn.
    prepare: (botId: string) => {
      idle.touch(botId);
      return ready.ready(botId);
    },
    egress,
    applyEgress: egress.apply,
    sidecar: async (botId: string) => sidecarEndpoint(idle.runtime, botId, idle.touch),
    display: (botId: string, lease?: string) => displayView(idle.runtime, botId, idle.touch, lease),
    control: (botId: string, lease: string) => idle.runtime.control(botId, lease),
    stderr: boxd.stderr,
    closed: boxd.closed,
    close: async () => {
      idle.close();
      egress.close();
      await boxd.close();
    },
  };
}
