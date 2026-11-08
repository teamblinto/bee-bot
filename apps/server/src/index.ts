import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { Bootstrap, type EngineLane, noRestartExitCodes, PowerSignal } from "@beebot/contracts";

import { createCdpBrowserRuntime } from "./browserCdp.ts";
import { createClaudeRunTurn, createClaudeSummarize, probeEngine, probeUsage } from "./claude.ts";
import { createCodexRunTurn, probeCodex } from "./codex.ts";
import { fakeRunTurn, type RunTurn } from "./engine.ts";
import { pruneEvents } from "./retention.ts";
import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";
import { openVault, readVaultKeyFile } from "./vaultStore.ts";
import { createAwakeClock } from "./watchdog.ts";

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

function parsePower(line: string) {
  try {
    return PowerSignal.safeParse(JSON.parse(line)).data;
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
  const clock = createAwakeClock();
  const claude = createClaudeRunTurn({ command: claudeCommand, dataDir, clock });
  const codex = createCodexRunTurn({ command: codexCommand, dataDir });
  const runTurn: RunTurn = (turn) => {
    if (turn.launch.engineAccountId === "codex") {
      return codex(turn);
    }
    return turn.launch.engineAccountId === "fake" ? fakeRunTurn(turn) : claude(turn);
  };
  const probe = (lane: EngineLane) => probeEngine(claudeCommand, dataDir, lane);
  const vaultKey = bootstrap.vault ?? readVaultKeyFile(process.env);
  if (vaultKey.status === "unavailable") {
    console.error(`beebotd: API keys can't be stored: ${vaultKey.problem}`);
  }
  // The egress proxy reads API keys from here, so none ever enters a box, argv, env or a log.
  const vault = openVault(store.vaultStore, vaultKey);

  // Until boxd runs a sidecar per bot: one Chromium for every bot, for development only.
  const devBrowser = process.env.BEEBOT_DEV_BROWSER_CDP;
  const server = await startServer({
    ...bootstrap,
    store,
    vault,
    clock,
    runTurn,
    probeEngine: probe,
    probeCodex: (lane, onModels) => probeCodex(codexCommand, dataDir, lane, onModels),
    probeUsage: (onModels) => probeUsage(claudeCommand, dataDir, onModels),
    summarize: createClaudeSummarize({
      command: claudeCommand,
      dataDir,
      clock,
      lane: () => store.accountLane("claude"),
    }),
    browserRuntime: devBrowser
      ? createCdpBrowserRuntime(async () => ({
          http: devBrowser,
          downloadsDir: "/home/browser/downloads",
        }))
      : undefined,
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
  return {
    power: server.power,
    stop: async () => {
      clearInterval(pruning);
      await server.close();
      store.close();
    },
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

  stdin.on("line", (line) => {
    if (running) {
      const signal = parsePower(line);
      if (signal) {
        void running.then(({ power }) => power(signal.power));
      }
      return;
    }
    clearTimeout(bootstrapTimer);
    running = start(parseBootstrap(line));
  });

  // The parent holds stdin open for our whole life, so EOF means stop, even if the parent crashed.
  stdin.once("close", () => {
    if (!running) {
      exitWith(noRestartExitCodes.invalidBootstrap, "stdin closed before bootstrap");
    }
    void running.then(({ stop }) => stop()).then(() => process.exit(0));
  });
} else {
  // Headless: no parent holds stdin open, so a signal is the order to stop.
  const running = start(readBootstrapFile(process.argv[fileFlag + 1]));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void running.then(({ stop }) => stop()).then(() => process.exit(0)));
  }
}
