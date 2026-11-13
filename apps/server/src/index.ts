import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import {
  Bootstrap,
  type EngineLane,
  IdleSignal,
  noRestartExitCodes,
  PowerSignal,
} from "@beebot/contracts";

import { boxLayout } from "./boxEngine.ts";
import { startBoxHost, windowsPodman } from "./boxHost.ts";
import { createBoxService, defaultBoxMachine, podmanMachine } from "./boxSetup.ts";
import { createCdpBrowserRuntime } from "./browserCdp.ts";
import { createClaudeRunTurn, createClaudeSummarize, probeEngine, probeUsage } from "./claude.ts";
import { createCodexRunTurn, probeCodex } from "./codex.ts";
import { connectorOfBox } from "./connectorBox.ts";
import { spawnCuaDriver } from "./cuaScreen.ts";
import { fakeRunTurn, type RunTurn } from "./engine.ts";
import { spawnHostDriver } from "./hostScreen.ts";
import { setupPath } from "./hostSetup.ts";
import { pruneEvents } from "./retention.ts";
import { startServer } from "./server.ts";
import { openEventStore } from "./store.ts";
import { openVault, readVaultKeyFile } from "./vaultStore.ts";
import { createAwakeClock } from "./watchdog.ts";

// Setup's installers can finish while Bee Bot runs; this lets it find what they installed.
process.env.PATH = setupPath(process.env.PATH, process.platform, NodeOS.homedir());

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

function parseIdle(line: string) {
  try {
    return IdleSignal.safeParse(JSON.parse(line)).data;
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
  const vaultKey = bootstrap.vault ?? readVaultKeyFile(process.env);
  if (vaultKey.status === "unavailable") {
    console.error(`beebotd: API keys can't be stored: ${vaultKey.problem}`);
  }
  // The egress proxy reads API keys from here, so none ever enters a box, argv, env or a log.
  const vault = openVault(store.vaultStore, vaultKey);

  // Box bots run in boxd's containers in a Podman machine (Windows; see boxdRuntime.ts).
  let port = 0;
  // The per-user Podman installer puts podman.exe on PATH instead of under Program Files.
  const podmanBin =
    process.platform === "win32" && NodeFS.existsSync(windowsPodman) ? windowsPodman : "podman";
  const installDir = "beebot/boxd";
  const machine = podmanMachine(podmanBin, installDir);
  // R7: a box bot's lane, for its turns and its egress alike. Unattended runs without one are
  // refused at admission, so here an attended turn keeps the account's own lane.
  const boxLane = (botId: string, accountLane: EngineLane) => store.boxLane(botId) ?? accountLane;
  const boxes = createBoxService({
    machine: () => store.boxMachine() ?? process.env.BEEBOT_PODMAN_MACHINE ?? defaultBoxMachine,
    probe: machine.probe,
    initMachine: machine.init,
    startMachine: machine.start,
    stopMachine: machine.stop,
    buildImage: machine.buildImage,
    setUpBefore: (name) => store.boxMachineSetUp() === name,
    markSetUp: store.setBoxMachineSetUp,
    startHost: (name) =>
      startBoxHost({
        host: { kind: "podman-machine", podman: podmanBin, machine: name },
        installDir,
        owner: store.environmentId,
        vault,
        account: (botId) => store.getBot(botId)?.engineAccountId,
        egressInput: (botId) => {
          const input = store.egress.egressInput(botId);
          return input && { ...input, lane: boxLane(botId, input.lane) };
        },
        beebotdPort: () => port,
        // A connector's box is no bot's, so it has no row.
        setBox: (botId, state, reason) =>
          connectorOfBox(botId) === undefined && store.boxes.setBox(botId, state, reason),
      }),
  });
  const box = { runtime: boxes.runtime, layout: boxLayout(dataDir) };
  const host = {
    claude: createClaudeRunTurn({ command: claudeCommand, dataDir, clock }),
    codex: createCodexRunTurn({ command: codexCommand, dataDir }),
  };
  // The CLIs as the box sees them, installed into its home by the vendors' installers.
  const boxed = {
    claude: createClaudeRunTurn({ command: ["claude"], dataDir, clock, box }),
    codex: createCodexRunTurn({ command: ["codex"], dataDir, box }),
  };
  const runTurn: RunTurn = async (turn) => {
    if (turn.launch.engineAccountId === "fake") {
      return fakeRunTurn(turn);
    }
    // A box bot never falls back to the host.
    if (store.getBot(turn.launch.botId)?.boundary === "box") {
      const { botId, lane } = turn.launch;
      const launched = { ...turn, launch: { ...turn.launch, lane: boxLane(botId, lane) } };
      return turn.launch.engineAccountId === "codex"
        ? boxed.codex(launched)
        : boxed.claude(launched);
    }
    return turn.launch.engineAccountId === "codex" ? host.codex(turn) : host.claude(turn);
  };
  const probe = (lane: EngineLane) => probeEngine(claudeCommand, dataDir, lane);
  const hostControl = bootstrap.hostControl === true && process.platform === "win32";
  const { cuaDriver } = bootstrap;
  if (hostControl && !cuaDriver) {
    console.error("beebotd: no cua-driver, so bots on This PC move the owner's own pointer");
  }
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
    box,
    boxes,
    browserRuntime: createCdpBrowserRuntime(boxes.sidecar),
    // This executable is the desktop app's own (ELECTRON_RUN_AS_NODE), so its windows are Bee Bot's.
    hostDriver: hostControl
      ? () => spawnHostDriver(NodePath.join(dataDir, "runtime"), process.execPath)
      : undefined,
    cuaDriver: hostControl && cuaDriver ? () => spawnCuaDriver(cuaDriver) : undefined,
  });
  port = server.port;
  void boxes.refresh();
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
    idle: server.idle,
    stop: async () => {
      clearInterval(pruning);
      await server.close();
      await boxes.close();
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
      const idle = parseIdle(line);
      if (idle) {
        void running.then((server) => server.idle(idle.idleSeconds));
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
