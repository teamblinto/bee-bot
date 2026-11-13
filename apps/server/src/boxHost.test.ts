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

import { boxLayout, proxyKeyPlaceholder } from "./boxEngine.ts";
import { boxdFiles, boxdSecret, readyBoxRuntime, startBoxHost, windowsPodman } from "./boxHost.ts";
import { type BoxExec, type BoxRuntime, createFakeBoxRuntime } from "./boxRuntime.ts";
import { createCdpBrowserRuntime, fetchJson } from "./browserCdp.ts";
import { machineSsh, podmanEnv } from "./boxdRuntime.ts";
import { createClaudeRunTurn } from "./claude.ts";
import { apiKeyName, createMemoryVault } from "./vault.ts";
import { storeApiKey } from "./vaultStore.ts";

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

// The whole path on a real Podman machine (beebot-dev, or BEEBOT_PODMAN_MACHINE): boxd, the egress
// proxy and both containers. Everything is named and labelled for this run and removed by ID
// afterwards.
const machine = process.env.BEEBOT_PODMAN_MACHINE ?? "beebot-dev";
// Found as the server finds it: a per-user install puts podman.exe on PATH.
const podman = NodeFs.existsSync(windowsPodman) ? windowsPodman : "podman";
const ssh = machineSsh(
  NodeChildProcess.spawnSync(podman, ["machine", "inspect", machine], {
    encoding: "utf8",
    env: podmanEnv(),
    windowsHide: true,
  }).stdout ?? "",
  machine,
);
const repo = NodePath.resolve(import.meta.dirname, "../../..");

function sh(script: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = NodeChildProcess.spawn(podman, [...ssh, "bash -s"], {
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

// A run's box image, egress bundle and run spec, as `pnpm build` makes them. Everything a run
// creates on the machine is named `<prefix>-*`, and its files live in `$HOME/<prefix>`.
function prepareRun(prefix: string, temp: string) {
  const image = `localhost/${prefix}-box:latest`;
  const build = NodeChildProcess.spawnSync(
    podman,
    [
      "--connection",
      machine,
      "build",
      "-q",
      "--label",
      "beebot-dev=1",
      "-t",
      image,
      NodePath.join(repo, "images/box"),
    ],
    { encoding: "utf8", env: podmanEnv(), windowsHide: true },
  );
  expect(build.status, build.stderr).toBe(0);

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
  const files = boxdFiles(repo, NodePath.join(temp, "egress", "egress.mjs"));
  return { image, files: { ...files, runSpec } };
}

const ofRun = (prefix: string) => (name: string) =>
  name === prefix || name.startsWith(`${prefix}-`);

// Everything still named for the run: containers, volumes, networks, images and its directory.
async function leftovers(prefix: string) {
  const { stdout } = await sh(
    [
      "podman ps -a --format '{{.Names}}'",
      "podman volume ls --format '{{.Name}}'",
      "podman network ls --format '{{.Name}}'",
      "podman images --format '{{.Repository}}' | sed 's|^localhost/||'",
      `[ -e "$HOME/${prefix}" ] && echo ${prefix}`,
      "true",
    ].join("; "),
  );
  return stdout.split("\n").filter(ofRun(prefix));
}

// Each kind is removed on its own, so one failure leaves nothing else behind. The run's directory
// holds files the box user owns, so only the user namespace can remove it.
async function removeRun(prefix: string) {
  const ids = (list: string) =>
    `$(${list} | awk -v p='${prefix}' '{ n = $2; sub("^localhost/", "", n) } n == p || index(n, p "-") == 1 { print $1 }')`;
  await sh(
    [
      `for id in ${ids("podman ps -a --format '{{.ID}} {{.Names}}'")}; do podman rm -f -t 0 "$id"; done`,
      `for id in ${ids("podman volume ls --format '{{.Name}} {{.Name}}'")}; do podman volume rm -f "$id"; done`,
      `for id in ${ids("podman network ls --format '{{.ID}} {{.Name}}'")}; do podman network rm -f "$id"; done`,
      `for id in ${ids("podman images --format '{{.ID}} {{.Repository}}'")}; do podman rmi -f "$id"; done`,
      `podman unshare rm -rf "$HOME/${prefix}"`,
    ].join("\n"),
  );
}

async function runInBox(runtime: BoxRuntime, botId: string, script: string) {
  const { env, workdir } = boxLayout("");
  const { stream, exited } = await runtime.execAttach(botId, {
    argv: ["bash", "-c", script],
    env,
    cwd: workdir,
  });
  stream.end();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return { output: String(Buffer.concat(chunks)).trim(), code: await exited };
}

// Runs in `afterAll`, so it runs whether the tests passed or not, and even if `close` throws.
async function endRun(prefix: string, close: () => Promise<unknown>) {
  const closed = await close().then(
    () => undefined,
    (error: unknown) => error,
  );
  await removeRun(prefix);
  expect(await leftovers(prefix)).toEqual([]);
  if (closed !== undefined) {
    throw closed;
  }
}

describe.skipIf(!available)("boxes on the beebot-dev machine", () => {
  const tag = NodeCrypto.randomBytes(3).toString("hex");
  const prefix = `beebot-dev-inta-${tag}`;
  const botId = "e2e";
  const installDir = `${prefix}/boxd`;
  const canary = `sk-ant-canary-${NodeCrypto.randomUUID()}`;
  const canarySha = NodeCrypto.createHash("sha256").update(canary).digest("hex");
  const temp = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "beebot-inta-"));
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
  const inBox = (script: string) => runInBox(started().runtime, botId, script);
  const inspect = async (name: string) =>
    JSON.parse((await sh(`podman inspect ${name}`)).stdout)[0];

  beforeAll(async () => {
    const { image, files } = prepareRun(prefix, temp);

    // The vendor stand-in answers with a hash of the key it got. It sits on a network of the test's
    // own, which the proxy joins once boxd has made it and its upstream network.
    const respond = [
      'key=""',
      "while IFS= read -r line; do line=${line%$'\\r'}; [ -z \"$line\" ] && break",
      '  case "${line,,}" in x-api-key:*) key=${line#*: };; esac; done',
      'body=$(printf %s "$key" | sha256sum | cut -c1-64)',
      "printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 64\\r\\nConnection: close\\r\\n\\r\\n%s' \"$body\"",
    ].join("\n");
    const dir = `$HOME/${prefix}`;
    const mock = await sh(
      [
        "set -e",
        `mkdir -p ${dir}`,
        `cat > ${dir}/respond.sh <<'BEEBOT_EOF'`,
        respond,
        "BEEBOT_EOF",
        `podman network create --disable-dns --opt isolate=true --label beebot-dev=1 ${prefix}-vendor-net >/dev/null`,
        `podman run -d --name ${prefix}-vendor --label beebot-dev=1 --user 10001:10001 --cap-drop=all --network ${prefix}-vendor-net -v ${dir}/respond.sh:/respond.sh:ro ${image} socat TCP-LISTEN:9000,fork,reuseaddr 'SYSTEM:bash /respond.sh' >/dev/null`,
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
    boxes = await startBoxHost({
      host: { kind: "podman-machine", podman, machine },
      installDir,
      owner: prefix,
      vault,
      account: () => "claude",
      egressInput: () => ({
        engineAccountId: "claude",
        lane: "api_key",
        anySite: false,
        hosts: [],
      }),
      beebotdPort: () => (beebotd.address() as NodeNet.AddressInfo).port,
      setBox: () => {},
      bootstrap: {
        prefix,
        labels: { "beebot-dev": "1" },
        testUpstreams: { anthropic: `http://${mockIp}:9000` },
      },
      files,
    });
    const joined = await sh(`podman network connect ${prefix}-vendor-net ${prefix}-egress`);
    expect(joined.code, joined.stderr).toBe(0);
  }, 900_000);

  afterAll(async () => {
    beebotd?.close();
    NodeFs.rmSync(temp, { recursive: true, force: true });
    await endRun(prefix, async () => boxes?.close());
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

  it("isolates every network it makes, the proxy's upstream among them", async () => {
    await inBox("true");
    const listed = await sh(
      `podman network inspect $(podman network ls -q --filter label=beebot.owner=${prefix})`,
    );
    expect(listed.code, listed.stderr).toBe(0);
    const networks = JSON.parse(listed.stdout) as {
      name: string;
      options?: Record<string, string>;
    }[];
    // The upstream network and the box's two.
    expect(networks.map(({ name }) => name)).toContain(`${prefix}-egress-up`);
    expect(networks.length).toBeGreaterThanOrEqual(3);
    for (const { name, options } of networks) {
      expect({ name, isolate: options?.isolate }).toEqual({ name, isolate: "true" });
    }
  }, 600_000);

  it("gives the engine its persona read-only and its credentials writable", async () => {
    await started().runtime.writeBotFile(botId, "persona.md", "You are Bee.");
    const result = await inBox(
      "cat /run/bee/bot/persona.md; echo; touch /run/bee/bot/x 2>/dev/null || echo ro; touch /run/bee/credential/x && echo rw",
    );
    expect(result.output).toBe("You are Bee.\nro\nrw");
  }, 120_000);

  it("gives the engine only its kept skills, read-only and noexec", async () => {
    const { runtime } = started();
    const sha256 = "a".repeat(64);
    const file = (path: string, text: string) => ({
      path,
      data: Buffer.from(text).toString("base64"),
    });
    const files = [
      file("SKILL.md", "---\nname: demo\n---\n"),
      file("run.sh", "#!/bin/sh\necho ran\n"),
    ];
    expect(await runtime.keepSkills(botId, [{ name: "demo", sha256 }])).toEqual(["demo"]);
    await runtime.writeSkill(botId, { name: "demo", sha256, files });
    expect(await runtime.keepSkills(botId, [{ name: "demo", sha256 }])).toEqual([]);
    const result = await inBox(
      "head -1 /run/bee/skills/demo/SKILL.md; touch /run/bee/skills/demo/x 2>/dev/null || echo ro; /run/bee/skills/demo/run.sh 2>/dev/null || echo noexec",
    );
    expect(result.output).toBe("---\nro\nnoexec");
    await runtime.keepSkills(botId, []);
    expect((await inBox("ls /run/bee/skills | wc -l")).output).toBe("0");
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
      // On the 1280x800 desktop the button sits below Chromium's toolbars.
      const target = await session.click(snapshot.elements.findIndex(({ name }) => name === "Go"));
      expect(target?.secret).toBe(false);
      expect(target?.x).toBeGreaterThan(0);
      expect(target?.x).toBeLessThan(0.2);
      expect(target?.y).toBeGreaterThan(0.05);
      expect(target?.y).toBeLessThan(0.3);
      const shot = Buffer.from(await session.screenshot(), "base64");
      expect(shot.subarray(0, 2).toString("hex")).toBe("ffd8");
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

  it("captures a small JPEG of the desktop, and never starts a stopped box for one", async () => {
    const jpeg = await started().runtime.capture(botId);
    expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(jpeg.length).toBeLessThan(100_000);
    await started().runtime.stop(botId);
    await expect(started().runtime.capture(botId)).rejects.toThrow("stopped");
    expect(await started().runtime.snapshot(botId)).toBe("stopped");
  }, 180_000);
});

// Opt-in: a real Claude Code turn with a real Anthropic key, which costs money. Point
// BEEBOT_REAL_ANTHROPIC_KEY_FILE at a file holding the key. Every check compares inside the test,
// so no failure can put the key in the output.
const keyFile = process.env.BEEBOT_REAL_ANTHROPIC_KEY_FILE;

describe.skipIf(!available || !keyFile)(
  "a real Claude turn in a box on the beebot-dev machine",
  () => {
    const tag = NodeCrypto.randomBytes(3).toString("hex");
    const prefix = `beebot-dev-intr-${tag}`;
    const botId = "real";
    const temp = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "beebot-intr-"));
    // Allowed only while the vendor's installer runs.
    const installerHosts = ["claude.ai", "downloads.claude.ai", "storage.googleapis.com"];
    let hosts = installerHosts;
    let key = "";
    let boxes: Awaited<ReturnType<typeof startBoxHost>> | undefined;
    let beebotd: NodeHttp.Server | undefined;
    let port = 0;

    const started = () => {
      if (boxes === undefined) {
        throw new Error("boxes did not start");
      }
      return boxes;
    };
    const inBox = (script: string) => runInBox(started().runtime, botId, script);

    beforeAll(async () => {
      const { files } = prepareRun(prefix, temp);
      // The run's MCP and hook endpoint. A one-word reply calls neither.
      beebotd = NodeHttp.createServer((_request, response) => {
        response.writeHead(404).end();
      });
      beebotd.listen(0, "127.0.0.1");
      await once(beebotd, "listening");
      port = (beebotd.address() as NodeNet.AddressInfo).port;

      const vault = createMemoryVault();
      const stored = await storeApiKey(
        vault,
        "claude",
        NodeFs.readFileSync(keyFile ?? "", "utf8").trim(),
      );
      expect(stored.status).toBe(200);
      key = (await vault.get(apiKeyName("claude"))) ?? "";
      expect(key.length > 20).toBe(true);
      boxes = await startBoxHost({
        host: { kind: "podman-machine", podman, machine },
        installDir: `${prefix}/boxd`,
        owner: prefix,
        vault,
        account: () => "claude",
        egressInput: () => ({ engineAccountId: "claude", lane: "api_key", anySite: false, hosts }),
        beebotdPort: () => port,
        setBox: () => {},
        bootstrap: { prefix, labels: { "beebot-dev": "1" } },
        files,
      });
    }, 900_000);

    afterAll(async () => {
      beebotd?.close();
      NodeFs.rmSync(temp, { recursive: true, force: true });
      await endRun(prefix, async () => boxes?.close());
    }, 180_000);

    it("installs Claude Code into the box's home with the vendor's installer, through the proxy", async () => {
      const install = await inBox(
        'curl -fsSL https://claude.ai/install.sh | bash > /tmp/install.log 2>&1; echo "installer $?"; tail -n 5 /tmp/install.log; claude --version',
      );
      expect(install.output).toMatch(/^installer 0\n[\s\S]*\n\d+\.\d+\.\d+ \(Claude Code\)$/);
      expect((await inBox('readlink -f "$(command -v claude)"')).output).toMatch(/^\/home\/bee\//);

      hosts = [];
      await started().egress.apply(botId);
      const closed = await inBox(
        "curl -s -o /dev/null --max-time 10 -w '%{http_connect}' https://claude.ai/install.sh; echo \" $?\"",
      );
      expect(closed.output).toMatch(/^403 [1-9]\d*$/);
    }, 600_000);

    it("finishes a real turn on the API lane with the key added only by the proxy, while direct egress and DNS fail", async () => {
      const execs: BoxExec[] = [];
      const runtime: BoxRuntime = {
        ...started().runtime,
        execAttach: (id, exec) => {
          execs.push(exec);
          return started().runtime.execAttach(id, exec);
        },
      };
      const runTurn = createClaudeRunTurn({
        command: ["claude"],
        dataDir: temp,
        box: { runtime, layout: boxLayout(temp) },
      });
      const { promise: delivered, resolve: markDelivered } = Promise.withResolvers<void>();
      let reply = "";
      const turn = runTurn({
        prompt: "Reply with the word OK and nothing else.",
        sessionId: NodeCrypto.randomUUID(),
        resume: false,
        launch: {
          botId,
          name: "Bee",
          personality: "",
          memory: "",
          skills: [],
          skillsDir: "/skills",
          connectors: [],
          projectPath: null,
          engineAccountId: "claude",
          lane: "api_key",
          model: "haiku",
          effort: null,
          mode: "build",
          control: "none",
        },
        signal: new AbortController().signal,
        onDelta: (text) => {
          reply += text;
        },
        onToolStart: () => {},
        onToolEnd: () => {},
        onThinking: () => {},
        onRateLimit: () => {},
        permissions: {
          url: `http://127.0.0.1:${port}/mcp`,
          token: NodeCrypto.randomUUID(),
        },
        onDelivered: markDelivered,
        approve: async () => ({ behavior: "deny", message: "unused" }),
      });
      // While the CLI runs: no way out but the proxy, and no resolver but its own.
      const during = delivered.then(() =>
        inBox(
          [
            "curl -s --noproxy '*' --max-time 5 -o /dev/null https://api.anthropic.com/; echo \"direct-name $?\"",
            "curl -s --noproxy '*' --max-time 5 -o /dev/null --resolve api.anthropic.com:443:160.79.104.10 https://api.anthropic.com/; echo \"direct-ip $?\"",
            "curl -s --noproxy '*' --max-time 5 -o /dev/null https://1.1.1.1/; echo \"direct-public $?\"",
            "getent hosts api.anthropic.com >/dev/null && echo 'dns resolved' || echo 'dns nxdomain'",
            "timeout 3 bash -c 'echo x > /dev/udp/8.8.8.8/53' 2>/dev/null && echo 'udp sent' || echo 'udp unreachable'",
          ].join("; "),
        ),
      );
      const [outcome, probes] = await Promise.all([turn, during]);
      expect(outcome.kind).toBe("completed");
      expect(reply).toMatch(/OK/);
      expect(probes.output).toMatch(
        /^direct-name [1-9]\d*\ndirect-ip [1-9]\d*\ndirect-public [1-9]\d*\ndns nxdomain\nudp unreachable$/,
      );

      // The CLI got the placeholder and the proxy's lane, and nothing it was given is the key.
      const cli = execs.find(({ argv }) => argv[0] === "claude");
      expect(cli?.env.ANTHROPIC_API_KEY).toBe(proxyKeyPlaceholder);
      expect(cli?.env.ANTHROPIC_BASE_URL).toBe("http://proxy.beebot:8080/anthropic");
      expect(execs.some((exec) => JSON.stringify(exec).includes(key))).toBe(false);
      const engine = (await sh(`podman inspect ${prefix}-${botId}-engine`)).stdout;
      expect(engine.length > 0 && !engine.includes(key)).toBe(true);

      // Every key-shaped string the box could have written or holds in a process environment, by
      // hash only, so the key never goes into the box to look for it.
      const scan = await inBox(
        [
          "{ grep -rhoaE 'sk-ant-[A-Za-z0-9_-]{16,}' /home/bee /work /tmp /run/bee 2>/dev/null",
          "  cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -oaE 'sk-ant-[A-Za-z0-9_-]{16,}'; } |",
          '  sort -u | while read -r found; do printf %s "$found" | sha256sum | cut -c1-64; done',
          "test -s /home/bee/.claude.json && echo 'cli state written'",
        ].join("\n"),
      );
      expect(scan.output).toMatch(/cli state written$/);
      const keySha = NodeCrypto.createHash("sha256").update(key).digest("hex");
      expect(scan.output.includes(keySha)).toBe(false);

      // The proxy's own log: the key went only to api.anthropic.com, and since the installer
      // finished nothing has left by CONNECT.
      const log = await sh(`podman logs ${prefix}-egress`);
      expect(log.code).toBe(0);
      expect(`${log.stdout}${log.stderr}`.includes(key)).toBe(false);
      const events = `${log.stdout}\n${log.stderr}`
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const api = events.filter(({ ev, decision }) => ev === "api" && decision === "allow");
      expect(api.length).toBeGreaterThan(0);
      expect(new Set(api.map(({ host }) => host))).toEqual(new Set(["api.anthropic.com"]));
      expect(api.some(({ status }) => status === 200)).toBe(true);
      const connects = events.filter(
        ({ ev, decision }) => ev === "connect" && decision === "allow",
      );
      expect(connects.every(({ host }) => installerHosts.includes(String(host)))).toBe(true);
    }, 600_000);
  },
);
