import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { createFakePodman, serveInProcess } from "@beebot/boxd/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { connectBoxd, launchBoxd } from "./boxdRuntime.ts";

const node = (script: string) => ({
  argv: [process.execPath, "-e", script],
  env: { PATH: process.env.PATH ?? "" },
});

async function read(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return String(Buffer.concat(chunks));
}

describe("boxd adapter", () => {
  async function connect() {
    const fake = createFakePodman();
    const transport = serveInProcess(fake.podman);
    const { runtime, closed } = await connectBoxd(transport, {
      secret: Buffer.alloc(32, 1),
      owner: "env-1",
    });
    return { runtime, closed, transport, fake };
  }

  it("runs the box lifecycle through boxd", async () => {
    const { runtime } = await connect();
    expect(await runtime.snapshot("bot-1")).toBe("absent");
    await runtime.create("bot-1");
    await expect(runtime.execAttach("bot-1", node(""))).rejects.toThrow("stopped");
    await runtime.start("bot-1");
    expect(await runtime.snapshot("bot-1")).toBe("running");
    await runtime.stop("bot-1");
    expect(await runtime.snapshot("bot-1")).toBe("stopped");
    await expect(runtime.create("Bad/Id")).rejects.toThrow("bad box token");
  });

  it("streams stdin and stdout", async () => {
    const { runtime } = await connect();
    await runtime.create("bot-1");
    await runtime.start("bot-1");
    const { stream, exited } = await runtime.execAttach(
      "bot-1",
      node("process.stdin.pipe(process.stdout)"),
    );
    stream.end("hello");
    expect(await read(stream)).toBe("hello");
    expect(await exited).toBe(0);
  });

  it("kills the process when the stream drops", async () => {
    const { runtime } = await connect();
    await runtime.create("bot-1");
    await runtime.start("bot-1");
    const { stream, exited } = await runtime.execAttach(
      "bot-1",
      node("setInterval(() => {}, 1000)"),
    );
    stream.destroy();
    expect(await exited).not.toBe(0);
  });

  it("ends every attach when boxd goes away", async () => {
    const { runtime, transport, closed } = await connect();
    await runtime.create("bot-1");
    await runtime.start("bot-1");
    const { stream, exited } = await runtime.execAttach(
      "bot-1",
      node("setInterval(() => {}, 1000)"),
    );
    transport.destroy();
    await closed;
    expect(await exited).toBeNull();
    expect(stream.destroyed).toBe(true);
    await expect(runtime.snapshot("bot-1")).rejects.toThrow("connection lost");
  });
});

// Real containers in the beebot-dev Podman machine. Skips where it is not running.
const podman = "C:\\Program Files\\RedHat\\Podman\\podman.exe";
const machine = "beebot-dev";
const baseImage = "localhost/beebot-dev-alpine:3.20";
const testImage = "localhost/beebot-dev-ws2-box:test";

function sh(script: string) {
  return new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = NodeChildProcess.spawn(podman, ["machine", "ssh", machine, "bash -s"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
    child.on("error", () => resolve({ code: null, stdout }));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(script);
  });
}

const available =
  process.platform === "win32" &&
  NodeFs.existsSync(podman) &&
  (await sh(`podman image exists ${baseImage} && echo yes`)).stdout.includes("yes");

describe.skipIf(!available)("boxd in the beebot-dev machine", () => {
  const botId = `it-${NodeCrypto.randomBytes(4).toString("hex")}`;
  const prefix = "beebot-dev-ws2";
  const base = `${prefix}-${botId}`;
  const engine = `${base}-engine`;
  const browser = `${base}-browser`;
  const networks = [`${base}-engine-net`, `${base}-browser-net`];
  const volumes = [`${base}-engine-home`, `${base}-browser-profile`];
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "boxd-it-"));
  let boxd: Awaited<ReturnType<typeof launchBoxd>>;

  const inspect = async (kind: string, name: string) =>
    JSON.parse((await sh(`podman ${kind} inspect ${name}`)).stdout)[0];
  const run = async (argv: string[], stdin = "") => {
    const { stream, exited } = await boxd.runtime.execAttach(botId, { argv, env: {} });
    stream.end(stdin);
    const output = await read(stream);
    return { output, code: await exited };
  };

  beforeAll(async () => {
    const build = await sh(
      [
        `podman build -q -t ${testImage} --label beebot-dev=1 -f - <<'EOF'`,
        `FROM ${baseImage}`,
        // A read-only root needs every mount point to exist in the image.
        "RUN adduser -D -u 10001 box && mkdir /home/browser && chown 10001:10001 /home/browser",
        "USER 10001:10001",
        "EOF",
      ].join("\n"),
    );
    expect(build.code).toBe(0);
    const box = { image: testImage, user: "10001:10001", command: ["sleep", "infinity"] };
    const runSpec = NodePath.join(dir, "runSpec.json");
    NodeFs.writeFileSync(
      runSpec,
      JSON.stringify({
        engine: { ...box, home: "/home/box" },
        browser: { ...box, home: "/home/browser" },
      }),
    );
    const boxdSrc = NodePath.resolve(import.meta.dirname, "../../boxd/src");
    const sources = NodeFs.readdirSync(boxdSrc)
      .filter(
        (file) =>
          file.endsWith(".ts") &&
          !file.endsWith(".test.ts") &&
          !["testing.ts", "install.ts"].includes(file),
      )
      .sort((a, b) => Number(b === "main.ts") - Number(a === "main.ts"))
      .map((file) => NodePath.join(boxdSrc, file));
    const shipped = NodePath.resolve(
      import.meta.dirname,
      "../../../images/box/seccomp-chromium.json",
    );
    const seccomp = NodeFs.existsSync(shipped)
      ? shipped
      : NodePath.resolve(import.meta.dirname, "../../boxd/fixtures/seccomp-chromium.json");
    boxd = await launchBoxd({
      host: { kind: "podman-machine", podman, machine },
      installDir: "beebot-dev-ws2/boxd",
      files: { boxd: sources, runSpec, seccomp },
      bootstrap: {
        secret: NodeCrypto.randomBytes(32),
        owner: prefix,
        prefix,
        labels: { "beebot-dev": "1" },
      },
    });
  }, 300_000);

  afterAll(async () => {
    await boxd?.close();
    await sh(
      [
        `podman rm -f -t 0 ${engine} ${browser}`,
        `podman network rm ${networks.join(" ")}`,
        `podman volume rm ${volumes.join(" ")}`,
      ].join("\n"),
    );
    NodeFs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("applied the cgroup fix idempotently and verified limits before serving", () => {
    expect(boxd.stderr()).toContain('"bootstrapChanged":false');
  });

  it("creates and starts a locked-down engine and sidecar", async () => {
    await boxd.runtime.create(botId);
    expect(await boxd.runtime.snapshot(botId)).toBe("stopped");
    await boxd.runtime.start(botId);
    expect(await boxd.runtime.snapshot(botId)).toBe("running");

    for (const name of [engine, browser]) {
      const { Config, HostConfig } = await inspect("container", name);
      expect(Config.User).toBe("10001:10001");
      expect(HostConfig.ReadonlyRootfs).toBe(true);
      expect(HostConfig.SecurityOpt).toContain("no-new-privileges");
      expect(HostConfig.CapDrop).toEqual(
        expect.arrayContaining(["CAP_CHOWN", "CAP_SETUID", "CAP_SYS_CHROOT"]),
      );
      expect(HostConfig.Memory).toBeGreaterThan(0);
      expect(HostConfig.MemorySwap).toBe(HostConfig.Memory);
      expect(HostConfig.NanoCpus).toBeGreaterThan(0);
      expect(HostConfig.PidsLimit).toBeGreaterThan(0);
    }
    const sidecar = await inspect("container", browser);
    expect(sidecar.Config.Hostname).toBe("browser");
    expect(sidecar.HostConfig.SecurityOpt.join(" ")).toContain("seccomp-chromium.json");
    expect(JSON.stringify(sidecar.Mounts)).not.toContain(volumes[0]);
    expect(JSON.stringify((await inspect("container", engine)).Mounts)).not.toContain(volumes[1]);
    for (const name of networks) {
      const network = await inspect("network", name);
      expect(network.options?.isolate).toBe("true");
      expect(network.internal).toBe(true);
    }

    const status = await run([
      "sh",
      "-c",
      "id -u; grep -E '^(CapEff|CapBnd|NoNewPrivs)' /proc/self/status; touch /etc/x 2>&1; cat /sys/fs/cgroup/memory.max",
    ]);
    expect(status.output).toMatch(
      /^10001\nCapEff:\s+0+\nCapBnd:\s+0+\nNoNewPrivs:\s+1\n.*Read-only file system\n2147483648\n$/,
    );
  }, 120_000);

  it("gives the engine no route to the sidecar", async () => {
    const sidecarIp = Object.values<{ IPAddress?: string }>(
      (await inspect("container", browser)).NetworkSettings.Networks,
    )[0]?.IPAddress;
    expect(sidecarIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const probe = await run([
      "sh",
      "-c",
      `ip route; wget -T 2 -q -O- http://${sidecarIp}:9222/ 2>&1; echo "exit $?"`,
    ]);
    expect(probe.output).not.toContain("default");
    expect(probe.output).toMatch(/unreachable/i);
  }, 60_000);

  it("streams an exec and kills it when the attach drops", async () => {
    expect((await run(["cat"], "over stdin")).output).toBe("over stdin");
    const { stream, exited } = await boxd.runtime.execAttach(botId, {
      argv: ["sh", "-c", "sleep 4242"],
      env: {},
    });
    stream.destroy();
    expect(await exited).not.toBe(0);
    await expect
      .poll(
        async () => (await sh(`podman exec ${engine} ps -o args`)).stdout.includes("sleep 4242"),
        {
          timeout: 10_000,
        },
      )
      .toBe(false);
    await boxd.runtime.stop(botId);
    expect(await boxd.runtime.snapshot(botId)).toBe("stopped");
  }, 60_000);
});
