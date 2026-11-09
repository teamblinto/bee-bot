import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  captureArgv,
  cdpArgv,
  controlArgv,
  controlCleanupArgs,
  displayArgv,
  execArgs,
  execKillArgs,
} from "@beebot/boxd/policy";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { runArgs, type BoxEntry } from "./index.ts";
import { buildArgs, imageDir, podman, podmanOk } from "./podman.ts";

const podmanUp = (await podman(["version", "--format", "{{.Server.Version}}"])).code === 0;

// Unique per run: other worktrees run this file on the same machine at the same time.
const prefix = `beebot-dev-ws1-${randomBytes(3).toString("hex")}`;
const image = `localhost/${prefix}-box:test`;
const label = "beebot-dev=1";
const containers: string[] = [];
const volumes: string[] = [];
let seccompDir: { machine: string; dir: string } | undefined;

// With a Podman machine (Windows, macOS) the profile must live inside the machine: host paths
// are not mounted there.
async function seccompPath() {
  const local = join(imageDir, "seccomp-chromium.json");
  if (process.platform === "linux") return local;
  const machines = await podmanOk(["machine", "list", "--format", "{{.Name}} {{.Default}}"]);
  const lines = machines.split("\n");
  // A default rootful connection leaves the machine itself marked non-default.
  const machine = (
    lines.find((line) => line.endsWith(" true")) ?? (lines.length === 1 ? lines[0] : undefined)
  )
    ?.split(" ")[0]
    ?.replace(/\*$/, "");
  if (!machine) throw new Error("no default Podman machine");
  const dir = `${prefix}-seccomp`;
  seccompDir = { machine, dir };
  const home = await podmanOk(
    ["machine", "ssh", machine, `mkdir -p ${dir} && cat > ${dir}/seccomp-chromium.json && pwd`],
    await readFile(local, "utf8"),
  );
  return `${home.split("\n").at(-1)}/${dir}/seccomp-chromium.json`;
}

async function startBox(entry: BoxEntry, keys: string[], extra: string[] = []) {
  const named: Record<string, string> = {};
  for (const key of keys) {
    const name = `${prefix}-${entry}-${key}`;
    await podmanOk(["volume", "create", "--label", label, name]);
    volumes.push(name);
    named[key] = name;
  }
  const args = runArgs(entry, image, {
    name: `${prefix}-${entry}`,
    volumes: named,
    extra: ["--label", label, ...extra],
    ...(entry === "browser" ? { seccompPath: await seccompPath() } : {}),
  });
  const id = await podmanOk(args);
  containers.push(id);
  return id;
}

const exec = (id: string, script: string) => podman(["exec", id, "sh", "-c", script]);

async function processes(id: string) {
  const { stdout } = await exec(
    id,
    `for p in /proc/[0-9]*; do printf "Userns:%s " "$(readlink $p/ns/user 2>/dev/null || echo nested)"; awk '/^(Name|Uid|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):/ { printf "%s%s ", $1, $2 } END { print "" }' $p/status 2>/dev/null; done`,
  );
  return stdout
    .split("\n")
    .filter((line) => line.includes("Uid:"))
    .map((line) =>
      Object.fromEntries(
        line
          .trim()
          .split(" ")
          .map((field) => [
            field.slice(0, field.indexOf(":")),
            field.slice(field.indexOf(":") + 1),
          ]),
      ),
    );
}

async function expectConfined(id: string) {
  const config = await podmanOk([
    "inspect",
    id,
    "--format",
    "{{.HostConfig.ReadonlyRootfs}} {{len .HostConfig.CapAdd}}",
  ]);
  expect(config).toBe("true 0");

  const write = await exec(id, "touch /usr/bee-probe");
  expect(write.code).not.toBe(0);
  expect(write.stderr).toContain("Read-only file system");

  const procs = await processes(id);
  const boxUserns = (await exec(id, "readlink /proc/self/ns/user")).stdout.trim();
  expect(boxUserns).toMatch(/^user:/);
  expect(procs.length).toBeGreaterThan(1);
  expect(procs.some((proc) => proc.Userns === boxUserns)).toBe(true);
  for (const proc of procs) {
    const shown = JSON.stringify(proc);
    expect(proc, shown).toMatchObject({ Uid: "10001", NoNewPrivs: "1" });
    // Chromium's sandbox helpers sit in a nested user namespace and may hold capabilities
    // there, which grant nothing in the box's namespace.
    if (proc.Userns !== boxUserns) continue;
    expect(proc, shown).toMatchObject({
      CapPrm: "0000000000000000",
      CapEff: "0000000000000000",
      CapBnd: "0000000000000000",
      CapAmb: "0000000000000000",
    });
  }
}

// Listening TCP sockets in the box, as /proc/net/tcp and tcp6 spell them: hex address:port.
async function listeners(id: string) {
  const { stdout } = await exec(id, "cat /proc/net/tcp /proc/net/tcp6");
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[3] === "0A")
    .map((fields) => fields[1] ?? "");
}

async function until<T>(probe: () => Promise<T | undefined>, what: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!podmanUp)("box image", () => {
  beforeAll(async () => {
    await podmanOk(buildArgs(image, [label]));
  }, 900_000);

  afterAll(async () => {
    if (containers.length) await podman(["rm", "-f", "-t", "0", ...containers]);
    if (volumes.length) await podman(["volume", "rm", "-f", ...volumes]);
    await podman(["rmi", image]);
    if (seccompDir) {
      await podman(["machine", "ssh", seccompDir.machine, `rm -rf ${seccompDir.dir}`]);
    }
    // `podman machine ssh` must not leave the file the MSYS ssh writes for UserKnownHostsFile=NUL.
    expect(readdirSync(process.cwd())).not.toContain("NUL");
  }, 120_000);

  it("ships no vendor CLI", async () => {
    const scan = await podmanOk([
      "run",
      "--rm",
      "--label",
      label,
      "--name",
      `${prefix}-scan`,
      "--user",
      "0",
      image,
      "sh",
      "-c",
      `command -v claude codex; find / -xdev \\( -iname 'claude*' -o -iname 'codex*' -o -path '*node_modules/@anthropic-ai*' -o -path '*node_modules/@openai/codex*' \\)`,
    ]);
    expect(scan).toBe("");
  }, 120_000);

  it("engine runs tmux unprivileged on a read-only root", async () => {
    const id = await startBox("engine", ["home", "workspace"]);
    await until(
      async () => ((await exec(id, "tmux has-session -t main")).code === 0 ? true : undefined),
      "tmux session",
    );
    await expectConfined(id);

    const env = await podmanOk([
      "exec",
      id,
      "sh",
      "-c",
      'touch "$HOME/probe" /work/probe && tmux display -p -t main "#{pane_current_path}" && echo "$PATH"',
    ]);
    expect(env.split("\n")).toEqual([
      "/work",
      expect.stringMatching(/^\/home\/bee\/\.local\/bin:/),
    ]);
  }, 120_000);

  it("browser keeps headed Chromium's sandbox under the shipped seccomp profile", async () => {
    const id = await startBox("browser", ["profile"], ["-p", "127.0.0.1::9223"]);

    // A viewer can open a box that has only just started: boxd's connects wait for it to listen.
    const banner = `sleep 1 | ${displayArgv().join(" ")}`;
    expect((await exec(id, banner)).stdout).toMatch(/^RFB /);
    const request = "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    const devtools = `{ printf '${request}'; sleep 1; } | ${cdpArgv.join(" ")}`;
    expect((await exec(id, devtools)).stdout).toContain("webSocketDebuggerUrl");

    // boxd reaches DevTools and the VNC socket through `podman exec`. Chromium starts last, so
    // once DevTools listens the desktop is up, and it adds no TCP listener of its own.
    const listening = await until(async () => {
      const found = await listeners(id);
      return found.includes("0100007F:2406") ? found : undefined;
    }, "DevTools on loopback port 9222");
    expect(listening).toEqual(["0100007F:2406"]);
    expect(await podmanOk(["exec", "-e", "DISPLAY=:1", id, "xdotool", "getdisplaygeometry"])).toBe(
      "1280 800",
    );

    // The wall's thumbnail: a small JPEG of the whole desktop, from boxd's fixed argv.
    const shot = captureArgv.join(" ");
    const [magic, size] = (
      await podmanOk(["exec", id, "sh", "-c", `${shot} | od -An -tx1 -N2; ${shot} | wc -c`])
    ).split("\n");
    expect(magic?.trim()).toBe("ff d8");
    expect(Number(size)).toBeGreaterThan(1000);
    expect(Number(size)).toBeLessThan(100_000);

    // A pointer move to 640,400 sent as RFB bytes through boxd's own display argv; only a server
    // without -viewonly obeys it.
    const pointAt = (argv: string[]) =>
      podmanOk([
        "exec",
        "-e",
        "DISPLAY=:1",
        id,
        "sh",
        "-c",
        `xdotool mousemove 100 100; { printf 'RFB 003.008\\n\\001\\001\\005\\000\\002\\200\\001\\220'; sleep 1; } | ${argv.join(" ")} >/dev/null; xdotool getmouselocation`,
      ]);
    expect(await pointAt(displayArgv())).toMatch(/^x:100 y:100 /);

    // A lease's control server, started and killed the way boxd does it. The viewer connects
    // while the server may still be starting.
    const lease = randomUUID();
    const socket = `/tmp/bee-display/control-${lease}.sock`;
    const hasSocket = async () => (await exec(id, `test -S ${socket}`)).code === 0;
    const running = async () =>
      (await exec(id, `grep -l "control-${lease}.soc[k]" /proc/[0-9]*/cmdline`)).stdout.trim() !==
      "";
    expect(await hasSocket()).toBe(false);
    const execId = randomUUID();
    const server = podman(execArgs(id, execId, { argv: controlArgv(lease) }));
    expect(await pointAt(displayArgv(lease))).toMatch(/^x:640 y:400 /);
    expect(await hasSocket()).toBe(true);
    expect(await pointAt(displayArgv())).toMatch(/^x:100 y:100 /);
    await podmanOk(execKillArgs(id, execId));
    await server;
    expect(await running()).toBe(false);
    await podmanOk(controlCleanupArgs(id, lease));
    expect(await hasSocket()).toBe(false);
    expect(await listeners(id)).toEqual(["0100007F:2406"]);

    // Only for this test: a relay so the WebSocket below can reach DevTools from the host.
    await podmanOk(["exec", "-d", id, "socat", "TCP-LISTEN:9223,fork", "TCP:127.0.0.1:9222"]);
    const address = (await podmanOk(["port", id, "9223/tcp"])).split("\n")[0];

    const version = await until(async () => {
      const response = await fetch(`http://${address}/json/version`);
      return (await response.json()) as { webSocketDebuggerUrl: string };
    }, "CDP");
    const text = await sandboxPage(version.webSocketDebuggerUrl);
    expect(text).toContain("You are adequately sandboxed.");
    expect(text).toMatch(/Seccomp-BPF sandbox\s+Yes/);

    await expectConfined(id);

    // boxd stops the browser with `podman stop -t 10`; the entrypoint stops its desktop in reverse.
    const stopping = Date.now();
    await podmanOk(["stop", "-t", "10", id]);
    expect(Date.now() - stopping).toBeLessThan(10_000);
    expect(await podmanOk(["inspect", id, "--format", "{{.State.ExitCode}}"])).toBe("0");
    const { stderr } = await podman(["logs", id]);
    expect(stderr.match(/(?<=bee-browser: stopping )\w+/g)).toEqual([
      "chromium",
      "x11vnc",
      "openbox",
      "dbus",
      "Xvfb",
    ]);
  }, 180_000);
});

async function sandboxPage(url: string) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 0;
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    pending.get(message.id)?.(message.result ?? {});
    pending.delete(message.id);
  };
  const send = (method: string, params: object, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  try {
    const { targetId } = await send("Target.createTarget", { url: "chrome://sandbox" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    return await until(async () => {
      const { result } = await send(
        "Runtime.evaluate",
        { expression: "document.body.innerText", returnByValue: true },
        String(sessionId),
      );
      const text = String((result as { value?: unknown } | undefined)?.value ?? "");
      return text.includes("sandboxed") ? text : undefined;
    }, "chrome://sandbox");
  } finally {
    ws.close();
  }
}
