import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { Bootstrap, type EngineLane, noRestartExitCodes } from "@beebot/contracts";

import { createClaudeRunTurn, probeEngine, probeUsage } from "./claude.ts";
import { createCodexRunTurn, probeCodex } from "./codex.ts";
import { fakeRunTurn, type RunTurn } from "./engine.ts";
import { pruneEvents } from "./retention.ts";
import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";

const bootstrapTimeoutMs = 5000;
const pruneEveryMs = 24 * 60 * 60_000;

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
    pruneEvents(store);
    return store;
  } catch (error) {
    console.error(error);
    return exitWith(noRestartExitCodes.storageFailed, "could not open the database");
  }
}

// A crash skips each turn's own cleanup, and these files hold tokens.
function wipeRuntime(dataDir: string) {
  try {
    NodeFS.rmSync(NodePath.join(dataDir, "runtime"), { recursive: true, force: true });
  } catch (error) {
    // Only the code: the error's message and path name the owner's files.
    console.error(
      `beebotd: could not clear runtime files: ${(error as NodeJS.ErrnoException).code}`,
    );
  }
}

async function boot(bootstrap: Bootstrap) {
  const store = openStore(bootstrap.dataDir);
  const { claudeCommand = ["claude"], codexCommand = ["codex"], dataDir } = bootstrap;
  wipeRuntime(dataDir);
  const claude = createClaudeRunTurn({ command: claudeCommand, dataDir });
  const codex = createCodexRunTurn({ command: codexCommand, dataDir });
  const runTurn: RunTurn = (turn) => {
    if (turn.launch.engineAccountId === "codex") {
      return codex(turn);
    }
    return turn.launch.engineAccountId === "fake" ? fakeRunTurn(turn) : claude(turn);
  };
  const probe = (lane: EngineLane) => probeEngine(claudeCommand, dataDir, lane);
  const server = await startServer({
    ...bootstrap,
    store,
    runTurn,
    probeEngine: probe,
    probeCodex: (lane, onModels) => probeCodex(codexCommand, dataDir, lane, onModels),
    probeUsage: (onModels) => probeUsage(claudeCommand, dataDir, onModels),
  });
  console.error(`beebotd: listening on 127.0.0.1:${server.port}`);
  const { pauseReason } = await probe(store.accountLane("claude"));
  if (pauseReason) {
    console.error(`beebotd: Claude bots paused: ${pauseReason}`);
    store.pauseReadyBots("claude", pauseReason);
  }
  server.refreshLimits();
  await server.checkCodex();
  const pruning = setInterval(() => {
    try {
      pruneEvents(store);
    } catch (error) {
      console.error(`beebotd: event pruning failed: ${(error as Error)?.name}`);
    }
  }, pruneEveryMs);
  return async () => {
    clearInterval(pruning);
    await server.close();
    store.close();
  };
}

function start(bootstrap: Bootstrap | undefined) {
  if (!bootstrap) {
    exitWith(noRestartExitCodes.invalidBootstrap, "invalid bootstrap");
  }
  const running = boot(bootstrap);
  running.catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
  return running;
}

function readBootstrapFile(path: string | undefined) {
  try {
    return path === undefined ? undefined : parseBootstrap(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const fileFlag = process.argv.indexOf("--bootstrap", 2);

if (fileFlag === -1) {
  const bootstrapTimer = setTimeout(
    () => exitWith(noRestartExitCodes.invalidBootstrap, "no bootstrap on stdin"),
    bootstrapTimeoutMs,
  );

  let running: ReturnType<typeof boot> | undefined;
  const stdin = NodeReadline.createInterface({ input: process.stdin });

  stdin.once("line", (line) => {
    clearTimeout(bootstrapTimer);
    running = start(parseBootstrap(line));
  });

  // The parent holds stdin open for our whole life, so EOF means stop, even if the parent crashed.
  stdin.once("close", () => {
    if (!running) {
      exitWith(noRestartExitCodes.invalidBootstrap, "stdin closed before bootstrap");
    }
    void running.then((stop) => stop()).then(() => process.exit(0));
  });
} else {
  // Headless: no parent holds stdin open, so a signal is the order to stop.
  const running = start(readBootstrapFile(process.argv[fileFlag + 1]));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void running.then((stop) => stop()).then(() => process.exit(0)));
  }
}
