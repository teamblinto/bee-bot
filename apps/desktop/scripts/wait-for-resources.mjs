import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

function tcpPortIsReady({ host, port, connectTimeoutMs = 500 }) {
  return new Promise((resolveReady) => {
    const socket = NodeNet.createConnection({ host, port });

    const finish = (ready) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveReady(ready);
    };

    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.setTimeout(connectTimeoutMs);
  });
}

export async function waitForResources({
  baseDir,
  files,
  tcpHost,
  tcpPort,
  intervalMs = 100,
  timeoutMs = 120_000,
}) {
  const startedAt = Date.now();

  while (true) {
    const pending = files.filter((file) => !NodeFS.existsSync(NodePath.resolve(baseDir, file)));
    if (!(await tcpPortIsReady({ host: tcpHost, port: tcpPort }))) {
      pending.push(`tcp:${tcpHost}:${tcpPort}`);
    }

    if (pending.length === 0) {
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Timed out waiting for desktop dev resources after ${timeoutMs}ms: ${pending.join(", ")}`,
      );
    }

    await NodeTimersPromises.setTimeout(intervalMs);
  }
}
