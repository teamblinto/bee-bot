import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// shortcut: shell-form COPY/ADD only, no JSON-array form or heredocs; add them if the Containerfile uses them.
export function copySources(containerfile: string) {
  return containerfile
    .replaceAll(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      ([instruction, ...args]) =>
        /^(COPY|ADD)$/i.test(instruction ?? "") && !args.some((arg) => arg.startsWith("--from=")),
    )
    .flatMap(([, ...args]) => args.filter((arg) => !arg.startsWith("--")).slice(0, -1));
}

// What a build of `dir` would miss: its Containerfile, or anything that file COPYs.
export function missingSources(dir: string) {
  const containerfile = join(dir, "Containerfile");
  if (!existsSync(containerfile)) {
    return ["Containerfile"];
  }
  return copySources(readFileSync(containerfile, "utf8")).filter(
    (source) => !existsSync(join(dir, source)),
  );
}
