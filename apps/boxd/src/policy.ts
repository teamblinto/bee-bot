import type { BoxState } from "@beebot/contracts";

import { labelMac, maxTypedText, sameHex, screenSize, validKeys } from "./protocol.ts";

export type Role = "engine" | "browser";
export const roles: Role[] = ["engine", "browser"];

// What the image says about itself (images/box/runSpec.json): who runs, where its volumes go and
// the run flags it was tested with. boxd refuses a spec that drops an isolation flag, and adds
// the network, DNS, mounts and ownership itself.
export type RoleImage = {
  image: string;
  user: string;
  home: string;
  command: string[];
  hostname: string;
  seccomp: boolean;
  tmpfs: string[];
  shm: string;
  memory: string;
  memorySwap: string;
  cpus: string;
  pids: number;
  // Logical volume name to its mount point.
  volumes: Record<string, string>;
};
export type RunSpec = Record<Role, RoleImage>;

const absolute = /^\/[A-Za-z0-9._/-]+$/;

export function parseRunSpec(text: string): RunSpec {
  const json: unknown = JSON.parse(text);
  const top = (key: string) =>
    json && typeof json === "object" ? Reflect.get(json, key) : undefined;
  const image = top("image");
  const user = top("user");
  if (typeof image !== "string" || image === "") {
    throw new Error("runSpec image missing");
  }
  const uid = typeof user === "string" ? /^(\d+):(\d+)$/.exec(user)?.[1] : undefined;
  if (uid === undefined || Number(uid) === 0) {
    throw new Error("runSpec user must be a numeric non-root uid:gid");
  }
  const role = (name: Role): RoleImage => {
    const value = top(name);
    const field = (key: string) =>
      value && typeof value === "object" ? Reflect.get(value, key) : undefined;
    const strings = (key: string) => {
      const list = field(key);
      if (!Array.isArray(list) || !list.every((part) => typeof part === "string")) {
        throw new Error(`runSpec ${name}.${key} must be a list of strings`);
      }
      return list as string[];
    };
    const size = (key: string) => {
      const item = field(key);
      if (typeof item !== "string" || !/^[0-9]+[kmg]?$/.test(item)) {
        throw new Error(`runSpec ${name}.${key} must be a size`);
      }
      return item;
    };
    const positive = (key: string) => {
      const item = field(key);
      if (typeof item !== "number" || !(item > 0)) {
        throw new Error(`runSpec ${name}.${key} must be a positive number`);
      }
      return item;
    };
    if (
      field("capDrop") !== "all" ||
      field("readOnly") !== true ||
      strings("securityOpt").join(",") !== "no-new-privileges"
    ) {
      throw new Error(`runSpec ${name} must drop all caps, set no-new-privileges and be read-only`);
    }
    const volumes = field("volumes");
    if (
      volumes === null ||
      typeof volumes !== "object" ||
      !Object.entries(volumes).every(
        ([key, target]) =>
          /^[a-z]+$/.test(key) && typeof target === "string" && absolute.test(target),
      )
    ) {
      throw new Error(`runSpec ${name}.volumes must map names to absolute paths`);
    }
    const mounts = volumes as Record<string, string>;
    const home = mounts.home ?? mounts.profile;
    if (home === undefined) {
      throw new Error(`runSpec ${name} needs a home or profile volume`);
    }
    const hostname = field("hostname") ?? name;
    if (typeof hostname !== "string" || !/^[a-z0-9-]{1,63}$/.test(hostname)) {
      throw new Error(`runSpec ${name}.hostname is malformed`);
    }
    const tmpfs = strings("tmpfs");
    if (!tmpfs.every((mount) => absolute.test(mount.split(":")[0] ?? ""))) {
      throw new Error(`runSpec ${name}.tmpfs must mount absolute paths`);
    }
    return {
      image,
      user: user as string,
      home,
      command: strings("command"),
      // Chromium's SingletonLock stores the hostname, so a recreated sidecar on a kept profile
      // volume refuses to start unless the hostname is fixed (S6).
      hostname,
      seccomp: field("seccompProfile") !== undefined,
      tmpfs,
      shm: size("shmSize"),
      memory: size("memory"),
      memorySwap: size("memorySwap"),
      cpus: String(positive("cpus")),
      pids: positive("pidsLimit"),
      volumes: mounts,
    };
  };
  return { engine: role("engine"), browser: role("browser") };
}

export type Box = { prefix: string; owner: string; botId: string };

export function boxNames({ prefix, botId }: Box) {
  const base = `${prefix}-${botId}`;
  return {
    container: { engine: `${base}-engine`, browser: `${base}-browser` },
    network: { engine: `${base}-engine-net`, browser: `${base}-browser-net` },
    volume: (role: Role, key: string) => `${base}-${role}-${key}`,
  };
}

export function ownershipLabels(secret: Uint8Array, box: Box, role: Role, name: string) {
  return {
    "beebot.owner": box.owner,
    "beebot.bot": box.botId,
    "beebot.role": role,
    "beebot.mac": labelMac(secret, box.owner, box.botId, name),
  };
}

export function ownedBy(
  secret: Uint8Array,
  box: Box,
  name: string,
  labels: Record<string, string> | null | undefined,
) {
  return (
    labels?.["beebot.owner"] === box.owner &&
    labels["beebot.bot"] === box.botId &&
    sameHex(labels["beebot.mac"] ?? "", labelMac(secret, box.owner, box.botId, name))
  );
}

// Supplied by the egress proxy when it joins a box network (see egress.ts).
export type EgressAttachment = {
  dns: string | null;
  env: Record<string, string>;
  hosts?: Record<string, string>;
};

// A directory in the Linux host bound into the engine.
export type Bind = { source: string; target: string; readOnly: boolean };

export type ContainerSpec = {
  name: string;
  image: string;
  user: string;
  hostname: string;
  command: string[];
  network: string;
  dns: string | null;
  hosts: Record<string, string>;
  env: Record<string, string>;
  volumes: { name: string; target: string }[];
  binds: Bind[];
  tmpfs: string[];
  shm: string;
  seccomp: string | null;
  memory: string;
  memorySwap: string;
  cpus: string;
  pids: number;
  labels: Record<string, string>;
};

export function containerSpec(
  role: Role,
  {
    box,
    secret,
    runSpec,
    seccomp,
    egress,
    labels,
    binds = [],
  }: {
    box: Box;
    secret: Uint8Array;
    runSpec: RunSpec;
    seccomp: string;
    egress: EgressAttachment;
    labels: Record<string, string>;
    binds?: Bind[];
  },
): ContainerSpec {
  const names = boxNames(box);
  const image = runSpec[role];
  const name = names.container[role];
  return {
    name,
    image: image.image,
    user: image.user,
    hostname: image.hostname,
    command: image.command,
    network: names.network[role],
    dns: egress.dns,
    hosts: egress.hosts ?? {},
    env: { ...egress.env, HOME: image.home },
    volumes: Object.entries(image.volumes).map(([key, target]) => ({
      name: names.volume(role, key),
      target,
    })),
    binds,
    tmpfs: image.tmpfs,
    shm: image.shm,
    // Podman's default profile allows chroot only with CAP_SYS_CHROOT, which Chromium's own
    // sandbox needs inside its user namespace (S3).
    seccomp: image.seccomp ? seccomp : null,
    memory: image.memory,
    memorySwap: image.memorySwap,
    cpus: image.cpus,
    pids: image.pids,
    labels: { ...labels, ...ownershipLabels(secret, box, role, name) },
  };
}

function labelArgs(labels: Record<string, string>) {
  return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

export function createArgs(spec: ContainerSpec) {
  return [
    "create",
    "--name",
    spec.name,
    "--pull=never",
    "--init",
    "--user",
    spec.user,
    "--hostname",
    spec.hostname,
    "--cap-drop=all",
    "--security-opt",
    "no-new-privileges",
    ...(spec.seccomp === null ? [] : ["--security-opt", `seccomp=${spec.seccomp}`]),
    "--read-only",
    "--read-only-tmpfs=false",
    ...spec.tmpfs.flatMap((mount) => ["--tmpfs", mount]),
    "--shm-size",
    spec.shm,
    "--memory",
    spec.memory,
    "--memory-swap",
    spec.memorySwap,
    "--cpus",
    spec.cpus,
    "--pids-limit",
    String(spec.pids),
    "--network",
    spec.network,
    "--dns",
    spec.dns ?? "none",
    ...Object.entries(spec.hosts).flatMap(([host, ip]) => ["--add-host", `${host}:${ip}`]),
    ...spec.volumes.flatMap(({ name, target }) => ["-v", `${name}:${target}`]),
    ...spec.binds.flatMap(({ source, target, readOnly }) => [
      "-v",
      `${source}:${target}:${readOnly ? "ro," : ""}nosuid,nodev,noexec`,
    ]),
    ...labelArgs(spec.labels),
    spec.image,
    ...spec.command,
  ];
}

// Internal: no gateway, so nothing leaves except through whatever the egress proxy attaches.
// isolate=true: rootless netavark bridges otherwise route to each other (S1).
// --disable-dns: aardvark would forward queries upstream, a DNS exfiltration path (S1).
export function networkArgs(name: string, labels: Record<string, string>) {
  return [
    "network",
    "create",
    "--internal",
    "--disable-dns",
    "--opt",
    "isolate=true",
    ...labelArgs(labels),
    name,
  ];
}

export function volumeArgs(name: string, labels: Record<string, string>) {
  return ["volume", "create", ...labelArgs(labels), name];
}

// `podman exec` runs the process as its own session leader, and killing the podman client leaves
// that process running. So each exec records its process group in the box's /tmp, and a kill
// signals the whole group from inside the box.
const execDir = "/tmp/.beebot-exec";
const execWrap = `mkdir -p ${execDir} && echo $$ > ${execDir}/"$0"; "$@"; c=$?; rm -f ${execDir}/"$0"; exit $c`;
// The box's sh is dash, whose kill refuses `--`: the signal goes first, then the negative group.
const execKill = `i=0; while [ ! -f ${execDir}/"$0" ] && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done; [ -f ${execDir}/"$0" ] && kill -KILL -"$(cat ${execDir}/"$0")"; rm -f ${execDir}/"$0"`;
const execReap = `for f in ${execDir}/*; do [ -f "$f" ] || continue; kill -KILL -"$(cat "$f")" 2>/dev/null; rm -f "$f"; done`;

export function execArgs(
  container: string,
  execId: string,
  { argv, cwd }: { argv: string[]; cwd?: string | undefined },
) {
  return [
    "exec",
    "-i",
    ...(cwd === undefined ? [] : ["--workdir", cwd]),
    container,
    "sh",
    "-c",
    execWrap,
    execId,
    ...argv,
  ];
}

export function execKillArgs(container: string, execId: string) {
  return ["exec", container, "sh", "-c", execKill, execId];
}

// Processes left by a boxd that died with turns attached.
export function execReapArgs(container: string) {
  return ["exec", container, "sh", "-c", execReap];
}

// The sidecar's DevTools, which Chromium binds to its own loopback. The server reaches it only
// through boxd, so no network path to it exists from any box or from the egress proxy. A box that
// just started may not be listening yet, so the connect retries.
export const cdpArgv = ["socat", "STDIO", "TCP:127.0.0.1:9222,retry=100,interval=0.1"];

// A monitor-wall thumbnail of the sidecar's whole desktop: about 10 KB, 50 ms in the box.
export const captureArgv = [
  "import",
  "-display",
  ":1",
  "-window",
  "root",
  "-resize",
  "400x",
  "-quality",
  "70",
  "jpeg:-",
];

// What the bot sees when it takes a screenshot: the whole desktop at full size.
export const fullCaptureArgv = ["import", "-display", ":1", "-window", "root", "png:-"];

export const maxInputActions = 80;
const wheel = { up: "4", down: "5", left: "6", right: "7" };

function inputStep(action: unknown, last: boolean): string[] | undefined {
  const field = (key: string): unknown =>
    action && typeof action === "object" ? Reflect.get(action, key) : undefined;
  // Only an integer in range reaches argv, so every number there is plain ASCII digits.
  const int = (key: string, min: number, max: number) => {
    const value = field(key);
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
      ? String(value)
      : undefined;
  };
  // A step is refused whole if any of its parts is.
  const shape = (...parts: Array<string | undefined>) =>
    parts.every((part) => part !== undefined) ? (parts as string[]) : undefined;
  const button = int("button", 1, 3);
  switch (field("type")) {
    case "move": {
      const x = int("x", 0, screenSize.width - 1);
      const y = int("y", 0, screenSize.height - 1);
      return shape("mousemove", "--", x, y);
    }
    case "click": {
      const count = field("count") === undefined ? "1" : int("count", 1, 3);
      return shape("click", "--repeat", count, button);
    }
    case "down":
      return shape("mousedown", button);
    case "up":
      return shape("mouseup", button);
    case "scroll": {
      const direction = field("direction");
      const amount = int("amount", 1, 20);
      return typeof direction === "string" && Object.hasOwn(wheel, direction)
        ? shape("click", "--repeat", amount, wheel[direction as keyof typeof wheel])
        : undefined;
    }
    case "wait": {
      const ms = int("ms", 0, 500);
      return shape("sleep", ms && (Number(ms) / 1000).toFixed(3));
    }
    case "key": {
      const keys = field("keys");
      return last && typeof keys === "string" && validKeys(keys)
        ? ["key", "--clearmodifiers", keys]
        : undefined;
    }
    case "type": {
      const text = field("text");
      return last &&
        typeof text === "string" &&
        text.length > 0 &&
        text.length <= maxTypedText &&
        !text.includes("\0")
        ? ["type", "--clearmodifiers", "--", text]
        : undefined;
    }
  }
  return undefined;
}

// One xdotool invocation chains every action. `key` and `type` take the rest of argv as theirs,
// so they may only come last.
export function inputArgv(actions: unknown): string[] | undefined {
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > maxInputActions) {
    return undefined;
  }
  const argv = ["xdotool"];
  for (const [index, action] of actions.entries()) {
    const step = inputStep(action, index === actions.length - 1);
    if (!step) {
      return undefined;
    }
    argv.push(...step);
  }
  return argv;
}

// The sidecar desktop's VNC servers listen on Unix sockets and no TCP port. The view-only one runs
// all the time; a lease's input-capable one exists only while beebotd holds its `control` attach.
const displayDir = "/tmp/bee-display";
const controlSocket = (lease: string) => `${displayDir}/control-${lease}.sock`;

// The box, or a lease's server, can still be starting when its viewer connects, so that retries.
export const displayArgv = (lease?: string) => [
  "socat",
  "STDIO",
  `UNIX-CONNECT:${lease === undefined ? `${displayDir}/view.sock` : controlSocket(lease)},retry=50,interval=0.1`,
];

// One driver: no -shared, and no -viewonly. A killed x11vnc leaves its socket file behind, so it is
// removed before the start and again once the process is gone.
export const controlArgv = (lease: string) => [
  "sh",
  "-c",
  'rm -f "$0" && exec x11vnc -display :1 -unixsock "$0" -rfbport 0 -rfbportv6 -1 -forever -nosel -nopw -cursor arrow -q',
  controlSocket(lease),
];

export const controlCleanupArgs = (container: string, lease: string) => [
  "exec",
  container,
  "rm",
  "-f",
  controlSocket(lease),
];

// After a boxd crash no control attach survives, so no lease socket should either.
export const controlReapArgs = (container: string) => [
  "exec",
  container,
  "sh",
  "-c",
  `rm -f ${displayDir}/control-*.sock`,
];

// A finished download, named by Chromium's GUID, goes from the sidecar into the engine's
// workspace under the name the owner saw. Both names are checked here, since they reach a shell.
export const downloadName = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
export const downloadsDir = "/downloads";

export function copyOutArgs(container: string, file: string) {
  return ["exec", container, "cat", "--", `${downloadsDir}/${file}`];
}

export function copyInArgs(container: string, target: string, name: string) {
  return [
    "exec",
    "-i",
    container,
    "sh",
    "-c",
    'mkdir -p "$0" && cat > "$0/.$1.part" && mv -f "$0/.$1.part" "$0/$1"',
    target,
    name,
  ];
}

export type ContainerFacts = { owned: boolean; running: boolean; oomKilled: boolean };

export function boxState(
  engine: ContainerFacts | null,
  browser: ContainerFacts | null,
): { state: BoxState; reason: string | null } {
  if (engine === null && browser === null) {
    return { state: "absent", reason: null };
  }
  if (engine === null || browser === null) {
    return {
      state: "failed",
      reason: `${engine === null ? "engine" : "browser"} container missing`,
    };
  }
  if (!engine.owned || !browser.owned) {
    return { state: "failed", reason: "container not owned by this boxd" };
  }
  if (engine.oomKilled || browser.oomKilled) {
    return {
      state: "failed",
      reason: `${engine.oomKilled ? "engine" : "browser"} ran out of memory`,
    };
  }
  if (engine.running !== browser.running) {
    return { state: "failed", reason: `${engine.running ? "browser" : "engine"} stopped` };
  }
  return { state: engine.running ? "running" : "stopped", reason: null };
}
