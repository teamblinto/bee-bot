import * as NodeReadline from "node:readline";

import { Bootstrap, noRestartExitCodes } from "@beebot/contracts";

import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";

const bootstrapTimeoutMs = 5000;
const retainedEvents = 1000;

function exitWith(code: number, reason: string): never {
  console.error(`beebotd: ${reason}`);
  process.exit(code);
}

// The bootstrap holds the token and JSON errors quote their input, so never print them.
function parseBootstrap(line: string) {
  try {
    return Bootstrap.safeParse(JSON.parse(line)).data;
  } catch {
    return undefined;
  }
}

function openStore(dataDir: string) {
  try {
    const store = openEventStore(dataDir);
    store.prune(retainedEvents);
    return store;
  } catch (error) {
    console.error(error);
    return exitWith(noRestartExitCodes.storageFailed, "could not open the database");
  }
}

async function boot(bootstrap: Bootstrap) {
  const store = openStore(bootstrap.dataDir);
  const server = await startServer({ ...bootstrap, store });
  console.error(`beebotd: listening on 127.0.0.1:${server.port}`);
  return async () => {
    await server.close();
    store.close();
  };
}

const bootstrapTimer = setTimeout(
  () => exitWith(noRestartExitCodes.invalidBootstrap, "no bootstrap on stdin"),
  bootstrapTimeoutMs,
);

let running: ReturnType<typeof boot> | undefined;
const stdin = NodeReadline.createInterface({ input: process.stdin });

stdin.once("line", (line) => {
  clearTimeout(bootstrapTimer);
  const bootstrap = parseBootstrap(line);
  if (!bootstrap) {
    exitWith(noRestartExitCodes.invalidBootstrap, "invalid bootstrap");
  }
  running = boot(bootstrap);
  running.catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
});

// The parent holds stdin open for our whole life, so EOF means stop, even if the parent crashed.
stdin.once("close", () => {
  if (!running) {
    exitWith(noRestartExitCodes.invalidBootstrap, "stdin closed before bootstrap");
  }
  void running.then((stop) => stop()).then(() => process.exit(0));
});
