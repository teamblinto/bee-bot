import runSpec from "./runSpec.json" with { type: "json" };

export { runSpec };

export type BoxEntry = "engine" | "browser";

export type BoxRunOptions = {
  name: string;
  // Logical volume name from runSpec (`home`, `workspace`, `profile`) to a Podman volume.
  volumes: Record<string, string>;
  // Path of seccomp-chromium.json as Podman's host sees it (inside the machine on Windows/macOS).
  seccompPath?: string;
  extra?: string[];
};

export function runArgs(entry: BoxEntry, image: string, options: BoxRunOptions) {
  const spec = runSpec[entry];
  const args = [
    "run",
    "-d",
    "--name",
    options.name,
    "--user",
    runSpec.user,
    "--init",
    "--read-only",
    `--cap-drop=${spec.capDrop}`,
    ...spec.securityOpt.flatMap((opt) => ["--security-opt", opt]),
    ...spec.tmpfs.flatMap((mount) => ["--tmpfs", mount]),
    `--shm-size=${spec.shmSize}`,
    `--memory=${spec.memory}`,
    `--memory-swap=${spec.memorySwap}`,
    `--cpus=${spec.cpus}`,
    `--pids-limit=${spec.pidsLimit}`,
  ];
  if ("seccompProfile" in spec) {
    if (!options.seccompPath) throw new Error(`${entry} needs ${spec.seccompProfile}`);
    args.push("--security-opt", `seccomp=${options.seccompPath}`, "--hostname", spec.hostname);
  }
  for (const [key, target] of Object.entries(spec.volumes)) {
    const volume = options.volumes[key];
    if (!volume) throw new Error(`${entry} needs a "${key}" volume`);
    args.push("-v", `${volume}:${target}`);
  }
  return [...args, ...(options.extra ?? []), image, ...spec.command];
}
