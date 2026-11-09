import * as NodeFs from "node:fs";
import * as NodeTimers from "node:timers/promises";

const exitWaitMs = 10_000;
const pollMs = 100;

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A PID left in the file can belong to anything after a reboot, so only a boxd is ever stopped.
function runsBoxd(pid: number) {
  try {
    return NodeFs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("main.ts");
  } catch {
    return false;
  }
}

async function stop(pid: number) {
  process.kill(pid, "SIGTERM");
  for (let waited = 0; waited < exitWaitMs; waited += pollMs) {
    if (!alive(pid)) {
      return;
    }
    await NodeTimers.setTimeout(pollMs);
  }
  process.kill(pid, "SIGKILL");
}

// Only the newest boxd on a machine runs. The server that just launched it owns the machine; an
// older one, whose server is gone but whose ssh session has not yet closed, would otherwise fight
// it for the egress proxy until one of them exits.
export async function becomeOnlyBoxd(path: string, isBoxd = runsBoxd) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      NodeFs.writeFileSync(path, String(process.pid), { flag: "wx" });
      process.on("exit", () => {
        if (NodeFs.readFileSync(path, "utf8") === String(process.pid)) {
          NodeFs.rmSync(path, { force: true });
        }
      });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const holder = Number(NodeFs.readFileSync(path, "utf8"));
    if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && alive(holder)) {
      if (!isBoxd(holder)) {
        NodeFs.rmSync(path, { force: true });
        continue;
      }
      await stop(holder);
    }
    NodeFs.rmSync(path, { force: true });
  }
  throw new Error("could not become the only boxd");
}
