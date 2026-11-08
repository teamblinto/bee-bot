import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const entry = NodePath.join(import.meta.dirname, "..", "index.ts");

// A cold start loads every module from source, which takes seconds on a loaded machine, so a test
// that spawns the daemon gets this long. Readiness is the daemon's own "listening" line.
export const daemonTestTimeoutMs = 60_000;

// The real `beebotd` on plain Node. The bootstrap goes in on stdin, or through `file` the headless
// way; a string goes in as written. With port 0 it picks its own port, so two never collide.
export function spawnBeebotd(
  bootstrap: object | string,
  { env = {}, file }: { env?: NodeJS.ProcessEnv; file?: string } = {},
) {
  const line = typeof bootstrap === "string" ? bootstrap : JSON.stringify(bootstrap);
  if (file) {
    NodeFS.writeFileSync(file, line);
  }
  const child = NodeChildProcess.spawn(
    process.execPath,
    file ? [entry, "--bootstrap", file] : [entry],
    // A machine named in the developer's shell would start real boxes.
    { env: { ...process.env, BEEBOT_PODMAN_MACHINE: "beebot-test-no-machine", ...env } },
  );
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  let output = "";
  const listening = new Promise<number>((resolve, reject) => {
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(output)?.[1];
      if (port) {
        resolve(Number(port));
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    void exited.then((code) => reject(new Error(`beebotd exited with ${code}: ${output}`)));
  });
  // Not every test waits for it.
  listening.catch(() => {});
  if (!file) {
    child.stdin.write(`${line}\n`);
  }
  return {
    child,
    listening,
    exited,
    output: () => output,
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exited;
      }
    },
  };
}
