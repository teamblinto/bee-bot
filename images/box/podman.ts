import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const windowsPodman = "C:\\Program Files\\RedHat\\Podman\\podman.exe";
export const podmanBin =
  process.platform === "win32" && existsSync(windowsPodman) ? windowsPodman : "podman";

// `podman machine ssh` runs the first `ssh` on PATH with `UserKnownHostsFile=NUL`; the MSYS ssh from
// Git for Windows writes that to a file called NUL, so Windows' own OpenSSH goes first.
function podmanEnv() {
  if (process.platform !== "win32") {
    return process.env;
  }
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "Path";
  const openSsh = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\OpenSSH`;
  return { ...process.env, [key]: `${openSsh};${process.env[key] ?? ""}` };
}

export type PodmanResult = { code: number | null; stdout: string; stderr: string };

export function podman(args: string[], input?: string): Promise<PodmanResult> {
  return new Promise((resolve) => {
    const child = spawn(podmanBin, args, { env: podmanEnv(), windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => resolve({ code: null, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

export async function podmanOk(args: string[], input?: string) {
  const result = await podman(args, input);
  if (result.code !== 0) {
    throw new Error(`podman ${args.join(" ")} exited ${result.code}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export const imageDir = import.meta.dirname;

export function buildArgs(tag: string, labels: string[] = []) {
  return ["build", ...labels.flatMap((label) => ["--label", label]), "-t", tag, imageDir];
}
