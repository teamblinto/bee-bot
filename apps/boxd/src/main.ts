import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { createBoxd } from "./boxd.ts";
import { createPodmanEgress } from "./egress.ts";
import { createPodman } from "./podman.ts";
import { ownUserns, parseRunSpec } from "./policy.ts";
import { type Bootstrap, type Hello, Kind, frameReader, jsonFrame } from "./protocol.ts";
import { becomeOnlyBoxd } from "./instance.ts";
import { MachineRestartNeeded, setup } from "./setup.ts";

// stdout carries frames only; anything else goes to stderr.
const send = (data: Buffer) => process.stdout.write(data);
const hello = (message: Hello) => send(jsonFrame(message));

function parseBootstrap(payload: Buffer): Bootstrap {
  const value: unknown = JSON.parse(String(payload));
  const get = (key: string) =>
    value && typeof value === "object" ? Reflect.get(value, key) : undefined;
  const secret = get("secret");
  const owner = get("owner");
  const prefix = get("prefix");
  const labels = get("labels");
  const testUpstreams = get("testUpstreams");
  if (typeof secret !== "string" || Buffer.from(secret, "base64").length < 32) {
    throw new Error("bootstrap secret must be at least 32 bytes");
  }
  if (typeof owner !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(owner)) {
    throw new Error("bad bootstrap owner");
  }
  if (typeof prefix !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(prefix)) {
    throw new Error("bad bootstrap prefix");
  }
  if (
    labels === null ||
    typeof labels !== "object" ||
    !Object.entries(labels).every(
      ([key, item]) =>
        /^[a-z0-9.-]+$/.test(key) &&
        !key.startsWith("beebot.") &&
        typeof item === "string" &&
        /^[A-Za-z0-9._-]*$/.test(item),
    )
  ) {
    throw new Error("bad bootstrap labels");
  }
  if (
    testUpstreams !== undefined &&
    (testUpstreams === null ||
      typeof testUpstreams !== "object" ||
      !Object.values(testUpstreams).every((url) => typeof url === "string"))
  ) {
    throw new Error("bad bootstrap testUpstreams");
  }
  return {
    secret,
    owner,
    prefix,
    labels: labels as Record<string, string>,
    ...(testUpstreams !== undefined && {
      testUpstreams: testUpstreams as Record<string, string>,
    }),
  };
}

async function boot(bootstrap: Bootstrap) {
  // The image's own policy files are installed next to boxd, inside the Linux host.
  const dir = NodePath.dirname(NodePath.resolve(process.argv[1] ?? "."));
  await becomeOnlyBoxd(NodePath.join(dir, "boxd.pid"));
  const runSpec = parseRunSpec(NodeFs.readFileSync(NodePath.join(dir, "runSpec.json"), "utf8"));
  const seccomp = NodePath.join(dir, "seccomp-chromium.json");
  if (!NodeFs.existsSync(seccomp)) {
    throw new Error("seccomp-chromium.json is missing");
  }
  // beebotd's server mode starts boxd beside it on the host, and boxd inherits its environment.
  const native = process.env.BEEBOT_SERVER_MODE === "1";
  const podman = createPodman();
  const result = await setup(podman, runSpec.engine, undefined, native);
  process.stderr.write(`boxd: setup ${JSON.stringify(result)}\n`);
  // beebotd's endpoints reach the egress proxy through this socket; only that container mounts it.
  // The proxy runs as another uid, so the socket is open to all, but no other user on this host can
  // get past the 0700 directory above it: the container mounts the inner one directly.
  const relayParent = NodePath.join(dir, "relay");
  const relayDir = NodePath.join(relayParent, "proxy");
  NodeFs.mkdirSync(relayDir, { recursive: true });
  NodeFs.chmodSync(relayParent, 0o700);
  NodeFs.chmodSync(relayDir, 0o755);
  NodeFs.rmSync(NodePath.join(relayDir, "bee.sock"), { force: true });
  // No proxy, no boxes: boxd never serves without one.
  const script = NodePath.join(dir, "egress.mjs");
  if (!NodeFs.existsSync(script)) {
    throw new Error("egress.mjs is missing");
  }
  // A Podman machine gets its own Node installed beside boxd; a native host's boxd runs on the
  // host's Node, so the proxy uses the image's.
  const nodeDir = NodePath.join(dir, "node");
  const egress = createPodmanEgress({
    podman,
    prefix: bootstrap.prefix,
    owner: bootstrap.owner,
    labels: bootstrap.labels,
    image: runSpec.engine.image,
    nodeDir: NodeFs.existsSync(nodeDir) ? nodeDir : null,
    userns: native ? ownUserns(runSpec.engine) : null,
    script,
    relayDir,
    testUpstreams: bootstrap.testUpstreams,
    log: (line) => process.stderr.write(`${line}\n`),
    onExit: () => {
      process.stderr.write("boxd: the egress proxy went away\n");
      process.exit(1);
    },
  });
  await egress.start();
  const boxd = createBoxd({
    podman,
    egress,
    secret: Buffer.from(bootstrap.secret, "base64"),
    owner: bootstrap.owner,
    prefix: bootstrap.prefix,
    labels: bootstrap.labels,
    runSpec,
    seccomp,
    stateDir: NodePath.join(dir, "state"),
    send,
    native,
  });
  await boxd.reapOrphans();
  await boxd.rebind();
  const relay = NodeNet.createServer((socket) => boxd.relay(socket));
  await new Promise<void>((resolve) => relay.listen(NodePath.join(relayDir, "bee.sock"), resolve));
  NodeFs.chmodSync(NodePath.join(relayDir, "bee.sock"), 0o666);
  return boxd;
}

let boxd: ReturnType<typeof createBoxd> | null = null;
let booting = false;
const early: [number, Kind, Buffer][] = [];

const read = frameReader((channel, kind, payload) => {
  if (boxd !== null) {
    boxd.onFrame(channel, kind, payload);
    return;
  }
  if (booting) {
    early.push([channel, kind, Buffer.from(payload)]);
    return;
  }
  booting = true;
  Promise.resolve(payload)
    .then((bootstrap) => boot(parseBootstrap(bootstrap)))
    .then(
      (ready) => {
        boxd = ready;
        hello({ ready: true });
        for (const [queuedChannel, queuedKind, queuedPayload] of early.splice(0)) {
          ready.onFrame(queuedChannel, queuedKind, queuedPayload);
        }
      },
      (error: unknown) => {
        hello({
          fatal: error instanceof Error ? error.message : String(error),
          ...(error instanceof MachineRestartNeeded && { restartMachine: true }),
        });
        process.exitCode = 1;
        process.stdin.destroy();
      },
    );
});

process.stdin.on("data", (chunk: Buffer) => {
  try {
    read(chunk);
  } catch (error) {
    process.stderr.write(`boxd: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stdin.destroy();
  }
});
process.stdin.on("close", () => {
  void (boxd?.close() ?? Promise.resolve()).finally(() => process.exit());
});
