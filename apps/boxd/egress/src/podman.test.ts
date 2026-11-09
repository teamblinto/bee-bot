import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { createRequire } from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

// Real containers on the shared `beebot-dev` Podman machine. Everything created here is named
// `beebot-dev-ws3-*`, labelled `beebot-dev=1`, and removed by the ID it was given.
const podman =
  process.platform === "win32" ? "C:\\Program Files\\RedHat\\Podman\\podman.exe" : "podman";
const available =
  NodeChildProcess.spawnSync(podman, ["info", "--format", "{{.Host.Arch}}"], {
    timeout: 30_000,
    windowsHide: true,
  }).status === 0;

const packageDir = NodePath.resolve(import.meta.dirname, "..");
const tag = NodeCrypto.randomBytes(3).toString("hex");
const runId = `beebot-dev-ws3-${tag}`;
const name = (what: string) => `${runId}-${what}`;
const label = ["--label", "beebot-dev=1"];
const canary = `sk-ant-canary-${NodeCrypto.randomUUID()}`;
const canarySha = NodeCrypto.createHash("sha256").update(canary).digest("hex");

const created: { kind: "container" | "network" | "image"; id: string }[] = [];
const children: NodeChildProcess.ChildProcess[] = [];

function run(args: string[], input?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.spawn(podman, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`podman ${args[0]}: ${err.trim()}`)),
    );
    child.stdin.end(input);
  });
}

async function create(kind: "container" | "network", args: string[]) {
  const id = await run(args);
  created.push({ kind, id });
  return id;
}

// A long-lived podman child whose stdin we hold, with its stdout collected line by line.
function hold(args: string[]) {
  const child = NodeChildProcess.spawn(podman, args, { windowsHide: true });
  children.push(child);
  const lines: string[] = [];
  let errors = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    errors += chunk;
  });
  let buffered = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    lines.push(...parts);
  });
  const until = async (done: (lines: string[]) => boolean, ms = 60_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (done(lines)) {
        return;
      }
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error(`gave up waiting; got ${lines.join(" | ")}; stderr ${errors}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  return { child, lines, until };
}

function bundle(outDir: string) {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("vite-plus/package.json");
  const { bin } = JSON.parse(NodeFS.readFileSync(manifest, "utf8")) as {
    bin: string | Record<string, string>;
  };
  const entry = typeof bin === "string" ? bin : (bin.vp ?? "");
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(NodePath.dirname(manifest), entry), "pack", "--out-dir", outDir],
    { cwd: packageDir, encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`vp pack failed: ${result.stderr}`);
  }
}

const subnetOf = async (network: string) =>
  (await run(["network", "inspect", network, "--format", "{{range .Subnets}}{{.Subnet}}{{end}}"]))
    .split("/")[0]
    ?.replace(/\.0$/, "") ?? "";

// Everything still named for this run, tracked or not: a step that failed between creating a
// resource and recording its ID must not leak it.
async function leftovers() {
  const lists = await Promise.all([
    run(["ps", "-a", "--format", "{{.ID}} {{.Names}}"]),
    run(["network", "ls", "--format", "{{.ID}} {{.Name}}"]),
    run(["images", "--format", "{{.ID}} {{.Repository}}"]),
  ]);
  const [containers = [], networks = [], images = []] = lists.map((list) =>
    list
      .split("\n")
      .map((line) => line.split(" "))
      .filter(([, item = ""]) => item.replace(/^localhost\//, "").startsWith(`${runId}-`))
      .map(([id = ""]) => id),
  );
  return [
    ...containers.map((id) => ({ kind: "container" as const, id })),
    ...networks.map((id) => ({ kind: "network" as const, id })),
    ...images.map((id) => ({ kind: "image" as const, id })),
  ];
}

// The proxy's own `--rm` teardown can still hold the networks when `rm -f` returns, so each removal
// is retried, and anything left behind fails the run instead of leaking on the shared machine.
afterAll(async () => {
  if (!available) {
    return;
  }
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.stdin?.end();
      const exited = new Promise((resolve) => child.once("close", resolve));
      const timer = setTimeout(() => child.kill(), 20_000);
      await exited;
      clearTimeout(timer);
    }),
  );
  const remove = async (items: typeof created) => {
    for (const { kind, id } of items) {
      const args =
        kind === "container"
          ? ["rm", "-f", "-i", "-t", "0", id]
          : kind === "network"
            ? ["network", "rm", "-f", id]
            : ["rmi", "-f", "-i", id];
      let removed = false;
      for (let attempt = 0; attempt < 10 && !removed; attempt += 1) {
        removed = await run(args).then(
          () => true,
          () => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
        );
      }
    }
  };
  await remove(created.reverse());
  await remove(await leftovers());
  expect(await leftovers()).toEqual([]);
}, 180_000);

describe.skipIf(!available)("egress proxy in the beebot-dev Podman machine", () => {
  it("keeps a box to its allowlist, answers its DNS, and puts the key only on the vendor lane", async () => {
    const context = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "beebot-ws3-"));
    try {
      bundle(context);
      for (const fixture of ["probe.mjs", "recorder.mjs"]) {
        NodeFS.copyFileSync(
          NodePath.join(packageDir, "fixtures", fixture),
          NodePath.join(context, fixture),
        );
      }
      NodeFS.writeFileSync(
        NodePath.join(context, "Containerfile"),
        [
          "FROM docker.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
          "LABEL beebot-dev=1",
          "RUN apk add --no-cache nodejs",
          "COPY egress.mjs probe.mjs recorder.mjs /app/",
        ].join("\n"),
      );
      await run(["build", "-q", ...label, "-t", `localhost/${name("egress")}:test`, context]);
      created.push({
        kind: "image",
        id: await run([
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          `localhost/${name("egress")}:test`,
        ]),
      });
    } finally {
      NodeFS.rmSync(context, { recursive: true, force: true });
    }
    const image = `localhost/${name("egress")}:test`;

    const int = name("int");
    const up = name("up");
    await create("network", [
      "network",
      "create",
      ...label,
      "--internal",
      "--disable-dns",
      "--opt",
      "isolate=true",
      int,
    ]);
    await create("network", [
      "network",
      "create",
      ...label,
      "--disable-dns",
      "--opt",
      "isolate=true",
      up,
    ]);
    const intNet = await subnetOf(int);
    const proxyIp = `${intNet}.2`;
    const boxIp = `${intNet}.10`;

    const hardened = ["--cap-drop=all", "--security-opt", "no-new-privileges", "--read-only"];
    const startRecorder = async (what: string) => {
      const id = await create("container", [
        "run",
        "-d",
        "--name",
        name(what),
        ...label,
        ...hardened,
        "--user",
        "10003:10003",
        "--network",
        up,
        "-e",
        `EXPECT_KEY_SHA=${canarySha}`,
        image,
        "node",
        "/app/recorder.mjs",
      ]);
      const ip = await run([
        "inspect",
        id,
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      ]);
      return { id, ip };
    };
    const vendor = await startRecorder("vendor");
    const attacker = await startRecorder("attacker");

    // The start contract: config on stdin, stdin held open, `ready` on stdout.
    const egressName = name("proxy");
    const egress = hold([
      "run",
      "--rm",
      "-i",
      "--name",
      egressName,
      ...label,
      ...hardened,
      "--user",
      "10002:10002",
      "--tmpfs",
      "/run/egress:rw,mode=0700,U",
      "--sysctl",
      "net.ipv4.ip_unprivileged_port_start=53",
      "--network",
      `${int}:ip=${proxyIp}`,
      "--network",
      up,
      image,
      "node",
      "/app/egress.mjs",
    ]);
    egress.child.stdin?.write(
      `${JSON.stringify({
        listen: [proxyIp],
        dnsPort: 53,
        proxyPort: 3128,
        apiPort: 8080,
        control: "/run/egress/control.sock",
        testUpstreams: { anthropic: `http://${vendor.ip}:9000` },
      })}\n`,
    );
    created.push({ kind: "container", id: egressName });
    await egress.until((lines) => lines.some((line) => line.includes('"ready"')));

    const relay = hold([
      "exec",
      "-i",
      egressName,
      "node",
      "-e",
      "const s=require('net').connect('/run/egress/control.sock');process.stdin.pipe(s).pipe(process.stdout)",
    ]);
    relay.child.stdin?.write(`${JSON.stringify({ type: "bind", address: boxIp, botId: "b1" })}\n`);
    relay.child.stdin?.write(
      `${JSON.stringify({
        type: "policy",
        botId: "b1",
        hosts: ["api.anthropic.com", "example.com", "localtest.me"],
        subscription: null,
        api: { vendor: "anthropic", key: canary },
      })}\n`,
    );
    await relay.until((lines) => lines.filter((line) => line === '{"ok":true}').length === 2);

    let probes = 0;
    const probe = async () =>
      JSON.parse(
        await run([
          "run",
          "--rm",
          "--name",
          name(`probe-${(probes += 1)}`),
          ...label,
          ...hardened,
          "--user",
          "10001:10001",
          "--network",
          `${int}:ip=${boxIp}`,
          "--dns",
          proxyIp,
          image,
          "node",
          "/app/probe.mjs",
          proxyIp,
          attacker.ip,
        ]),
      ) as Record<string, unknown>;

    const before = await probe();
    expect(before).toMatchObject({
      dnsAllowed: [proxyIp],
      dnsOther: "error ENOTFOUND",
      dnsExfil: "error ENOTFOUND",
      connectAllowed: "HTTP/1.1 200 Connection Established",
      connectGithub: "HTTP/1.1 403 Forbidden",
      connectVendor: "HTTP/1.1 403 Forbidden",
      connectLoopbackName: "HTTP/1.1 403 Forbidden",
      connectAttacker: "HTTP/1.1 403 Forbidden",
      connectPort: "HTTP/1.1 403 Forbidden",
      plainHttp: 403,
      apiLane: 200,
      apiEscape: 400,
      apiOtherVendor: 403,
    });
    for (const check of ["directPublic", "directDns", "directAttacker"]) {
      expect(String(before[check]), check).toMatch(/^(error E(NETUNREACH|HOSTUNREACH)|timeout)$/);
    }

    // Fail closed: the control channel goes away, and with it every policy and the key.
    relay.child.stdin?.end();
    await egress.until((lines) => lines.some((line) => line.includes("control connection closed")));
    const after = await probe();
    expect(after).toMatchObject({
      dnsAllowed: "error ENOTFOUND",
      connectAllowed: "HTTP/1.1 403 Forbidden",
      apiLane: 403,
    });

    const vendorSeen = (await run(["logs", vendor.id]))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(vendorSeen).toEqual([
      { url: "/v1/messages", host: "api.anthropic.com", keyMatches: true, hasKey: true },
    ]);
    expect(await run(["logs", attacker.id])).toBe("");
    expect(egress.lines.join("\n")).not.toContain(canary);
    expect(egress.lines.join("\n")).toContain('"decision":"deny"');
  }, 600_000);
});
