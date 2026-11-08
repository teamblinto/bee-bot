import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import { once } from "node:events";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import { createRequire } from "node:module";
import type * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { boxLayout } from "./boxEngine.ts";
import { boxdFiles, boxdSecret, readyBoxRuntime, startBoxHost, windowsPodman } from "./boxHost.ts";
import { createFakeBoxRuntime } from "./boxRuntime.ts";
import { createCdpBrowserRuntime, fetchJson } from "./browserCdp.ts";
import { podmanEnv } from "./boxdRuntime.ts";
import { apiKeyName, createMemoryVault } from "./vault.ts";

describe("box host", () => {
  it("keeps boxd's secret across restarts", async () => {
    const vault = createMemoryVault();
    const first = await boxdSecret(vault);
    expect(first).toHaveLength(32);
    expect(await boxdSecret(vault)).toEqual(first);
  });

  it("brings a box up once, then pushes its egress policy before every attach", async () => {
    const fake = createFakeBoxRuntime();
    const created: (string | undefined)[] = [];
    const applied: string[] = [];
    const runtime = readyBoxRuntime(
      {
        ...fake,
        create: async (botId, account) => {
          created.push(account);
          await fake.create(botId, account);
        },
      },
      {
        account: () => "claude",
        applyEgress: async (botId) => {
          applied.push(botId);
        },
      },
    );
    const exec = { argv: [process.execPath, "-e", ""], env: {} };
    await Promise.all([runtime.execAttach("bot-1", exec), runtime.execAttach("bot-1", exec)]);
    await runtime.stop("bot-1");
    const { exited } = await runtime.execAttach("bot-1", exec);
    expect(await exited).toBe(0);
    expect(created).toEqual(["claude"]);
    expect(applied).toEqual(["bot-1", "bot-1", "bot-1"]);
  });
});

// The whole path on the real beebot-dev machine: boxd, the egress proxy and both containers.
// Everything is named and labelled for this run and removed by ID afterwards.
const machine = "beebot-dev";
const repo = NodePath.resolve(import.meta.dirname, "../../..");

function sh(script: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = NodeChildProcess.spawn(windowsPodman, ["machine", "ssh", machine, "bash -s"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: podmanEnv(),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
    child.on("error", () => resolve({ code: null, stdout, stderr }));
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
    child.stdin.end(script);
  });
}

const available =
  process.platform === "win32" &&
  NodeFs.existsSync(windowsPodman) &&
  (await sh("podman info --format '{{.Host.Arch}}' >/dev/null && echo yes")).stdout === "yes";

// Every socket listening on Windows for this process or anything it started, boxd's podman and
// ssh among them.
function hostListeners() {
  const script = [
    "$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)",
    `$ids = @{ [uint32]${process.pid} = $true }`,
    "do { $added = $false; foreach ($p in $all) {",
    "  if ($ids.ContainsKey([uint32]$p.ParentProcessId) -and -not $ids.ContainsKey([uint32]$p.ProcessId)) { $ids[[uint32]$p.ProcessId] = $true; $added = $true }",
    "} } while ($added)",
    'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids.ContainsKey([uint32]$_.OwningProcess) } | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" }',
  ].join("\n");
  const result = NodeChildProcess.spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { encoding: "utf8", windowsHide: true },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split(/\r?\n/).filter(Boolean).sort();
}

// Lists every NUL file left where podman ran: the MSYS ssh writes one for UserKnownHostsFile=NUL.
const nulFiles = () =>
  [process.cwd(), repo, import.meta.dirname].filter((dir) =>
    NodeFs.readdirSync(dir).includes("NUL"),
  );

describe.skipIf(!available)("boxes on the beebot-dev machine", () => {
  const tag = NodeCrypto.randomBytes(3).toString("hex");
  const prefix = `beebot-dev-inta-${tag}`;
  const botId = "e2e";
  const image = `localhost/beebot-dev-inta-box:${tag}`;
  const installDir = `beebot-dev-inta-${tag}/boxd`;
  const canary = `sk-ant-canary-${NodeCrypto.randomUUID()}`;
  const canarySha = NodeCrypto.createHash("sha256").update(canary).digest("hex");
  const temp = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "beebot-inta-"));
  const layout = boxLayout(temp);
  const nulBefore = nulFiles();
  let mockIp = "";
  let boxes: Awaited<ReturnType<typeof startBoxHost>> | undefined;
  let beebotd: NodeHttp.Server;
  let listenersBefore: string[] = [];
  // boxd's own sockets in the machine; its egress proxy listens only inside its container.
  const boxdListeners = async () =>
    sh(
      `pids=$(pgrep -f '${installDir}/main.ts'); [ -n "$pids" ] || echo 'no boxd'; for p in $pids; do ss -Hltunp | grep "pid=$p,"; done; true`,
    );
  const seenByBeebotd: { url: string; authorization: string | undefined }[] = [];

  const started = () => {
    if (boxes === undefined) {
      throw new Error("boxes did not start");
    }
    return boxes;
  };
  const inBox = async (script: string) => {
    const { stream, exited } = await started().runtime.execAttach(botId, {
      argv: ["bash", "-c", script],
      env: layout.env,
      cwd: layout.workdir,
    });
    stream.end();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    return { output: String(Buffer.concat(chunks)).trim(), code: await exited };
  };
  const inspect = async (name: string) =>
    JSON.parse((await sh(`podman inspect ${name}`)).stdout)[0];

  beforeAll(async () => {
    const build = NodeChildProcess.spawnSync(
      windowsPodman,
      ["build", "-q", "--label", "beebot-dev=1", "-t", image, NodePath.join(repo, "images/box")],
      { encoding: "utf8", env: podmanEnv(), windowsHide: true },
    );
    expect(build.status, build.stderr).toBe(0);

    // egress.mjs as `pnpm build` makes it.
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("vite-plus/package.json");
    const { bin } = JSON.parse(NodeFs.readFileSync(manifest, "utf8")) as {
      bin: string | Record<string, string>;
    };
    const vp = NodePath.join(
      NodePath.dirname(manifest),
      typeof bin === "string" ? bin : (bin.vp ?? ""),
    );
    const pack = NodeChildProcess.spawnSync(
      process.execPath,
      [vp, "pack", "--out-dir", NodePath.join(temp, "egress")],
      { cwd: NodePath.join(repo, "apps/boxd/egress"), encoding: "utf8", windowsHide: true },
    );
    expect(pack.status, pack.stderr).toBe(0);
    const runSpec = NodePath.join(temp, "runSpec.json");
    const spec = JSON.parse(
      NodeFs.readFileSync(NodePath.join(repo, "images/box/runSpec.json"), "utf8"),
    );
    NodeFs.writeFileSync(runSpec, JSON.stringify({ ...spec, image }));

    // The vendor stand-in on the proxy's upstream network answers with a hash of the key it got.
    const respond = [
      'key=""',
      "while IFS= read -r line; do line=${line%$'\\r'}; [ -z \"$line\" ] && break",
      '  case "${line,,}" in x-api-key:*) key=${line#*: };; esac; done',
      'body=$(printf %s "$key" | sha256sum | cut -c1-64)',
      "printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 64\\r\\nConnection: close\\r\\n\\r\\n%s' \"$body\"",
    ].join("\n");
    const dir = `$HOME/beebot-dev-inta-${tag}`;
    const mock = await sh(
      [
        "set -e",
        `mkdir -p ${dir}`,
        `cat > ${dir}/respond.sh <<'BEEBOT_EOF'`,
        respond,
        "BEEBOT_EOF",
        `podman network create --disable-dns --opt isolate=true --label beebot-dev=1 --label beebot.owner=${prefix} ${prefix}-egress-up >/dev/null`,
        `podman run -d --name ${prefix}-vendor --label beebot-dev=1 --label beebot.owner=${prefix} --user 10001:10001 --cap-drop=all --network ${prefix}-egress-up -v ${dir}/respond.sh:/respond.sh:ro ${image} socat TCP-LISTEN:9000,fork,reuseaddr 'SYSTEM:bash /respond.sh' >/dev/null`,
        `podman inspect ${prefix}-vendor --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`,
      ].join("\n"),
    );
    expect(mock.code, mock.stderr).toBe(0);
    mockIp = mock.stdout.split("\n").at(-1) ?? "";

    beebotd = NodeHttp.createServer((request, response) => {
      seenByBeebotd.push({ url: request.url ?? "", authorization: request.headers.authorization });
      response.end("bee-ok");
    });
    beebotd.listen(0, "127.0.0.1");
    await once(beebotd, "listening");
    listenersBefore = hostListeners();

    const vault = createMemoryVault();
    await vault.put(apiKeyName("claude"), canary);
    const files = boxdFiles(repo, NodePath.join(temp, "egress", "egress.mjs"));
    boxes = await startBoxHost({
      host: { kind: "podman-machine", podman: windowsPodman, machine },
      installDir,
      owner: prefix,
      vault,
      account: () => "claude",
      egressInput: () => ({ engineAccountId: "claude", lane: "api_key", hosts: [] }),
      beebotdPort: () => (beebotd.address() as NodeNet.AddressInfo).port,
      setBox: () => {},
      bootstrap: {
        prefix,
        labels: { "beebot-dev": "1" },
        testUpstreams: { anthropic: `http://${mockIp}:9000` },
      },
      files: { ...files, runSpec },
    });
  }, 900_000);

  afterAll(async () => {
    await boxes?.close();
    beebotd?.close();
    // Collected by this run's owner label, then removed by ID.
    const filter = `--filter label=beebot.owner=${prefix}`;
    const ids = async (list: string) =>
      (await sh(`${list} ${filter}`)).stdout.split("\n").filter(Boolean).join(" ");
    const containers = await ids("podman ps -a --format '{{.ID}}'");
    if (containers !== "") {
      await sh(`podman rm -f -t 0 ${containers}`);
    }
    const volumes = await ids("podman volume ls -q");
    if (volumes !== "") {
      await sh(`podman volume rm -f ${volumes}`);
    }
    const networks = await ids("podman network ls --format '{{.ID}}'");
    if (networks !== "") {
      await sh(`podman network rm -f ${networks}`);
    }
    // The credential directory belongs to the box user, so only the user namespace can remove it.
    await sh(
      `podman rmi ${image} >/dev/null; podman unshare rm -rf "$HOME/beebot-dev-inta-${tag}"`,
    );
    expect((await sh(`ls -d "$HOME/beebot-dev-inta-${tag}" 2>/dev/null`)).stdout).toBe("");
    NodeFs.rmSync(temp, { recursive: true, force: true });
    const left = await sh(
      `podman ps -a -q --filter label=beebot.owner=${prefix}; podman network ls -q --filter label=beebot.owner=${prefix}`,
    );
    expect(left.stdout).toBe("");
    expect(nulFiles()).toEqual(nulBefore);
  }, 180_000);

  it("creates the box on first use with the image's own run spec", async () => {
    expect((await inBox("id -u")).output).toBe("10001");
    const engine = await inspect(`${prefix}-${botId}-engine`);
    const browser = await inspect(`${prefix}-${botId}-browser`);
    for (const container of [engine, browser]) {
      expect(container.Config.User).toBe("10001:10001");
      expect(container.HostConfig.ReadonlyRootfs).toBe(true);
      expect(container.HostConfig.SecurityOpt).toContain("no-new-privileges");
      expect(container.HostConfig.Memory).toBeGreaterThan(0);
    }
    expect(browser.Config.Hostname).toBe("bee-browser");
    expect(browser.HostConfig.SecurityOpt.join(" ")).toContain("seccomp-chromium.json");
    expect(
      engine.Mounts.map(({ Destination }: { Destination: string }) => Destination).sort(),
    ).toEqual(["/home/bee", "/run/bee/bot", "/run/bee/credential", "/work"]);

    const status = await inBox(
      "grep -E '^(CapEff|NoNewPrivs)' /proc/self/status; touch /etc/x 2>&1 | grep -o 'Read-only file system'",
    );
    expect(status.output).toMatch(/^CapEff:\s+0+\nNoNewPrivs:\s+1\nRead-only file system$/);
  }, 600_000);

  it("gives the engine its persona read-only and its credentials writable", async () => {
    await started().runtime.writeBotFile(botId, "persona.md", "You are Bee.");
    const result = await inBox(
      "cat /run/bee/bot/persona.md; echo; touch /run/bee/bot/x 2>/dev/null || echo ro; touch /run/bee/credential/x && echo rw",
    );
    expect(result.output).toBe("You are Bee.\nro\nrw");
  }, 120_000);

  it("reaches the vendor only through the proxy, which adds the key", async () => {
    const result = await inBox(
      "curl -s -H 'x-api-key: box-placeholder' -d '{}' http://proxy.beebot:8080/anthropic/v1/messages",
    );
    expect(result.output).toBe(canarySha);
    const direct = await inBox(
      `curl -s --noproxy '*' --max-time 5 http://${mockIp}:9000/ >/dev/null; echo "mock $?"; curl -s --noproxy '*' --max-time 5 https://1.1.1.1/ >/dev/null; echo "public $?"`,
    );
    expect(direct.output).not.toMatch(/ 0$/m);
  }, 120_000);

  it("answers DNS itself and gives no other resolver", async () => {
    const result = await inBox(
      "getent hosts example.com || echo nxdomain; timeout 3 bash -c 'echo x > /dev/udp/8.8.8.8/53' 2>/dev/null && echo sent || echo unreachable; cat /etc/resolv.conf",
    );
    expect(result.output).toMatch(/^nxdomain\nunreachable\n/);
    expect(result.output).not.toMatch(/nameserver (?!10\.)/);
  }, 120_000);

  it("carries /bee/* to beebotd, with the box's own token", async () => {
    const result = await inBox(
      "curl -s -H 'Authorization: Bearer box-token' http://proxy.beebot:8080/bee/mcp/hello",
    );
    expect(result.output).toBe("bee-ok");
    expect(seenByBeebotd).toContainEqual({ url: "/mcp/hello", authorization: "Bearer box-token" });
  }, 120_000);

  it("copies a finished download into the workspace under the owner's name", async () => {
    const browser = `${prefix}-${botId}-browser`;
    await sh(`podman exec ${browser} sh -c 'echo report > /downloads/0f1e2d3c-guid'`);
    await started().runtime.collect(botId, "0f1e2d3c-guid", "report 1.txt");
    expect((await inBox("cat '/work/downloads/report 1.txt'")).output).toBe("report");
    await expect(started().runtime.collect(botId, "../etc/passwd", "x")).rejects.toThrow(
      "bad download",
    );
    await expect(started().runtime.collect(botId, "0f1e2d3c-guid", "../x")).rejects.toThrow(
      "bad download",
    );
  }, 120_000);

  it("lets the server drive the sidecar's DevTools over boxd's channel, and the engine not", async () => {
    const endpoint = await started().sidecar(botId);
    let version: unknown;
    for (let attempt = 0; attempt < 60 && version === undefined; attempt += 1) {
      version = await fetchJson(await endpoint.connect(), "/json/version").catch(
        () => new Promise((resolve) => setTimeout(() => resolve(undefined), 1000)),
      );
    }
    expect(JSON.stringify(version)).toContain("webSocketDebuggerUrl");

    const session = await createCdpBrowserRuntime(started().sidecar).open(botId, () => true);
    try {
      await session.navigate(
        `data:text/html,${encodeURIComponent("<title>Bee page</title><button>Go</button>")}`,
      );
      const snapshot = await session.snapshot();
      expect(snapshot.title).toBe("Bee page");
      expect(snapshot.elements.map(({ name }) => name)).toContain("Go");
      expect(hostListeners()).toEqual(listenersBefore);
      expect((await boxdListeners()).stdout).toBe("");
    } finally {
      await session.close();
    }

    const browser = await inspect(`${prefix}-${botId}-browser`);
    const sidecarIp = Object.values<{ IPAddress: string }>(browser.NetworkSettings.Networks)[0]
      ?.IPAddress;
    expect(sidecarIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const probe = await inBox(
      `curl -s --noproxy '*' --max-time 5 http://${sidecarIp}:9222/json/version; echo "direct $?"; curl -s --max-time 5 -x http://proxy.beebot:3128 http://${sidecarIp}:9222/json/version -o /dev/null -w '%{http_code}'; echo " proxied"`,
    );
    expect(probe.output).not.toContain("webSocketDebuggerUrl");
    expect(probe.output).not.toMatch(/direct 0$/m);
    expect(probe.output).toMatch(/403 proxied$/);
  }, 180_000);
});
