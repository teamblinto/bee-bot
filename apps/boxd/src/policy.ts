import type { BoxState } from "@beebot/contracts";

import { labelMac, sameHex } from "./protocol.ts";

export type Role = "engine" | "browser";
export const roles: Role[] = ["engine", "browser"];

// What the image says about itself (images/box/runSpec.json). Everything about isolation is
// boxd's own policy below and never comes from this file.
export type RoleImage = { image: string; user: string; home: string; command: string[] };
export type RunSpec = Record<Role, RoleImage>;

export function parseRunSpec(text: string): RunSpec {
  const json: unknown = JSON.parse(text);
  const role = (name: Role): RoleImage => {
    const value = json && typeof json === "object" ? Reflect.get(json, name) : undefined;
    const field = (key: string) =>
      value && typeof value === "object" ? Reflect.get(value, key) : undefined;
    const image = field("image");
    const user = field("user");
    const home = field("home");
    const command = field("command");
    if (typeof image !== "string" || image === "") {
      throw new Error(`runSpec ${name}.image missing`);
    }
    const uid = typeof user === "string" ? /^(\d+):(\d+)$/.exec(user)?.[1] : undefined;
    if (uid === undefined || Number(uid) === 0) {
      throw new Error(`runSpec ${name}.user must be a numeric non-root uid:gid`);
    }
    if (typeof home !== "string" || !/^\/[A-Za-z0-9._/-]+$/.test(home)) {
      throw new Error(`runSpec ${name}.home must be an absolute path`);
    }
    if (!Array.isArray(command) || !command.every((part) => typeof part === "string")) {
      throw new Error(`runSpec ${name}.command must be a list of strings`);
    }
    return { image, user: user as string, home, command: command as string[] };
  };
  return { engine: role("engine"), browser: role("browser") };
}

export const limits = {
  engine: { memory: "2g", cpus: "2", pids: 512, tmp: "256m", shm: null },
  browser: { memory: "1g", cpus: "2", pids: 512, tmp: "256m", shm: "1g" },
} satisfies Record<
  Role,
  { memory: string; cpus: string; pids: number; tmp: string; shm: string | null }
>;

// Chromium's SingletonLock stores the hostname, so a recreated sidecar on a kept profile volume
// refuses to start unless the hostname is fixed (S6).
const hostnames: Record<Role, string> = { engine: "engine", browser: "browser" };

export type Box = { prefix: string; owner: string; botId: string };

export function boxNames({ prefix, botId }: Box) {
  const base = `${prefix}-${botId}`;
  return {
    container: { engine: `${base}-engine`, browser: `${base}-browser` },
    network: { engine: `${base}-engine-net`, browser: `${base}-browser-net` },
    volume: { engine: `${base}-engine-home`, browser: `${base}-browser-profile` },
  } satisfies Record<string, Record<Role, string>>;
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
export type EgressAttachment = { dns: string | null; env: Record<string, string> };

export type ContainerSpec = {
  name: string;
  image: string;
  user: string;
  hostname: string;
  command: string[];
  network: string;
  dns: string | null;
  env: Record<string, string>;
  volume: { name: string; target: string };
  tmp: string;
  shm: string | null;
  seccomp: string | null;
  memory: string;
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
  }: {
    box: Box;
    secret: Uint8Array;
    runSpec: RunSpec;
    seccomp: string;
    egress: EgressAttachment;
    labels: Record<string, string>;
  },
): ContainerSpec {
  const names = boxNames(box);
  const image = runSpec[role];
  const limit = limits[role];
  const name = names.container[role];
  return {
    name,
    image: image.image,
    user: image.user,
    hostname: hostnames[role],
    command: image.command,
    network: names.network[role],
    dns: egress.dns,
    env: { ...egress.env, HOME: image.home },
    volume: { name: names.volume[role], target: image.home },
    tmp: limit.tmp,
    shm: limit.shm,
    // Podman's default profile allows chroot only with CAP_SYS_CHROOT, which Chromium's own
    // sandbox needs inside its user namespace (S3). The engine keeps the default.
    seccomp: role === "browser" ? seccomp : null,
    memory: limit.memory,
    cpus: limit.cpus,
    pids: limit.pids,
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
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${spec.tmp},mode=1777`,
    ...(spec.shm === null ? [] : ["--shm-size", spec.shm]),
    "--memory",
    spec.memory,
    "--memory-swap",
    spec.memory,
    "--cpus",
    spec.cpus,
    "--pids-limit",
    String(spec.pids),
    "--network",
    spec.network,
    "--dns",
    spec.dns ?? "none",
    "-v",
    `${spec.volume.name}:${spec.volume.target}`,
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
const execKill = `i=0; while [ ! -f ${execDir}/"$0" ] && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done; [ -f ${execDir}/"$0" ] && kill -KILL -- -"$(cat ${execDir}/"$0")"; rm -f ${execDir}/"$0"`;
const execReap = `for f in ${execDir}/*; do [ -f "$f" ] || continue; kill -KILL -- -"$(cat "$f")" 2>/dev/null; rm -f "$f"; done`;

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
