import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import type { Podman } from "./podman.ts";
import type { RoleImage } from "./policy.ts";

// The Podman WSL machine runs its systemd inside a cgroup that also holds WSL's own invisible
// processes, so cgroup v2 refuses to delegate controllers and every rootless limit fails (S3).
// The fix moves systemd into its own cgroup before it starts. It takes effect at the next machine
// start, and Podman may rewrite the file on a re-init, so boxd reapplies it on every boot.
const marker = "# beebot: systemd in its own cgroup";
const cgroupFix = [
  marker,
  "CG=/sys/fs/cgroup",
  'echo "+cpuset +cpu +io +memory +pids" > $CG/cgroup.subtree_control',
  "mkdir -p $CG/beebot-systemd/init.scope",
  "echo $$ > $CG/beebot-systemd/init.scope/cgroup.procs",
];

// Returns the patched bootstrap, the same text when already patched, or null when the file does
// not look like Podman's bootstrap.
export function patchBootstrap(text: string) {
  if (text.includes(marker) || text.includes("beebot-systemd/init.scope")) {
    return text;
  }
  const lines = text.split("\n");
  const launch = lines.findIndex((line) => /^\s*nohup unshare .*\/systemd\b/.test(line));
  if (launch === -1) {
    return null;
  }
  return [...lines.slice(0, launch), ...cgroupFix, ...lines.slice(launch)].join("\n");
}

export function patchContainersConf(text: string) {
  const setting = 'cgroup_manager = "systemd"';
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const engine = lines.findIndex((line) => /^\s*\[engine\]\s*$/.test(line));
  if (engine === -1) {
    return [...lines, ...(lines.length > 0 ? [""] : []), "[engine]", setting, ""].join("\n");
  }
  const sectionEnd = lines.findIndex((line, index) => index > engine && /^\s*\[/.test(line));
  const end = sectionEnd === -1 ? lines.length : sectionEnd;
  const existing = lines.findIndex(
    (line, index) => index > engine && index < end && /^\s*cgroup_manager\s*=/.test(line),
  );
  const next = [...lines];
  if (existing === -1) {
    next.splice(engine + 1, 0, setting);
  } else {
    next[existing] = setting;
  }
  return [...next, ""].join("\n");
}

export const probeLimits = { memory: 64 * 1024 * 1024, pids: 32, cpus: 0.5 };

export function probeArgs(image: RoleImage) {
  return [
    "run",
    "--rm",
    "--pull=never",
    "--user",
    image.user,
    "--cap-drop=all",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--network",
    "none",
    "--memory",
    "64m",
    "--memory-swap",
    "64m",
    "--cpus",
    String(probeLimits.cpus),
    "--pids-limit",
    String(probeLimits.pids),
    image.image,
    "cat",
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/pids.max",
    "/sys/fs/cgroup/cpu.max",
  ];
}

// Reads the probe container's own cgroup files and lists every limit that did not take.
export function limitProblems(output: string) {
  const [memory, pids, cpu] = output.trim().split("\n");
  const [quota, period] = (cpu ?? "").trim().split(/\s+/);
  const problems: string[] = [];
  if (Number(memory) !== probeLimits.memory) {
    problems.push(`memory.max is ${memory ?? "missing"}`);
  }
  if (Number(pids) !== probeLimits.pids) {
    problems.push(`pids.max is ${pids ?? "missing"}`);
  }
  if (Number(quota) / Number(period) !== probeLimits.cpus) {
    problems.push(`cpu.max is ${cpu ?? "missing"}`);
  }
  return problems;
}

export type SetupResult = { bootstrapChanged: boolean; confChanged: boolean };

// The cgroup fix is in place but limits still fail: it applies only once the machine starts again.
export class MachineRestartNeeded extends Error {}

// Idempotent. Throws when limits are not enforced, so boxd never serves a box without caps.
export async function setup(
  podman: Podman,
  image: RoleImage,
  confPath = NodePath.join(NodeOs.homedir(), ".config", "containers", "containers.conf"),
): Promise<SetupResult> {
  let bootstrapChanged = false;
  let fixed = false;
  // Only a Podman WSL machine has this file. Elsewhere (Linux, macOS) sudo or the file is
  // missing and this step does nothing; those hosts are untested.
  const current = await podman.host("sudo", ["-n", "cat", "/root/bootstrap"]);
  if (current.code === 0) {
    const patched = patchBootstrap(current.stdout);
    if (patched === null) {
      throw new Error("unrecognised /root/bootstrap; cannot apply the cgroup fix");
    }
    fixed = true;
    if (patched !== current.stdout) {
      const backup = await podman.host("sudo", [
        "-n",
        "cp",
        "-n",
        "/root/bootstrap",
        "/root/bootstrap.orig-beebot",
      ]);
      const write = await podman.host("sudo", ["-n", "tee", "/root/bootstrap"], patched);
      if (backup.code !== 0 || write.code !== 0) {
        throw new Error("could not write /root/bootstrap");
      }
      bootstrapChanged = true;
    }
  }

  const conf = await NodeFs.readFile(confPath, "utf8").catch(() => "");
  const nextConf = patchContainersConf(conf);
  const confChanged = nextConf !== conf;
  if (confChanged) {
    await NodeFs.mkdir(NodePath.dirname(confPath), { recursive: true });
    await NodeFs.writeFile(confPath, nextConf);
  }

  const probe = await podman.run(probeArgs(image));
  const problems = probe.code === 0 ? limitProblems(probe.stdout) : [probe.stderr.trim()];
  if (problems.length > 0) {
    const message = `container limits are not enforced: ${problems.join("; ")}.`;
    throw fixed
      ? new MachineRestartNeeded(`${message} The cgroup fix applies when the machine restarts.`)
      : new Error(message);
  }
  return { bootstrapChanged, confChanged };
}
