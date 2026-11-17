import * as NodeCrypto from "node:crypto";
import { createReadStream } from "node:fs";
import * as NodeFS from "node:fs/promises";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Duplex } from "node:stream";

import {
  type Bot,
  type Bootstrap,
  ClientMessage,
  Command,
  defaultBotModel,
  type Effort,
  type EngineLane,
  type EngineModel,
  EngineStatus,
  type ModelCatalog,
  type ProtocolNotice,
  protocolVersion,
  type ServerInfo,
  type ServerMessage,
  setupCommand,
  usageDays,
  type UsageRefreshResult,
} from "@beebot/contracts";
import { type WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

import serverPackage from "../package.json" with { type: "json" };
import { reportError, track } from "./analytics.ts";
import { createApprovals, type Execute } from "./approvals.ts";
import {
  botCreated,
  botEngineChanged,
  commandFailed,
  connectorAdded,
  engineChecked,
  messageSent,
  routineCreated,
  trackUsage,
  usageOf,
  worksOnChanged,
} from "./usageEvents.ts";
import {
  attachmentMime,
  attachmentName,
  attachmentPath,
  attachmentsDir,
  maxAttachmentBytes,
  receiveAttachment,
  unclaimedAttachmentMs,
} from "./attachments.ts";
import type { BoxOptions } from "./boxEngine.ts";
import { preToolUsePath, staticClaudeModels } from "./claude.ts";
import { staticCodexModels } from "./codex.ts";
import { fakeRunTurn, type RunTurn, workingFolder, workspacePath } from "./engine.ts";
import { callBotTool } from "./botTools.ts";
import { type Decide, decide as policyDecide } from "./broker.ts";
import { boxExecutors } from "./boxExecutors.ts";
import type { BoxService } from "./boxSetup.ts";
import {
  browserExecutors,
  createBrowserBroker,
  noBrowser,
  serveHandoff,
  storeBrowserDeps,
} from "./browser.ts";
import {
  boxScreen,
  computerExecutors,
  createComputer,
  hasBoxDesktop,
  type Screen,
} from "./computer.ts";
import {
  createCuaScreen,
  type CuaDriver,
  cuaExecutors,
  cuaToolNames,
  type IdleReading,
} from "./cuaScreen.ts";
import { createHostScreen, type HostDriver, hostAvailability } from "./hostScreen.ts";
import { hostPlatform, openSetupTerminal } from "./hostSetup.ts";
import {
  createDesktopControl,
  createDisplayTickets,
  maxDisplayClientBytes,
  serveDisplay,
} from "./display.ts";
import { ownerEgressHosts } from "./egress.ts";
import { answerPreToolUse } from "./hooks.ts";
import type { BrowserRuntime } from "./browserRuntime.ts";
import { answerConnectors, answerMcp, toolsFor, sendJson } from "./mcp.ts";
import { createConnectorHub } from "./connectorHub.ts";
import { connectorBoxId } from "./connectorBox.ts";
import { oauthCallbackPath } from "./connectorOauth.ts";
import {
  envProblem,
  headersProblem,
  oauthName,
  parseMcpServers,
  parseSecret,
  type Secret,
  secretName,
  urlProblem,
} from "./connectors.ts";
import { callMemoryTool, readTeamMemoryFiles, teamMemoryDir } from "./memory.ts";
import { checkProjectFolder } from "./pathPolicy.ts";
import { auditQuery, gateTool } from "./policy.ts";
import { scheduleProblem } from "./routines.ts";
import { prepareSkill, readSkillFolder } from "./skills.ts";
import { createThumbnails, type Thumbnail } from "./thumbnails.ts";
import type { EventStore } from "./store.ts";
import { fallbackSummary, type Summarize } from "./summary.ts";
import type { Vault } from "./vault.ts";
import { deleteApiKey, openVault, storeApiKey, VaultError } from "./vaultStore.ts";
import { createSupervisor } from "./supervisor.ts";
import { createTerminals } from "./terminal.ts";
import {
  createLimitRefresher,
  createUsageHistory,
  projectFolder,
  type UsageProbe,
} from "./usage.ts";
import { type AwakeClock, awakeTimeout, createAwakeClock } from "./watchdog.ts";

const ConnectorPayload = z.object({ input: z.record(z.string(), z.unknown()) });

// The page the owner's browser lands on after signing in. Nothing in it comes from the URL.
function sendPage(response: NodeHttp.ServerResponse, status: number, text: string) {
  const escaped = text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Bee Bot</title>` +
      `<body style="font:16px system-ui;margin:4rem auto;max-width:32rem;padding:0 1rem">` +
      `<p>${escaped}</p></body>`,
  );
}

// A pasted SKILL.md may be 256 KB before JSON escapes it.
const maxBodyBytes = 1024 * 1024;
const maxBufferedWallBytes = 1_000_000;
// A `Write` call carries the whole file.
const maxMcpBodyBytes = 16 * 1024 * 1024;

type Options = Pick<Bootstrap, "port" | "token" | "dataDir" | "allowedOrigins" | "fakeEngine"> & {
  store: EventStore;
  vault?: Vault | undefined;
  probeEngine: (lane: EngineLane) => Promise<EngineStatus>;
  probeCodex?:
    | ((lane: EngineLane, onModels: (models: EngineModel[]) => void) => Promise<EngineStatus>)
    | undefined;
  runTurn?: RunTurn;
  probeUsage?: ((onModels: (models: EngineModel[]) => void) => Promise<UsageProbe>) | undefined;
  summarize?: Summarize | undefined;
  // Where Claude Code keeps its transcripts.
  projectsDir?: string | undefined;
  usageRefreshGapMs?: number | undefined;
  turnTimeoutMs?: number | undefined;
  approvalTimeoutMs?: number | undefined;
  continuationTtlMs?: number | undefined;
  decide?: Decide | undefined;
  executors?: ReadonlyMap<string, Execute> | undefined;
  mcpKeepaliveMs?: number | undefined;
  heartbeatMs?: number | undefined;
  clock?: AwakeClock | undefined;
  // Box mode: the login terminal attaches through it.
  box?: BoxOptions | undefined;
  // Setting boxes up and whether they can run. Without it, `box` alone means they can.
  boxes?: BoxService | undefined;
  browserRuntime?: BrowserRuntime | undefined;
  // Only the desktop app's server on Windows gets it: `host` bots drive this desktop through it.
  hostDriver?: (() => Promise<HostDriver>) | undefined;
  // With it too, they act in the background through cua-driver, and fall back on `hostDriver`.
  cuaDriver?: (() => Promise<CuaDriver>) | undefined;
};

function refuseUpgrade(socket: Duplex, status: number, body: unknown) {
  const text = JSON.stringify(body);
  socket.end(
    `HTTP/1.1 ${status} ${NodeHttp.STATUS_CODES[status]}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(text)}\r\n` +
      "Connection: close\r\n\r\n" +
      text,
  );
}

function send(socket: WebSocket, message: ServerMessage) {
  socket.send(JSON.stringify(message));
}

function parseClientMessage(text: string) {
  try {
    return ClientMessage.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

// Past the cap the stream is still drained: abandoning it would destroy the socket and the answer.
async function readBody(request: NodeHttp.IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= maxBytes) {
      chunks.push(chunk);
    }
  }
  return size <= maxBytes ? Buffer.concat(chunks).toString() : undefined;
}

function parseCommand(text: string | undefined) {
  try {
    return Command.safeParse(JSON.parse(text ?? "")).data;
  } catch {
    return undefined;
  }
}

function logSummaryFailure(error: unknown) {
  console.error(`beebotd: summary failed: ${(error as Error)?.name}`);
}

function logUsageFailure(error: unknown) {
  console.error(`beebotd: usage check failed: ${(error as Error)?.name}`);
}

export async function startServer({
  port,
  token,
  dataDir,
  allowedOrigins,
  fakeEngine = false,
  store,
  vault = openVault(store.vaultStore, { status: "unavailable", problem: "no_key" }),
  probeEngine,
  probeCodex,
  runTurn = fakeRunTurn,
  probeUsage,
  summarize,
  projectsDir = NodePath.join(NodeOS.homedir(), ".claude", "projects"),
  usageRefreshGapMs,
  turnTimeoutMs,
  approvalTimeoutMs,
  continuationTtlMs,
  decide,
  executors,
  mcpKeepaliveMs,
  heartbeatMs = 30_000,
  clock = createAwakeClock(),
  box,
  boxes,
  browserRuntime = noBrowser,
  hostDriver,
  cuaDriver,
}: Options) {
  const boxesReady = () => (boxes ? boxes.ready() : box !== undefined);
  // Clients whose window can be seen. Electron's main process subscribes too, but never shows.
  const visibleClients = new Set<WebSocket>();
  const host =
    hostDriver &&
    createHostScreen({
      start: hostDriver,
      busy: store.botBusy,
      watched: () => visibleClients.size > 0,
      consented: store.policy.hostConsented,
    });
  const hostControl = () => hostAvailability(host !== undefined, host?.held() ?? false);
  // From the desktop, about once a second.
  let ownerIdle: IdleReading | undefined;
  const cua =
    host &&
    cuaDriver &&
    createCuaScreen({
      start: cuaDriver,
      refuse: (run) => host.screen.refuse?.(run),
      check: (run, tool, args) => store.policy.check(run, tool, args, decide ?? policyDecide),
      appendAudit: store.appendAudit,
      requestApproval: (run, tool, args) => approvals.requestApproval(run, tool, args),
      idle: () => ownerIdle,
      ownApp: NodePath.basename(process.execPath),
      ownPids: [process.pid, process.ppid],
    });
  // The screen a bot's control mode names: its box's desktop, or the owner's own.
  function screenOf(botId: string): Screen | undefined {
    const bot = store.getBot(botId);
    if (bot?.control === "host") {
      return hostControl().available ? host?.screen : undefined;
    }
    if (!boxes?.ready() || !hasBoxDesktop(bot)) {
      return undefined;
    }
    const { runtime } = boxes;
    return {
      kind: "box",
      size: boxScreen,
      screenshot: () => runtime.screenshot(botId),
      input: (actions, signal) => runtime.input(botId, actions, signal),
    };
  }
  const terminals = box && createTerminals({ ...box, dataDir, bot: (id) => store.getBot(id) });
  const expectedToken = Buffer.from(token);
  const subscribers = new Set<WebSocket>();
  let claudeModels = staticClaudeModels;
  let codexModels = staticCodexModels;
  let codexProbing = false;

  const catalog = (): ModelCatalog => ({
    claude: claudeModels,
    codex: codexModels,
    ...(fakeEngine && { fake: staticClaudeModels }),
  });
  function modelsOf(accountId: string) {
    if (accountId === "codex") {
      return codexModels;
    }
    return accountId === "claude" ? claudeModels : staticClaudeModels;
  }

  function setClaudeModels(models: EngineModel[]) {
    if (JSON.stringify(models) !== JSON.stringify(claudeModels)) {
      claudeModels = models;
      broadcast({ type: "model-catalog", models: catalog() });
    }
  }

  function setCodexModels(models: EngineModel[]) {
    if (JSON.stringify(models) !== JSON.stringify(codexModels)) {
      codexModels = models;
      broadcast({ type: "model-catalog", models: catalog() });
    }
  }

  // A saved model that left the catalog is still the bot's: only a change to one is refused.
  function engineChoice(
    bot: Pick<Bot, "model" | "effort" | "engineAccountId">,
    change: {
      engineAccountId?: string | undefined;
      model?: string | undefined;
      effort?: Effort | null | undefined;
    },
  ) {
    if (change.engineAccountId && change.engineAccountId !== bot.engineAccountId) {
      return { refused: { status: 409, body: { code: "provider_locked" } } };
    }
    const model = change.model ?? bot.model;
    const entry = modelsOf(bot.engineAccountId).find(({ id }) => id === model);
    if (!entry && model !== bot.model) {
      return { refused: { status: 400, body: { code: "unknown_model" } } };
    }
    if (change.effort && !entry?.efforts.includes(change.effort)) {
      return { refused: { status: 400, body: { code: "unsupported_effort" } } };
    }
    // Moving to a model without the current level leaves the choice to the CLI.
    const kept = bot.effort && entry?.efforts.includes(bot.effort) ? bot.effort : null;
    return { model, effort: change.effort === undefined ? kept : change.effort };
  }

  // Only a new value is checked: a saved folder that has gone must not stop the owner editing the bot.
  function projectChoice(proposed: string | null | undefined, current: string | null) {
    if (proposed === undefined || proposed === current) {
      return { projectPath: current };
    }
    if (proposed === null) {
      return { projectPath: null };
    }
    const context = { home: NodeOS.homedir(), dataDir, platform: process.platform };
    const { real, refused } = checkProjectFolder(proposed, context);
    return real === undefined
      ? { refused: { status: 400, body: { code: refused } } }
      : { projectPath: real };
  }

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const handoffSockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const displaySockets = new WebSocketServer({
    noServer: true,
    maxPayload: maxDisplayClientBytes,
  });
  const displayTickets = createDisplayTickets();
  const desktop = createDesktopControl((botId, leaseId) => {
    computer.interrupt(botId);
    return boxes && hasBoxDesktop(store.getBot(botId)) ? boxes.control(botId, leaseId) : undefined;
  });
  const browser = createBrowserBroker({
    runtime: browserRuntime,
    ...storeBrowserDeps(store),
    desktop,
    check: (run, tool, args) => store.policy.check(run, tool, args, decide ?? policyDecide),
    requestApproval: (run, tool, args) => approvals.requestApproval(run, tool, args),
    activity: (botId, activity) => broadcast({ type: "activity", botId, ...activity }),
  });
  const computer = createComputer({
    screen: screenOf,
    check: (run, tool, args) => store.policy.check(run, tool, args, decide ?? policyDecide),
    appendAudit: store.appendAudit,
    requestApproval: (run, tool, args) => approvals.requestApproval(run, tool, args),
    lease: browser.lease,
    observed: browser.observed,
    activity: (botId, activity) => broadcast({ type: "activity", botId, ...activity }),
  });

  // Only the wall's watchers get its messages. A slow one misses thumbnails rather than queueing them.
  const wallViewers = new Set<WebSocket>();
  function toWall(message: ServerMessage) {
    for (const viewer of wallViewers) {
      if (message.type !== "thumbnail" || viewer.bufferedAmount < maxBufferedWallBytes) {
        send(viewer, message);
      }
    }
  }
  const thumbnailMessage = ({ botId, data, at }: Thumbnail): ServerMessage => ({
    type: "thumbnail",
    botId,
    mime: "image/jpeg",
    data: data.toString("base64"),
    at,
  });
  // A box without a desktop falls back to its open tab, but only during a turn: those DevTools bytes
  // count as use, and an idle box must still stop.
  const thumbnails = createThumbnails({
    running: () =>
      boxes?.ready()
        ? store.boxes
            .listBoxes()
            .filter(({ state }) => state === "running")
            .map(({ botId }) => botId)
        : [],
    working: (botId) => store.botBusy(botId),
    held: (botId) => browser.held(botId),
    capture: async (botId) => {
      try {
        return await (boxes?.runtime.capture(botId) ?? Promise.reject(new Error("no boxes")));
      } catch (error) {
        if (!store.botBusy(botId)) {
          throw error;
        }
        return browser.screenshot(botId);
      }
    },
    onFrame: (frame) => toWall(thumbnailMessage(frame)),
    onHeld: (held) => toWall({ type: "wall", held }),
  });
  function watchWall(client: WebSocket, watching: boolean) {
    if (watching && !wallViewers.has(client)) {
      wallViewers.add(client);
      thumbnails.watch(true);
      send(client, { type: "wall", held: thumbnails.held() });
      for (const frame of thumbnails.frames()) {
        send(client, thumbnailMessage(frame));
      }
    } else if (!watching && wallViewers.delete(client) && wallViewers.size === 0) {
      thumbnails.watch(false);
    }
  }

  // A sleeping laptop or a dropped network leaves a socket that never closes on its own.
  const answered = new WeakSet<WebSocket>();

  function broadcast(message: ServerMessage) {
    for (const subscriber of subscribers) {
      send(subscriber, message);
    }
  }

  // The boot's index rebuild emits nothing, so a cursor from before it can't be caught up by replay.
  const bootSeq = store.bounds().latest;
  store.onEvent((event) => broadcast({ type: "event", event }));
  // Filled for the length of an owner's "always" decision, which the event alone can't tell.
  const answeredAlways = new Set<string>();
  store.onEvent((event) => {
    try {
      trackUsage(
        usageOf(event, {
          bot: store.getBot,
          wake: store.runWake,
          lane: store.accountLane,
          always: answeredAlways,
        }),
      );
    } catch {
      // Usage data never breaks Bee Bot.
    }
  });
  boxes?.onChange((availability) => broadcast({ type: "box-availability", availability }));
  const approvals = createApprovals({
    store,
    dataDir,
    timeoutMs: approvalTimeoutMs,
    clock,
    decide,
    executors: new Map([
      ...browserExecutors(browser),
      ...computerExecutors(computer),
      ...(cua ? cuaExecutors(cua) : []),
      ...(box ? boxExecutors(box) : []),
      ...(executors ?? []),
    ]),
    continuationTtlMs,
    describe: cua?.describe,
    connectors: {
      granted: (botId, tool) => connectorHub.granted(botId, tool),
      allowAlways: (botId, tool) => connectorHub.allowAlways(botId, tool),
      execute: ({ botId, tool, payload }) =>
        connectorHub.runApproved(botId, tool, ConnectorPayload.parse(JSON.parse(payload)).input),
    },
    hasSurface: () => subscribers.size > 0,
    onSettled: () => supervisor.pump(),
    onChange: () => {
      broadcast({ type: "pending-approvals", approvals: approvals.pending() });
      supervisor.syncClocks();
    },
  });
  const connectorHub = createConnectorHub({
    connectors: store.connectors,
    policy: store.policy,
    vault,
    box: box && { runtime: box.runtime, env: box.layout.env },
    decide,
    requestApproval: (run, tool, args, shown) => approvals.requestApproval(run, tool, args, shown),
    notify: (run, text) => store.postRunNotice(run.id, text),
  });
  const oauthRedirect = () =>
    `http://127.0.0.1:${(server.address() as AddressInfo).port}${oauthCallbackPath}`;
  const supervisor = createSupervisor({
    store,
    runTurn,
    approvals,
    permissionsUrl: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    turnTimeoutMs,
    clock,
    boxesReady,
    onStopBot: (botId) => void browser.stop(botId),
    copyInbox: async (botId, files) => {
      const bot = store.getBot(botId);
      const folder = bot && NodePath.join(workingFolder(dataDir, botId, bot.projectPath), "inbox");
      for (const { id, roomId, file } of files) {
        const source = attachmentPath(dataDir, roomId, id);
        if (bot?.boundary === "box") {
          if (!boxes) {
            throw new Error("boxes are unavailable");
          }
          await boxes.runtime.inbox(botId, file, createReadStream(source));
        } else if (folder) {
          await NodeFS.mkdir(folder, { recursive: true });
          await NodeFS.copyFile(source, NodePath.join(folder, file));
        }
      }
    },
    onDelta: (runId, text) => broadcast({ type: "delta", runId, text }),
    onToolStart: (runId, { id, name, detail }) =>
      broadcast({ type: "tool-start", runId, toolId: id, name, detail }),
    onToolEnd: (runId, toolId, failed) => broadcast({ type: "tool-end", runId, toolId, failed }),
    onThinking: (runId, { active, text }) => broadcast({ type: "thinking", runId, active, text }),
    onRateLimit: (accountId, updates) => store.mergeUsage(accountId, updates),
    onTurnEnded: (accountId) => void limits.refresh(accountId).catch(logUsageFailure),
    accountHeld: (accountId) =>
      limits.isProbing(accountId) || (accountId === "codex" && codexProbing),
  });
  const limits = createLimitRefresher({
    store,
    probe: probeUsage && (() => probeUsage(setClaudeModels)),
    minGapMs: usageRefreshGapMs,
    onSettled: () => supervisor.pump(),
  });

  // One at a time, in the background: a bot is usable before its summary exists.
  const stopSummaries = new AbortController();
  let summaries = Promise.resolve();
  function writeSummary(botId: string) {
    const { signal } = stopSummaries;
    summaries = summaries
      .then(async () => {
        const bot = store.getBot(botId);
        if (!bot?.personality || bot.summary !== null || signal.aborted) {
          return;
        }
        // The test engine never reaches a real CLI.
        const written =
          bot.engineAccountId === "fake"
            ? undefined
            : await summarize?.(bot, signal).catch(() => undefined);
        if (!signal.aborted) {
          store.setBotSummary(botId, bot.personality, written ?? fallbackSummary(bot.personality));
        }
      })
      .catch(logSummaryFailure);
  }
  const history = createUsageHistory(projectsDir);

  // Non-browser clients send no Origin; they still need the token.
  const originAllowed = (origin: string | undefined) =>
    origin === undefined || allowedOrigins.includes(origin);

  function tokenMatches(presented: string | null | undefined) {
    const candidate = Buffer.from(presented ?? "");
    return (
      candidate.length === expectedToken.length &&
      NodeCrypto.timingSafeEqual(candidate, expectedToken)
    );
  }

  function refusal(origin: string | undefined, authorized: boolean, url: URL) {
    if (!originAllowed(origin)) {
      return { status: 403, body: { code: "origin_refused" } };
    }
    if (!authorized) {
      return { status: 401, body: { code: "unauthorized" } };
    }
    const clientVersion = url.searchParams.get("protocolVersion");
    if (clientVersion !== String(protocolVersion)) {
      const notice: ProtocolNotice = {
        code: "protocol_mismatch",
        message: `This client speaks protocol ${clientVersion ?? "(none)"}, but the Bee Bot server speaks ${protocolVersion}. Update Bee Bot so both match.`,
        serverProtocolVersion: protocolVersion,
      };
      return { status: 426, body: notice };
    }
    return undefined;
  }

  function catchUp(afterSeq: number): ServerMessage {
    const { oldest, latest } = store.bounds();
    // Covers cursor 0 too: an empty client, and rows like the seeded account have no event.
    if (afterSeq <= bootSeq || afterSeq < oldest - 1 || afterSeq > latest) {
      return { type: "snapshot", seq: latest, state: store.state() };
    }
    return { type: "replay", events: store.eventsAfter(afterSeq) };
  }

  // Live for a running box. A failure is logged only: the box's next start pushes the policy again.
  async function applyEgress(bot: Bot) {
    await boxes?.applyEgress(bot.id).catch((error: unknown) => {
      console.error(`beebotd: egress for ${bot.id} not applied: ${(error as Error)?.message}`);
    });
    return { status: 200, body: bot };
  }

  // After the rows are gone, so a failure here leaves files behind, never a half-deleted bot.
  async function removeBotFiles(botId: string, dmRoomId: string) {
    const log = (what: string) => (error: unknown) =>
      console.error(
        `beebotd: ${what} of deleted bot ${botId} stayed: ${(error as Error)?.message}`,
      );
    if (boxes?.ready()) {
      await boxes.runtime.destroy(botId).catch(log("box"));
    }
    await NodeFS.rm(NodePath.join(dataDir, "bots", botId), { recursive: true, force: true }).catch(
      log("folder"),
    );
    await NodeFS.rm(NodePath.dirname(attachmentsDir(dataDir, dmRoomId)), {
      recursive: true,
      force: true,
    }).catch(log("attachments"));
    for (const { id } of readTeamMemoryFiles(dataDir).filter((item) => item.botId === botId)) {
      await NodeFS.rm(NodePath.join(teamMemoryDir(dataDir), `${id}.md`), { force: true }).catch(
        log("team memory"),
      );
    }
  }

  // Replaces what is saved. An empty secret removes the row.
  async function saveSecret(connectorId: string, secret: Secret) {
    try {
      if (Object.values(secret).some((value) => value !== undefined)) {
        await vault.put(secretName(connectorId), JSON.stringify(secret));
      } else {
        await vault.delete(secretName(connectorId));
      }
      return undefined;
    } catch (error) {
      if (error instanceof VaultError) {
        return { status: 409, body: { code: `vault_${error.problem}` } };
      }
      throw error;
    }
  }

  async function addConnector(command: Extract<Command, { type: "add-connector" }>) {
    const { name, url, bearer, headers } = command;
    const problem = urlProblem(url) ?? headersProblem(headers ?? {});
    if (problem || (bearer && headers)) {
      return { status: 400, body: { code: problem ?? "bad_request" } };
    }
    const added = store.connectors.addConnector({
      name,
      transport: "http",
      url,
      command: null,
      args: [],
      auth: bearer ? "bearer" : headers ? "headers" : "none",
      ownerBotId: command.ownerBotId ?? null,
      headerKeys: Object.keys(headers ?? {}),
      envKeys: [],
      status: "unreachable",
      lastError: null,
    });
    if (typeof added === "string") {
      return { status: added === "not_found" ? 404 : 409, body: { code: added } };
    }
    const refused = await saveSecret(added.id, { bearer, headers });
    if (refused) {
      store.connectors.deleteConnector(added.id);
      return refused;
    }
    void connectorHub.refresh(added.id);
    trackUsage(connectorAdded(added, "url"));
    return { status: 200, body: store.connectors.connectorChanged(added.id) };
  }

  async function importConnectors(command: Extract<Command, { type: "import-connectors" }>) {
    const parsed = parseMcpServers(command.json);
    if ("error" in parsed) {
      return { status: 400, body: { code: parsed.error } };
    }
    const added = [];
    const refused = [...parsed.refused];
    for (const entry of parsed.entries) {
      const local = entry.transport === "stdio";
      const connector = store.connectors.addConnector({
        name: entry.key.slice(0, 80) || "App",
        transport: entry.transport,
        url: entry.url,
        command: entry.command,
        args: entry.args,
        auth: Object.keys(entry.headers).length > 0 ? "headers" : "none",
        ownerBotId: command.ownerBotId ?? null,
        headerKeys: Object.keys(entry.headers),
        envKeys: Object.keys(entry.env),
        status: "unreachable",
        lastError: null,
      });
      if (typeof connector === "string") {
        refused.push({ key: entry.key, code: connector });
        continue;
      }
      const values = local ? entry.env : entry.headers;
      const secret = local ? { env: entry.env } : { headers: entry.headers };
      const failed =
        Object.keys(values).length === 0 ? undefined : await saveSecret(connector.id, secret);
      if (failed) {
        store.connectors.deleteConnector(connector.id);
        refused.push({ key: entry.key, code: failed.body.code });
        continue;
      }
      void connectorHub.refresh(connector.id);
      trackUsage(connectorAdded(connector, "import"));
      added.push(store.connectors.connectorChanged(connector.id) ?? connector);
    }
    return { status: 200, body: { added, refused } };
  }

  async function setConnectorSecret(command: Extract<Command, { type: "set-connector-secret" }>) {
    const { connectorId, bearer, headers, env, clientId, clientSecret } = command;
    const connector = store.connectors.getConnector(connectorId);
    if (!connector) {
      return { status: 404, body: { code: "not_found" } };
    }
    if (clientId !== undefined || clientSecret !== undefined) {
      if (!clientId || bearer || headers || env || connector.transport !== "http") {
        return { status: 400, body: { code: "bad_request" } };
      }
      try {
        await connectorHub.oauth.saveClient(connector, clientId, clientSecret);
      } catch (error) {
        if (error instanceof VaultError) {
          return { status: 409, body: { code: `vault_${error.problem}` } };
        }
        throw error;
      }
      connectorHub.forget(connectorId);
      store.connectors.setConnectorStatus(connectorId, "needs_sign_in", null);
      return { status: 200, body: store.connectors.setAuth(connectorId, "oauth", [], []) };
    }
    const remote = connector.transport === "http";
    if ((remote && (env || (bearer && headers))) || (!remote && (bearer || headers))) {
      return { status: 400, body: { code: "bad_request" } };
    }
    const problem = headersProblem(headers ?? {}) ?? envProblem(env ?? {});
    if (problem) {
      return { status: 400, body: { code: problem } };
    }
    // A local server's values are set one name at a time, so the others stay.
    const saved = remote ? {} : (parseSecret(await vault.get(secretName(connectorId))).env ?? {});
    const merged = remote ? undefined : { ...saved, ...env };
    const refused = await saveSecret(connectorId, { bearer, headers, env: merged });
    if (refused) {
      return refused;
    }
    const staticAuth = bearer ? "bearer" : headers ? "headers" : "none";
    const updated = store.connectors.setAuth(
      connectorId,
      connector.auth === "oauth" ? "oauth" : staticAuth,
      Object.keys(headers ?? {}),
      Object.keys(merged ?? {}),
    );
    connectorHub.forget(connectorId);
    void connectorHub.refresh(connectorId);
    return { status: 200, body: updated };
  }

  async function updateConnector(command: Extract<Command, { type: "update-connector" }>) {
    const { connectorId, name, url, readsPrivate } = command;
    const current = store.connectors.getConnector(connectorId);
    if (!current) {
      return { status: 404, body: { code: "not_found" } };
    }
    const egressHosts = command.egressHosts && ownerEgressHosts(command.egressHosts);
    if (egressHosts === null) {
      return { status: 400, body: { code: "bad_egress_host" } };
    }
    const moved = url !== undefined && url !== current.url;
    const problem = moved
      ? current.transport === "http"
        ? urlProblem(url)
        : "bad_request"
      : undefined;
    if (problem) {
      return { status: 400, body: { code: problem } };
    }
    // Tokens belong to the URL they were issued for.
    if (moved) {
      await vault.delete(oauthName(connectorId));
    }
    const updated = store.connectors.updateConnector(connectorId, {
      ...(name !== undefined && { name }),
      ...(url !== undefined && { url }),
      ...(readsPrivate !== undefined && { readsPrivate }),
      ...(egressHosts && { egressHosts }),
    });
    // Live for a running box, like a bot's hosts.
    if (egressHosts) {
      await boxes?.applyEgress(connectorBoxId(connectorId)).catch((error: unknown) => {
        console.error(
          `beebotd: egress for ${connectorId} not applied: ${(error as Error)?.message}`,
        );
      });
    }
    if (moved) {
      connectorHub.forget(connectorId);
      void connectorHub.refresh(connectorId);
    }
    return { status: 200, body: updated };
  }

  // Opens no browser: the web app does, with the URL this answers.
  async function startConnectorOauth(connectorId: string) {
    const connector = store.connectors.getConnector(connectorId);
    if (!connector) {
      return { status: 404, body: { code: "not_found" } };
    }
    if (connector.transport !== "http") {
      return { status: 400, body: { code: "bad_request" } };
    }
    try {
      const authorizationUrl = await connectorHub.oauth.start(connector, oauthRedirect());
      if (authorizationUrl === undefined) {
        store.connectors.setConnectorStatus(connectorId, "needs_client", null);
        return { status: 200, body: { needsClient: true } };
      }
      return { status: 200, body: { authorizationUrl } };
    } catch (error) {
      if (error instanceof VaultError) {
        return { status: 409, body: { code: `vault_${error.problem}` } };
      }
      console.error(`beebotd: connector sign-in failed to start: ${(error as Error)?.name}`);
      return { status: 502, body: { code: "connector_sign_in_failed" } };
    }
  }

  async function finishConnectorOauth(url: URL, response: NodeHttp.ServerResponse) {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || !code) {
      track("connector_oauth_completed", { ok: false });
      sendPage(response, 400, "The sign-in didn't finish. Go back to Bee Bot and try again.");
      return;
    }
    let connector;
    try {
      connector = await connectorHub.oauth.finish(state, code);
    } catch (error) {
      console.error(`beebotd: connector sign-in failed: ${(error as Error)?.name}`);
    }
    track("connector_oauth_completed", { ok: connector !== undefined });
    if (!connector) {
      sendPage(response, 400, "This sign-in link has expired. Go back to Bee Bot and try again.");
      return;
    }
    store.connectors.setAuth(connector.id, "oauth", [], []);
    connectorHub.forget(connector.id);
    void connectorHub.refresh(connector.id);
    sendPage(response, 200, `Signed in to ${connector.name}. You can close this tab.`);
  }

  async function disconnectConnector(connectorId: string) {
    const connector = store.connectors.getConnector(connectorId);
    if (!connector) {
      return { status: 404, body: { code: "not_found" } };
    }
    connectorHub.forget(connectorId);
    await connectorHub.oauth.revoke(connector).catch(() => {});
    await vault.delete(secretName(connectorId));
    await vault.delete(oauthName(connectorId));
    store.connectors.setAuth(connectorId, connector.auth, [], []);
    if (connector.auth !== "none") {
      store.connectors.setConnectorStatus(connectorId, "needs_sign_in", null);
    }
    store.connectors.auditConnector(connectorId, "connector_disconnected");
    return { status: 200, body: store.connectors.connectorChanged(connectorId) };
  }

  // The rows first, so no run after this sees it, then the secrets.
  async function deleteConnector(connectorId: string) {
    if (!store.connectors.deleteConnector(connectorId)) {
      return { status: 404, body: { code: "not_found" } };
    }
    connectorHub.forget(connectorId);
    await vault.delete(secretName(connectorId));
    await vault.delete(oauthName(connectorId));
    if (boxesReady()) {
      await connectorHub.destroyBox(connectorId).catch((error: unknown) => {
        console.error(
          `beebotd: box of deleted connector ${connectorId} stayed: ${(error as Error)?.message}`,
        );
      });
    }
    return { status: 200, body: { ok: true } };
  }

  function runCommand(command: Command) {
    const notFound = { status: 404, body: { code: "not_found" } };
    const ok = { status: 200, body: { ok: true } };
    // shortcut: any open client counts, not the sender's own. Tie it to the sender once a token can
    // be held by something other than the owner's own clients.
    const attended = subscribers.size > 0;
    switch (command.type) {
      case "create-bot": {
        const { name, personality, engineAccountId = "claude" } = command;
        const { model = defaultBotModel, avatarSeed } = command;
        if (engineAccountId === "fake" && !fakeEngine) {
          return { status: 403, body: { code: "engine_not_allowed" } };
        }
        if (!modelsOf(engineAccountId).some(({ id }) => id === model)) {
          return { status: 400, body: { code: "unknown_model" } };
        }
        const folder = projectChoice(command.projectPath, null);
        if (folder.refused) {
          return folder.refused;
        }
        const first = store.botIds().length === 0;
        const bot = store.createBot({
          name,
          personality,
          engineAccountId,
          model,
          projectPath: folder.projectPath,
          ...(avatarSeed !== undefined && { avatarSeed }),
        });
        writeSummary(bot.id);
        trackUsage(botCreated(bot, first));
        return { status: 200, body: bot };
      }
      case "update-bot": {
        const { botId, name, personality } = command;
        const current = store.getBot(botId);
        if (!current) {
          return notFound;
        }
        const choice = engineChoice(current, command);
        if (choice.refused) {
          return choice.refused;
        }
        const folder = projectChoice(command.projectPath, current.projectPath);
        if (folder.refused) {
          return folder.refused;
        }
        const { projectPath } = folder;
        if (projectPath !== current.projectPath && store.botBusy(botId)) {
          return { status: 409, body: { code: "bot_busy" } };
        }
        const { model, effort } = choice;
        const { avatarSeed = current.avatarSeed } = command;
        const fields = { name, personality, model, effort, avatarSeed, projectPath };
        const bot = store.updateBot(botId, fields);
        writeSummary(botId);
        return { status: 200, body: bot };
      }
      case "set-bot-engine": {
        const current = store.getBot(command.botId);
        if (!current) {
          return notFound;
        }
        const choice = engineChoice(current, command);
        if (choice.refused) {
          return choice.refused;
        }
        const { model, effort } = choice;
        const { mode = current.mode, access = current.access } = command;
        const bot = store.setBotEngine(command.botId, { model, effort, mode, access });
        trackUsage(bot && botEngineChanged(current, bot));
        return { status: 200, body: bot };
      }
      case "set-bot-paused": {
        const bot = store.setBotPause(command.botId, command.paused ? "owner" : null);
        return bot ? { status: 200, body: bot } : notFound;
      }
      case "send-message": {
        const { messageId: id, roomId, body, replyToId, attachmentIds, mentions } = command;
        const result = store.sendMessage({
          id,
          roomId,
          body,
          attended,
          ...(replyToId && { replyToId }),
          ...(attachmentIds && { attachmentIds }),
          ...(mentions && { mentions }),
        });
        if (result === "sent") {
          const room = store.rooms.getRoom(roomId);
          trackUsage(room && messageSent(command, room.kind));
        }
        if (result === "sent" || result === "duplicate") {
          return ok;
        }
        if (result === "not_found") {
          return notFound;
        }
        return {
          status: 409,
          body: { code: result === "conflict" ? "message_id_reused" : result },
        };
      }
      case "create-room": {
        const { name, memberIds, defaultBotId = null } = command;
        const members = memberIds.map((botId) => store.getBot(botId));
        if (!members.every(Boolean)) {
          return notFound;
        }
        if (members.some((bot) => bot?.archivedAt)) {
          return { status: 409, body: { code: "bot_archived" } };
        }
        const room = store.rooms.createGroupRoom({ name, memberIds, defaultBotId });
        return room ? { status: 200, body: room } : { status: 400, body: { code: "not_member" } };
      }
      case "update-room": {
        const { roomId, name, defaultBotId } = command;
        const room = store.rooms.updateGroupRoom(roomId, {
          ...(name !== undefined && { name }),
          ...(defaultBotId !== undefined && { defaultBotId }),
        });
        if (room === "not_found") {
          return notFound;
        }
        return room === "not_member"
          ? { status: 400, body: { code: room } }
          : { status: 200, body: room };
      }
      case "add-room-member": {
        const bot = store.getBot(command.botId);
        if (bot?.archivedAt) {
          return { status: 409, body: { code: "bot_archived" } };
        }
        const room = bot ? store.rooms.addMember(command.roomId, command.botId) : undefined;
        return room ? { status: 200, body: room } : notFound;
      }
      case "remove-room-member": {
        const room = store.rooms.removeMember(command.roomId, command.botId);
        return room ? { status: 200, body: room } : notFound;
      }
      case "stop-bot":
        supervisor.stopBot(command.botId);
        return ok;
      case "archive-bot": {
        const { botId } = command;
        if (!store.getBot(botId)) {
          return notFound;
        }
        supervisor.stopBot(botId);
        const bot = store.archiveBot(botId);
        const box = store.boxes.listBoxes().find((row) => row.botId === botId);
        if (box?.state === "running" || box?.state === "starting") {
          boxes?.runtime.stop(botId).catch((error: unknown) => {
            console.error(`beebotd: box for ${botId} didn't stop: ${(error as Error)?.message}`);
          });
        }
        return { status: 200, body: bot };
      }
      case "delete-bot": {
        const dmRoomId = store.getBot(command.botId)?.roomId ?? "";
        const result = store.deleteBot(command.botId);
        if (result === "not_found") {
          return notFound;
        }
        if (result === "bot_busy") {
          return { status: 409, body: { code: result } };
        }
        void removeBotFiles(command.botId, dmRoomId);
        return ok;
      }
      case "restore-bot": {
        const bot = store.restoreBot(command.botId);
        return bot ? { status: 200, body: bot } : notFound;
      }
      case "stop-all":
        supervisor.stopAll();
        return ok;
      case "set-account-lane":
        store.setAccountLane(command.engineAccountId, command.lane);
        supervisor.pump();
        return ok;
      case "continue-run": {
        const result = store.continueRun(command.runId, attended);
        if (result === "not_found") {
          return notFound;
        }
        return result === "continued" ? ok : { status: 409, body: { code: result } };
      }
      case "decide-approval":
      case "decide-continuation": {
        const id = command.type === "decide-approval" ? command.approvalId : command.continuationId;
        if (command.decision === "always") {
          answeredAlways.add(id);
        }
        try {
          return command.type === "decide-approval"
            ? approvals.decide(command)
            : approvals.decideContinuation(command);
        } finally {
          answeredAlways.delete(id);
        }
      }
      case "acknowledge-notice":
        store.acknowledgeNotice();
        return ok;
      case "add-memory": {
        const { botId, text, memoryType: type, supersedes } = command;
        const memory = store.addMemory({ botId, text, type, supersedes });
        return memory ? { status: 200, body: memory } : notFound;
      }
      case "decide-memory":
        return store.decideMemory(command.memoryId, command.decision) ? ok : notFound;
      case "forget-memory":
        return store.forgetMemory(command.memoryId) ? ok : notFound;
      case "create-routine": {
        if (!store.getBot(command.botId)) {
          return notFound;
        }
        const problem = scheduleProblem(command, new Date().toISOString());
        if (problem) {
          return { status: 400, body: { code: problem } };
        }
        const routine = store.createRoutine(command);
        trackUsage(routineCreated(routine));
        return { status: 200, body: routine };
      }
      case "update-routine": {
        const problem = scheduleProblem(command, new Date().toISOString());
        if (problem) {
          return { status: 400, body: { code: problem } };
        }
        const routine = store.updateRoutine(command.routineId, command);
        return routine ? { status: 200, body: routine } : notFound;
      }
      case "delete-routine":
        return store.deleteRoutine(command.routineId) ? ok : notFound;
      case "add-skill": {
        const { text, folder } = command;
        if ((text === undefined) === (folder === undefined)) {
          return { status: 400, body: { code: "bad_request" } };
        }
        if (folder !== undefined && !NodePath.isAbsolute(folder)) {
          return { status: 400, body: { code: "skill_not_folder" } };
        }
        const walked =
          text === undefined
            ? readSkillFolder(folder ?? "")
            : { files: [{ path: "SKILL.md", bytes: Buffer.from(text) }] };
        const prepared = "files" in walked ? prepareSkill(walked.files) : walked;
        if ("error" in prepared) {
          return { status: 400, body: { code: prepared.error, path: prepared.path } };
        }
        const added = store.addSkill(prepared, text === undefined ? "folder" : "pasted");
        return typeof added === "string"
          ? { status: 409, body: { code: added } }
          : { status: 200, body: added };
      }
      case "review-skill": {
        const reviewed = store.reviewSkill(command.name, command.sha256);
        if (reviewed === "not_found") {
          return notFound;
        }
        return typeof reviewed === "string"
          ? { status: 409, body: { code: reviewed } }
          : { status: 200, body: reviewed };
      }
      case "set-bot-skill": {
        const set = store.setBotSkill(command.botId, command.name, command.on);
        if (set === "not_found") {
          return notFound;
        }
        return typeof set === "string"
          ? { status: 409, body: { code: set } }
          : { status: 200, body: set };
      }
      case "delete-skill":
        return store.deleteSkill(command.name) ? ok : notFound;
      case "add-connector":
        return addConnector(command);
      case "import-connectors":
        return importConnectors(command);
      case "update-connector":
        return updateConnector(command);
      case "review-connector": {
        const { connectorId, toolsHash, readOnly } = command;
        const reviewed = store.connectors.reviewConnector(connectorId, toolsHash, readOnly);
        if (reviewed === "not_found") {
          return notFound;
        }
        return typeof reviewed === "string"
          ? { status: 409, body: { code: reviewed } }
          : { status: 200, body: reviewed };
      }
      case "set-connector-secret":
        return setConnectorSecret(command);
      case "start-connector-oauth":
        return startConnectorOauth(command.connectorId);
      case "refresh-connector": {
        const { connectorId } = command;
        if (!store.connectors.getConnector(connectorId)) {
          return notFound;
        }
        connectorHub.forget(connectorId);
        return connectorHub
          .refresh(connectorId)
          .then(() => ({ status: 200, body: store.connectors.getConnector(connectorId) }));
      }
      case "disconnect-connector":
        return disconnectConnector(command.connectorId);
      case "delete-connector":
        return deleteConnector(command.connectorId);
      case "set-bot-connector": {
        const { botId, connectorId, on, tools, allowWrites } = command;
        const set = store.connectors.setBotConnector(botId, connectorId, on, tools, allowWrites);
        if (set === "not_found") {
          return notFound;
        }
        return typeof set === "string"
          ? { status: 409, body: { code: set } }
          : { status: 200, body: set };
      }
      case "start-firing": {
        const result = store.startFiring(command.firingId, attended);
        if (result === "not_found") {
          return notFound;
        }
        return result === "started" ? ok : { status: 409, body: { code: result } };
      }
      case "store-api-key":
        return storeApiKey(vault, command.engineAccountId, command.key);
      case "delete-api-key":
        return deleteApiKey(vault, command.engineAccountId);
      case "acknowledge-automated-access":
        store.vaultStore.acknowledgeAutomatedAccess();
        return ok;
      case "skip-firing": {
        const result = store.skipFiring(command.firingId);
        if (result === "not_found") {
          return notFound;
        }
        return result === "skipped" ? ok : { status: 409, body: { code: result } };
      }
      case "set-bot-manifest": {
        const bot = store.policy.setBotManifest(command.botId, command.manifest);
        return bot ? { status: 200, body: bot } : notFound;
      }
      case "set-bot-boundary": {
        const { botId, boundary } = command;
        const current = store.getBot(botId);
        if (!current) {
          return notFound;
        }
        if (boundary === "box" && !boxesReady()) {
          return { status: 409, body: { code: "boxes_unavailable" } };
        }
        if (boundary !== current.boundary && store.botBusy(botId)) {
          return { status: 409, body: { code: "bot_busy" } };
        }
        const bot = store.policy.setBotBoundary(botId, boundary);
        if (bot && boundary !== current.boundary) {
          trackUsage(worksOnChanged(bot));
        }
        if (boundary === "box") {
          boxes?.prepare(botId).catch((error: unknown) => {
            console.error(`beebotd: box for ${botId} didn't come up: ${(error as Error)?.message}`);
          });
        }
        return { status: 200, body: bot };
      }
      case "set-bot-egress-hosts": {
        const hosts = ownerEgressHosts(command.hosts);
        if (hosts === null) {
          return { status: 400, body: { code: "bad_egress_host" } };
        }
        const bot = store.policy.setBotEgressHosts(command.botId, command.anySite, hosts);
        if (!bot) {
          return notFound;
        }
        return applyEgress(bot);
      }
      case "set-usage-data":
        store.setUsageData(command.on);
        return ok;
      case "track":
        track(command.event, {});
        return ok;
      case "report-error":
        reportError(command.error);
        return ok;
      case "set-bot-unattended-lane": {
        if (command.lane === "subscription" && !store.automatedAccessAt()) {
          return { status: 409, body: { code: "automated_access_unacknowledged" } };
        }
        const bot = store.policy.setBotUnattendedLane(command.botId, command.lane);
        return bot ? applyEgress(bot) : notFound;
      }
      case "set-bot-control": {
        const { botId, control } = command;
        const current = store.getBot(botId);
        if (!current) {
          return notFound;
        }
        if (control === current.control) {
          return { status: 200, body: current };
        }
        if (control === "host" && !hostControl().available) {
          return { status: 409, body: { code: "host_control_unavailable" } };
        }
        if (control === "host" && !command.hostConsent) {
          return { status: 400, body: { code: "host_consent_required" } };
        }
        // A turn keeps the tools it started with, so a change waits for the bot to be idle.
        if (store.botBusy(botId)) {
          return { status: 409, body: { code: "bot_busy" } };
        }
        computer.interrupt(botId);
        const consentAt = control === "host" ? new Date().toISOString() : null;
        const bot = store.policy.setBotControl(botId, control, consentAt);
        if (bot) {
          trackUsage(worksOnChanged(bot));
        }
        if ((control === "browser" || control === "computer") && boxes?.ready()) {
          boxes.prepare(botId).catch((error: unknown) => {
            console.error(`beebotd: box for ${botId} didn't come up: ${(error as Error)?.message}`);
          });
        }
        return { status: 200, body: bot };
      }
      case "host-frame":
        if (!host || !hostControl().available) {
          return { status: 409, body: { code: "host_control_unavailable" } };
        }
        return (cua?.ready() ?? Promise.resolve(false))
          .then((background) => (background && cua ? cua.frame() : host.frame()))
          .then(
            (frame) => ({ status: 200, body: frame }),
            (error: unknown) => {
              console.error(`beebotd: host frame failed: ${(error as Error)?.message}`);
              return { status: 503, body: { code: "host_screen_failed" } };
            },
          );
      case "host-hold": {
        if (!host) {
          return { status: 409, body: { code: "host_control_unavailable" } };
        }
        const driving = host.hold(command.held);
        if (driving) {
          computer.interrupt(driving);
        }
        if (command.held) {
          cua?.interrupt();
        }
        broadcast({ type: "host-control", availability: hostControl() });
        return ok;
      }
      case "set-box-machine":
        store.setBoxMachine(command.machine);
        void boxes?.refresh();
        return ok;
      case "display-ticket": {
        const bot = store.getBot(command.botId);
        if (!bot) {
          return notFound;
        }
        if (!boxes || !hasBoxDesktop(bot)) {
          return { status: 409, body: { code: "no_display" } };
        }
        const { mode, leaseId } = command;
        if (mode === "control" && (leaseId === undefined || !desktop.holds(bot.id, leaseId))) {
          return { status: 403, body: { code: "not_lease_holder" } };
        }
        return {
          status: 200,
          body: displayTickets.issue(bot.id, mode, mode === "control" ? leaseId : undefined),
        };
      }
      case "set-up-boxes":
        if (!boxes) {
          return { status: 409, body: { code: "boxes_unsupported" } };
        }
        // Building the image takes minutes: progress arrives as box-availability.
        void boxes.setUp();
        return ok;
      case "open-setup-terminal": {
        const setup = setupCommand(hostPlatform(), command.step);
        if (!setup) {
          return { status: 409, body: { code: "no_setup_command" } };
        }
        return openSetupTerminal(setup).then((opened) =>
          opened === "opened" ? ok : { status: 409, body: { code: opened } },
        );
      }
    }
  }

  // Raw bytes, so a file never passes through the 1 MB command body. The name and room ride in the
  // query, the type in Content-Type.
  async function handleUpload(
    url: URL,
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) {
    const refuse = (status: number, code: string) => {
      request.resume();
      sendJson(response, status, { code });
    };
    const room = store.rooms.getRoom(url.searchParams.get("room") ?? "");
    const mime = attachmentMime(request.headers["content-type"]);
    if (!room) {
      refuse(404, "not_found");
      return;
    }
    if (!mime) {
      refuse(415, "attachment_type");
      return;
    }
    if (Number(request.headers["content-length"] ?? 0) > maxAttachmentBytes) {
      refuse(413, "attachment_too_large");
      return;
    }
    const id = NodeCrypto.randomUUID();
    const name = attachmentName(url.searchParams.get("name"));
    const received = await receiveAttachment(request, dataDir, room.id, id);
    if (received === "too_large") {
      sendJson(response, 413, { code: "attachment_too_large" });
      return;
    }
    store.addAttachment({ id, roomId: room.id, name, mime, ...received });
    sendJson(response, 200, { id, name, mime, size: received.size });
  }

  // Uploads never sent are dropped after a day, rows first.
  async function sweepAttachments() {
    const cutoff = new Date(Date.now() - unclaimedAttachmentMs).toISOString();
    for (const { id, roomId } of store.sweepAttachments(cutoff)) {
      await NodeFS.rm(attachmentPath(dataDir, roomId, id), { force: true }).catch(() => {});
    }
  }

  async function handleCommand(
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) {
    const command = parseCommand(await readBody(request, maxBodyBytes));
    if (!command) {
      sendJson(response, 400, { code: "bad_request" });
      return;
    }
    try {
      const { status, body } = await runCommand(command);
      trackUsage(commandFailed(command.type, status, body));
      sendJson(response, status, body);
      supervisor.pump();
    } catch (error) {
      console.error(error);
      trackUsage(commandFailed(command.type, 500, undefined));
      sendJson(response, 500, { code: "storage_failed" });
    }
  }

  // The CLI is the only caller, so an Origin means a browser is trying its luck.
  async function engineCall(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    if (request.headers.origin !== undefined) {
      sendJson(response, 403, { code: "origin_refused" });
      return undefined;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { code: "method_not_allowed" });
      return undefined;
    }
    const run = approvals.authenticate(request.headers.authorization?.replace(/^Bearer /, ""));
    if (!run) {
      sendJson(response, 401, { code: "unauthorized" });
      return undefined;
    }
    const body = await readBody(request, maxMcpBodyBytes);
    if (body === undefined) {
      sendJson(response, 413, { code: "too_large" });
      return undefined;
    }
    return { run, body };
  }

  // A Box bot's Claude asks here before every tool call. Anything but a 2xx answer blocks the call.
  async function handleHook(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    const call = await engineCall(request, response);
    if (call) {
      const { run, body } = call;
      await answerPreToolUse(response, body, (args, closed) =>
        approvals.approve(run, args, closed),
      );
    }
  }

  async function handleMcp(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    const call = await engineCall(request, response);
    if (!call) {
      return;
    }
    const { run, body } = call;
    await answerMcp(
      response,
      body,
      {
        approve: (args, closed) => approvals.approve(run, args, closed),
        memory: (name, args) =>
          gateTool(store.policy, run, name, args, () => callMemoryTool(store, run, name, args)),
        bot: (name, args) =>
          gateTool(store.policy, run, name, args, () =>
            callBotTool(store, run, name, args, ({ runId }) => supervisor.parkWaitingUser(runId)),
          ),
        browser: (name, args) => browser.call(run, name, args),
        computer: (name, args) =>
          cua && cuaToolNames.has(name)
            ? cua.call(run, name, args)
            : computer.call(run, name, args),
        tools: async () => {
          const control = store.getBot(run.botId)?.control ?? "none";
          if (control !== "host" || !host || !hostControl().available) {
            return toolsFor(control, undefined);
          }
          if (await cua?.ready()) {
            return toolsFor(control, "cua");
          }
          // The bot's coordinates are the display's, fitted, so the size is read before it looks.
          await host.measure().catch((error: unknown) => {
            console.error(`beebotd: host screen unavailable: ${(error as Error)?.message}`);
          });
          return toolsFor(control, host.screen.size);
        },
      },
      mcpKeepaliveMs,
    );
  }

  async function handleConnectors(
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) {
    const call = await engineCall(request, response);
    if (!call) {
      return;
    }
    const { run, body } = call;
    await answerConnectors(
      response,
      body,
      {
        tools: () => connectorHub.toolsFor(run.botId),
        call: (name, args, closed) => connectorHub.call(run, name, args, closed),
      },
      mcpKeepaliveMs,
    );
  }

  // Skipped during a turn: the login is shared, and R5 allows one app-server per account.
  async function checkCodex() {
    const hasBot = store.botIds().some((id) => store.getBot(id)?.engineAccountId === "codex");
    if (!probeCodex || !hasBot || codexProbing || store.accountRunning("codex")) {
      return;
    }
    codexProbing = true;
    try {
      const status = EngineStatus.parse(
        await probeCodex(store.accountLane("codex"), setCodexModels),
      );
      trackUsage(engineChecked("codex", status));
      const { pauseReason } = status;
      if (pauseReason) {
        console.error(`beebotd: Codex bots paused: ${pauseReason}`);
        store.pauseReadyBots("codex", pauseReason);
      } else {
        store.clearEnginePauses("codex");
      }
    } catch (error) {
      console.error(`beebotd: Codex check failed: ${(error as Error)?.name}`);
    } finally {
      codexProbing = false;
      supervisor.pump();
    }
  }

  async function handleEngine(response: NodeHttp.ServerResponse) {
    try {
      const [status] = await Promise.all([
        probeEngine(store.accountLane("claude")).then(EngineStatus.parse),
        checkCodex(),
      ]);
      if (status.pauseReason) {
        store.pauseReadyBots("claude", status.pauseReason);
      } else {
        store.clearEnginePauses("claude");
      }
      sendJson(response, 200, status);
    } catch (error) {
      console.error(`beebotd: engine check failed: ${(error as Error)?.name}`);
      sendJson(response, 500, { code: "engine_check_failed" });
    }
  }

  async function handleUsage(url: URL, response: NodeHttp.ServerResponse) {
    const days = Number(url.searchParams.get("days"));
    if (!usageDays.some((allowed) => allowed === days)) {
      sendJson(response, 400, { code: "bad_request" });
      return;
    }
    // shortcut: the owner's own Claude sessions in a project folder count to its bot, and two bots
    // sharing a folder resolve to the later one, until attribution is by session.
    const folders = store.botIds().flatMap((id): Array<[string, string]> => {
      const current = workingFolder(dataDir, id, store.getBot(id)?.projectPath ?? null);
      return [workspacePath(dataDir, id), current].map((path) => [projectFolder(path), id]);
    });
    sendJson(response, 200, await history.summary(days, new Map(folders)));
  }

  async function handleRefreshLimits(response: NodeHttp.ServerResponse) {
    const outcome = await limits.refresh("claude");
    sendJson(response, 200, { outcome } satisfies UsageRefreshResult);
  }

  const server = NodeHttp.createServer((request, response) => {
    const url = URL.parse(request.url ?? "", "http://127.0.0.1");
    if (!url) {
      sendJson(response, 400, { code: "bad_request" });
      return;
    }

    if (url.pathname === "/mcp") {
      handleMcp(request, response).catch(() => response.destroy());
      return;
    }
    if (url.pathname === "/mcp/connectors") {
      handleConnectors(request, response).catch(() => response.destroy());
      return;
    }
    if (url.pathname === preToolUsePath) {
      handleHook(request, response).catch(() => response.destroy());
      return;
    }
    // The owner's browser, back from signing in: the one-time `state` stands in for the token.
    if (request.method === "GET" && url.pathname === oauthCallbackPath) {
      finishConnectorOauth(url, response).catch(() => response.destroy());
      return;
    }

    const { origin } = request.headers;
    if (origin !== undefined && originAllowed(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS" && originAllowed(origin)) {
      // Preflights carry no credentials, so the token check can't apply here.
      response.setHeader("Access-Control-Allow-Methods", "GET, POST");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      response.writeHead(204).end();
      return;
    }

    // Before the token and protocol checks: a client reads this to learn whether it can connect.
    if (request.method === "GET" && url.pathname === "/.well-known/bee-bot") {
      if (!originAllowed(origin)) {
        sendJson(response, 403, { code: "origin_refused" });
        return;
      }
      const info: ServerInfo = {
        environmentId: store.environmentId,
        version: serverPackage.version,
        protocolVersion,
        capabilities: [],
      };
      sendJson(response, 200, info);
      return;
    }

    const refused = refusal(
      origin,
      tokenMatches(request.headers.authorization?.replace(/^Bearer /, "")),
      url,
    );
    if (refused) {
      sendJson(response, refused.status, refused.body);
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true });
    } else if (request.method === "GET" && url.pathname === "/state") {
      try {
        sendJson(response, 200, { seq: store.bounds().latest, state: store.state() });
      } catch (error) {
        console.error(error);
        sendJson(response, 500, { code: "storage_failed" });
      }
    } else if (request.method === "GET" && url.pathname === "/engine") {
      void handleEngine(response);
    } else if (request.method === "GET" && url.pathname === "/host") {
      sendJson(response, 200, hostPlatform());
    } else if (request.method === "GET" && url.pathname === "/audit") {
      const query = auditQuery(url);
      sendJson(
        response,
        query ? 200 : 400,
        query ? store.policy.auditPage(query) : { code: "bad_request" },
      );
    } else if (request.method === "GET" && url.pathname === "/usage") {
      handleUsage(url, response).catch(() => sendJson(response, 200, { status: "unavailable" }));
    } else if (request.method === "POST" && url.pathname === "/usage/limits") {
      handleRefreshLimits(response).catch((error: unknown) => {
        logUsageFailure(error);
        sendJson(response, 500, { code: "storage_failed" });
      });
    } else if (request.method === "POST" && url.pathname === "/attachments") {
      handleUpload(url, request, response).catch((error: unknown) => {
        console.error(`beebotd: upload failed: ${(error as Error)?.message}`);
        if (!response.headersSent) {
          sendJson(response, 500, { code: "storage_failed" });
        }
      });
    } else if (request.method === "POST" && url.pathname === "/commands") {
      handleCommand(request, response).catch(() => response.destroy());
    } else {
      sendJson(response, 404, { code: "not_found" });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    const url = URL.parse(request.url ?? "", "http://127.0.0.1");
    const terminal = url?.pathname === "/terminal" && terminals;
    const display = url?.pathname === "/display";
    if (url?.pathname !== "/ws" && url?.pathname !== "/browser" && !terminal && !display) {
      refuseUpgrade(socket, 404, { code: "not_found" });
      return;
    }
    // Browsers can't set headers on a WebSocket, so the token rides in the query.
    // Only an allowed origin spends a ticket, so a hostile page can't burn the owner's.
    const grant =
      display && originAllowed(request.headers.origin)
        ? displayTickets.consume(url.searchParams.get("ticket"))
        : undefined;
    const authorized = display ? grant !== undefined : tokenMatches(url.searchParams.get("token"));
    const refused = refusal(request.headers.origin, authorized, url);
    if (refused) {
      refuseUpgrade(socket, refused.status, refused.body);
      return;
    }
    if (grant) {
      if (!boxes || !store.getBot(grant.botId)) {
        refuseUpgrade(socket, 404, { code: "not_found" });
        return;
      }
      const { botId, leaseId } = grant;
      displaySockets.handleUpgrade(request, socket, head, (client) => {
        if (leaseId !== undefined && !desktop.watch(leaseId, client)) {
          client.close(4409, "control returned");
          return;
        }
        void serveDisplay(client, () => boxes.display(botId, leaseId));
      });
      return;
    }
    if (terminal) {
      const notServed = terminal.upgrade(request, socket, head, url);
      if (notServed) {
        refuseUpgrade(socket, notServed.status, notServed.body);
      }
      return;
    }
    if (url.pathname === "/browser") {
      const botId = url.searchParams.get("botId") ?? "";
      if (!store.getBot(botId)) {
        refuseUpgrade(socket, 404, { code: "not_found" });
        return;
      }
      handoffSockets.handleUpgrade(request, socket, head, (client) =>
        serveHandoff(browser, client, botId),
      );
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      answered.add(client);
      client.on("pong", () => answered.add(client));
      client.on("error", () => client.terminate());
      client.on("close", () => {
        subscribers.delete(client);
        visibleClients.delete(client);
        watchWall(client, false);
      });
      client.on("message", (data) => {
        const message = parseClientMessage(data.toString());
        if (!message) {
          client.close(1008, "invalid message");
          return;
        }
        if (message.type === "wall") {
          watchWall(client, message.watching);
          return;
        }
        if (message.type === "visibility") {
          if (message.visible) {
            visibleClients.add(client);
          } else {
            visibleClients.delete(client);
          }
          return;
        }
        // Store reads and broadcasts are synchronous, so no event can slip between this replay
        // and joining subscribers.
        try {
          send(client, catchUp(message.afterSeq));
          send(client, { type: "pending-approvals", approvals: approvals.pending() });
          send(client, { type: "model-catalog", models: catalog() });
          if (boxes) {
            send(client, { type: "box-availability", availability: boxes.availability() });
          }
          send(client, { type: "host-control", availability: hostControl() });
          subscribers.add(client);
        } catch (error) {
          console.error(error);
          client.close(1011, "storage failed");
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const beat = () => {
    for (const client of sockets.clients) {
      if (!answered.has(client)) {
        client.terminate();
        continue;
      }
      answered.delete(client);
      client.ping();
    }
    heartbeat = awakeTimeout(clock, heartbeatMs, beat);
  };
  let heartbeat = awakeTimeout(clock, heartbeatMs, beat);
  const logSweep = (error: unknown) =>
    console.error(`beebotd: attachment sweep failed: ${(error as Error)?.message}`);
  void sweepAttachments().catch(logSweep);
  const sweeper = setInterval(() => void sweepAttachments().catch(logSweep), 60 * 60_000);
  sweeper.unref();
  supervisor.pump();
  // Bots from before summaries, or whose summary a stop cut off.
  for (const { id } of store.botsWithoutSummary()) {
    writeSummary(id);
  }

  return {
    port: (server.address() as AddressInfo).port,
    // Fills the model catalog too, so the first picker shows what the CLI offers.
    refreshLimits: () => void limits.refresh("claude").catch(logUsageFailure),
    checkCodex,
    power: (state: "suspend" | "resume") =>
      state === "suspend" ? supervisor.suspend() : supervisor.resume(),
    idle: (idleSeconds: number) => {
      ownerIdle = { idleSeconds, at: Date.now() };
    },
    close: async () => {
      stopSummaries.abort();
      await summaries;
      heartbeat.cancel();
      clearInterval(sweeper);
      terminals?.close();
      thumbnails.close();
      approvals.close();
      await supervisor.close();
      connectorHub.close();
      for (const client of [
        ...sockets.clients,
        ...handoffSockets.clients,
        ...displaySockets.clients,
      ]) {
        client.terminate();
      }
      desktop.close();
      host?.close();
      cua?.close();
      await browser.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
