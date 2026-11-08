import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { runArgs, type BoxEntry } from "./index.ts";
import { buildArgs, imageDir, podman, podmanOk } from "./podman.ts";

const podmanUp = (await podman(["version", "--format", "{{.Server.Version}}"])).code === 0;

const prefix = "beebot-dev-ws1";
const image = `localhost/${prefix}-box:test`;
const label = "beebot-dev=1";
const containers: string[] = [];
const volumes: string[] = [];

// With a Podman machine (Windows, macOS) the profile must live inside the machine: host paths
// are not mounted there.
async function seccompPath() {
  const local = join(imageDir, "seccomp-chromium.json");
  if (process.platform === "linux") return local;
  const machines = await podmanOk(["machine", "list", "--format", "{{.Name}} {{.Default}}"]);
  const machine = machines
    .split("\n")
    .find((line) => line.endsWith(" true"))
    ?.split(" ")[0]
    ?.replace(/\*$/, "");
  if (!machine) throw new Error("no default Podman machine");
  const dir = `${prefix}-seccomp`;
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
    // `podman machine ssh` must not leave the file the MSYS ssh writes for UserKnownHostsFile=NUL.
    expect(readdirSync(process.cwd())).not.toContain("NUL");
  });

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

  it("browser keeps Chromium's sandbox under the shipped seccomp profile", async () => {
    const id = await startBox("browser", ["profile"], ["-p", "127.0.0.1::9223"]);
    const address = (await podmanOk(["port", id, "9223/tcp"])).split("\n")[0];

    const version = await until(async () => {
      const response = await fetch(`http://${address}/json/version`);
      return (await response.json()) as { webSocketDebuggerUrl: string };
    }, "CDP");
    const text = await sandboxPage(version.webSocketDebuggerUrl);
    expect(text).toContain("You are adequately sandboxed.");
    expect(text).toMatch(/Seccomp-BPF sandbox\s+Yes/);

    await expectConfined(id);
  }, 120_000);
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
