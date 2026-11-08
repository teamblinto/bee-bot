import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const windowsPodman = "C:\\Program Files\\RedHat\\Podman\\podman.exe";
export const podmanBin =
  process.platform === "win32" && existsSync(windowsPodman) ? windowsPodman : "podman";

export type PodmanResult = { code: number | null; stdout: string; stderr: string };

export function podman(args: string[], input?: string): Promise<PodmanResult> {
  return new Promise((resolve) => {
    const child = spawn(podmanBin, args, { windowsHide: true });
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
