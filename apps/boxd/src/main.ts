import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { createBoxd } from "./boxd.ts";
import { noEgress } from "./egress.ts";
import { createPodman } from "./podman.ts";
import { parseRunSpec } from "./policy.ts";
import { type Bootstrap, type Hello, Kind, frameReader, jsonFrame } from "./protocol.ts";
import { setup } from "./setup.ts";

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
  return { secret, owner, prefix, labels: labels as Record<string, string> };
}

async function boot(bootstrap: Bootstrap) {
  // The image's own policy files are installed next to boxd, inside the Linux host.
  const dir = NodePath.dirname(NodePath.resolve(process.argv[1] ?? "."));
  const runSpec = parseRunSpec(NodeFs.readFileSync(NodePath.join(dir, "runSpec.json"), "utf8"));
  const seccomp = NodePath.join(dir, "seccomp-chromium.json");
  if (!NodeFs.existsSync(seccomp)) {
    throw new Error("seccomp-chromium.json is missing");
  }
  const podman = createPodman();
  const result = await setup(podman, runSpec.engine);
  process.stderr.write(`boxd: setup ${JSON.stringify(result)}\n`);
  const egress = noEgress;
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
    send,
  });
  await boxd.reapOrphans();
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
        hello({ fatal: error instanceof Error ? error.message : String(error) });
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
