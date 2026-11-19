import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import type { Duplex } from "node:stream";

import {
  Bootstrap,
  DesktopError,
  DesktopUsage,
  type EngineLane,
  IdleSignal,
  noRestartExitCodes,
  PowerSignal,
} from "@beebot/contracts";

import { cellLimits } from "./admission.ts";
import {
  captureError,
  reportError,
  shutdownAnalytics,
  startAnalytics,
  trackUnchecked,
} from "./analytics.ts";
import { boxLayout } from "./boxEngine.ts";
import { startBoxHost, windowsPodman } from "./boxHost.ts";
import { createBoxService, defaultBoxMachine, nativePodman, podmanMachine } from "./boxSetup.ts";
import { createCdpBrowserRuntime } from "./browserCdp.ts";
import { createClaudeRunTurn, createClaudeSummarize, probeEngine, probeUsage } from "./claude.ts";
import { createCodexRunTurn, probeCodex } from "./codex.ts";
import { connectorOfBox } from "./connectorBox.ts";
import { spawnCuaDriver } from "./cuaScreen.ts";
import { fakeRunTurn, type RunTurn } from "./engine.ts";
import { spawnHostDriver } from "./hostScreen.ts";
import { setupPath } from "./hostSetup.ts";
import { logJson } from "./jsonLog.ts";
import { pruneEvents } from "./retention.ts";
import { startServer } from "./server.ts";
import { engineChecked, trackUsage } from "./usageEvents.ts";
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

// The desktop's usage events and main-process errors, sent on only if the owner allowed it.
function forwardDesktop(line: string) {
  try {
    const json: unknown = JSON.parse(line);
    const usage = DesktopUsage.safeParse(json).data?.usage;
    if (usage) {
      trackUnchecked(usage.event, usage.properties);
    }
    const error = DesktopError.safeParse(json).data?.error;
    if (error) {
      reportError(error);
    }
  } catch {
    // Not JSON: nothing to forward.
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

type Cell = {
  socketFd: number;
  publicOrigin: string;
  maxActiveBoxes: number;
  monthlyBudgetUsd: number | null;
};

// Server mode: one beebotd per user on a Linux host, reached only through `socketFd`.
async function boot(bootstrap: Bootstrap, cell?: Cell) {
  const serverMode = cell !== undefined;
  const store = openStore(bootstrap.dataDir);
  if (bootstrap.telemetry) {
    startAnalytics({
      ...bootstrap.telemetry,
      environmentId: store.environmentId,
      consent: () => store.usageData() === true,
    });
  }
  const { claudeCommand = ["claude"], codexCommand = ["codex"], dataDir } = bootstrap;
  wipeRuntime(dataDir);
  const clock = createAwakeClock();
  const vaultKey = bootstrap.vault ?? readVaultKeyFile(process.env);
  if (vaultKey.status === "unavailable") {
    console.error(`beebotd: API keys can't be stored: ${vaultKey.problem}`);
  }
  // The egress proxy reads API keys from here, so none ever enters a box, argv, env or a log.
  const vault = openVault(store.vaultStore, vaultKey);

  // The server's relay for boxes, set once it listens; boxes refresh only after that.
  let relay: (() => Duplex) | undefined;
  // Box bots run in boxd's containers in a Podman machine (Windows; see boxdRuntime.ts).
  // The per-user Podman installer puts podman.exe on PATH instead of under Program Files.
  const podmanBin =
    process.platform === "win32" && NodeFS.existsSync(windowsPodman) ? windowsPodman : "podman";
  const installDir = "beebot/boxd";
  const machine = serverMode ? nativePodman("podman") : podmanMachine(podmanBin, installDir);
  // R7: a box bot's lane, for its turns and its egress alike. Unattended runs without one are
  // refused at admission, so here an attended turn keeps the account's own lane.
  const boxLane = (botId: string, accountLane: EngineLane) => store.boxLane(botId) ?? accountLane;
  const boxes = createBoxService({
    machine: () =>
      serverMode
        ? "native"
        : (store.boxMachine() ?? process.env.BEEBOT_PODMAN_MACHINE ?? defaultBoxMachine),
    probe: machine.probe,
    initMachine: machine.init,
    startMachine: machine.start,
    stopMachine: machine.stop,
    buildImage: machine.buildImage,
    setUpBefore: (name) => store.boxMachineSetUp() === name,
    markSetUp: store.setBoxMachineSetUp,
    startHost: (name) =>
      startBoxHost({
        host: serverMode
          ? { kind: "native", node: process.execPath }
          : { kind: "podman-machine", podman: podmanBin, machine: name },
        installDir,
        owner: store.environmentId,
        vault,
        account: (botId) => store.getBot(botId)?.engineAccountId,
        egressInput: (botId) => {
          const input = store.egress.egressInput(botId);
          return input && { ...input, lane: boxLane(botId, input.lane) };
        },
        relay: () => relay?.(),
        maxActive: cell?.maxActiveBoxes,
        boxIds: () => store.boxes.listBoxes().map(({ botId }) => botId),
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
    if (serverMode) {
      throw new Error("only box bots run in server mode");
    }
    return turn.launch.engineAccountId === "codex" ? host.codex(turn) : host.claude(turn);
  };
  const probe = async (lane: EngineLane) => {
    const status = await probeEngine(claudeCommand, dataDir, lane);
    trackUsage(engineChecked("claude", status));
    return status;
  };
  const hostControl = !serverMode && bootstrap.hostControl === true && process.platform === "win32";
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
    // Server mode never runs a CLI on the host: its login, limits and models are nobody's there.
    // `unknown` blocks nothing, since each box run checks its own login.
    probeEngine: serverMode
      ? async () => ({
          cliFound: true,
          version: null,
          auth: "unknown",
          email: null,
          pauseReason: null,
        })
      : probe,
    probeCodex: serverMode
      ? undefined
      : (lane, onModels) => probeCodex(codexCommand, dataDir, lane, onModels),
    probeUsage: serverMode ? undefined : (onModels) => probeUsage(claudeCommand, dataDir, onModels),
    summarize: serverMode
      ? undefined
      : createClaudeSummarize({
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
    serverMode,
    ...cell,
  });
  relay = server.relay;
  void boxes.refresh();
  if (cell) {
    console.info("beebotd: listening on the socket from systemd");
  } else {
    console.error(`beebotd: listening on 127.0.0.1:${server.port}`);
    const { pauseReason } = await probe(store.accountLane("claude"));
    if (pauseReason) {
      console.error(`beebotd: Claude bots paused: ${pauseReason}`);
      store.pauseReadyBots("claude", pauseReason);
    }
    server.refreshLimits();
    await server.checkCodex();
  }
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
      await shutdownAnalytics();
      store.close();
    },
  };
}

async function crash(error: unknown) {
  captureError(error);
  await shutdownAnalytics();
  process.exit(1);
}

// Node would print the error and exit 1 by itself; the report goes out first. The desktop restarts us.
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (error: unknown) => {
    console.error(error);
    void crash(error);
  });
}

function start(bootstrap: Bootstrap | undefined, cell?: Cell) {
  if (!bootstrap) {
    exitWith(noRestartExitCodes.invalidBootstrap, "invalid bootstrap");
  }
  const running = boot(bootstrap, cell);
  running.catch(async (error: unknown) => {
    console.error(error);
    await crash(error);
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

// The origin alone, as browsers send it: scheme, host and port, no path or trailing slash.
const isOrigin = (value: string) => URL.parse(value)?.origin === value;

// Fails closed: without its own vault key, its public origin and the socket systemd made for it
// a cell never starts.
function serverBootstrap({
  BEEBOT_DATA_DIR: dataDir,
  BEEBOT_PUBLIC_ORIGIN: publicOrigin,
  CREDENTIALS_DIRECTORY: credentials,
  LISTEN_FDS: listenFds,
  LISTEN_PID: listenPid,
  ...env
}: NodeJS.ProcessEnv) {
  // Not passed on: a child would take the socket as handed to it.
  delete process.env.LISTEN_FDS;
  delete process.env.LISTEN_PID;
  delete process.env.LISTEN_FDNAMES;
  if (!dataDir || !publicOrigin || !isOrigin(publicOrigin)) {
    return exitWith(
      noRestartExitCodes.invalidBootstrap,
      "server mode needs BEEBOT_DATA_DIR and an origin in BEEBOT_PUBLIC_ORIGIN",
    );
  }
  const limits = cellLimits(env);
  if ("error" in limits) {
    return exitWith(noRestartExitCodes.invalidBootstrap, limits.error);
  }
  const vault = readVaultKeyFile({
    BEEBOT_VAULT_KEY_FILE: credentials && NodePath.join(credentials, "vault-key"),
  });
  if (vault.status !== "ready") {
    return exitWith(
      noRestartExitCodes.invalidBootstrap,
      `no vault key at $CREDENTIALS_DIRECTORY/vault-key (${vault.problem})`,
    );
  }
  // sd_listen_fds(3): systemd hands over one socket, at fd 3, to this very process.
  if (listenFds !== "1" || listenPid !== String(process.pid)) {
    return exitWith(
      noRestartExitCodes.invalidBootstrap,
      "server mode listens only on the socket systemd passes it (beebotd@.socket)",
    );
  }
  // The token guards only the TCP listener, which server mode never opens.
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  const bootstrap: Bootstrap = { port: 0, token, dataDir, allowedOrigins: [], vault };
  return { bootstrap, cell: { socketFd: 3, publicOrigin, ...limits } };
}

const fileFlag = process.argv.indexOf("--bootstrap", 2);

if (process.env.BEEBOT_SERVER_MODE === "1") {
  logJson();
  const { bootstrap, cell } = serverBootstrap(process.env);
  const running = start(bootstrap, cell);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void running.then(({ stop }) => stop()).then(() => process.exit(0)));
  }
} else if (fileFlag === -1) {
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
      // After boot, so the owner's setting has been read.
      void running.then(() => forwardDesktop(line));
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
