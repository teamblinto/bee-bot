import {
  activeTaskStatuses,
  AttachmentRef,
  AuditPage,
  type Bot,
  type BoxAvailability,
  type ChatState,
  type ClientMessage,
  type Command,
  EngineStatus,
  type HostControlAvailability,
  HostPlatform,
  keepsMeeting,
  limitDefaults,
  type ModelCatalog,
  type PendingApproval,
  protocolVersion,
  type Run,
  type ServerEvent,
  ServerMessage,
  UsageRefreshResult,
  UsageSummary,
} from "@beebot/contracts";

import { routineReadyLine, routineRefusalLines } from "./labels";

const firstReconnectDelayMs = 1000;
const maxReconnectDelayMs = 30_000;
const lastSeenKey = "beebot.lastSeen";

export type LiveTool = {
  id: string;
  name: string;
  detail: string | null;
  status: "running" | "done" | "failed";
};

export type ConnectionState = {
  status: "unconfigured" | "connecting" | "connected" | "disconnected" | "incompatible";
  // False until the first snapshot, so the empty initial chat is never taken for a new user.
  loaded: boolean;
  seq: number;
  chat: ChatState;
  // Live output by run ID. Lost on a reconnect; the final reply arrives as a message.
  drafts: Record<string, string>;
  // Tool rows of a turn, by run ID. A turn that ended without a reply keeps its rows until the bot's
  // next run: nothing else shows what it did.
  liveTools: Record<string, LiveTool[]>;
  // Thinking state of running turns, by run ID.
  thinking: Record<string, { active: boolean; text: string }>;
  // Card content for pending approvals. The server resends the whole set, so it is never merged.
  pending: PendingApproval[];
  // Undefined until the server sends it, so no model is called unavailable before then.
  models: ModelCatalog | undefined;
  // Undefined from a server that can't run boxes.
  boxAvailability: BoxAvailability | undefined;
  // Whether a `host` bot may use this computer. Undefined until the server sends it.
  hostControl: HostControlAvailability | undefined;
  engine: EngineStatus | undefined;
  engineChecking: boolean;
  // Last bot message read, by bot ID. Mirrors localStorage.
  lastSeen: Record<string, string>;
  commandError: string | undefined;
  // The wall's latest JPEG of each bot's screen, base64, while this client watches it.
  thumbnails: Record<string, string>;
  // Bots a person controls now, as of the last time this client watched the wall.
  held: string[];
  // Each bot's latest action on its screen. `seq` tells a repeat from the one before.
  activity: Record<string, BotActivity>;
};

export type BotActivity = Extract<ServerMessage, { type: "activity" }> & { seq: number };

export const isActive = (run: Run | undefined) =>
  run?.status === "Queued" || run?.status === "Running";

export function openCards({ routines, firings }: ChatState, botId: string) {
  return firings.flatMap((firing) => {
    const routine = routines.find(({ id }) => id === firing.routineId);
    return routine?.botId === botId && firing.status === "ready" ? [{ routine, firing }] : [];
  });
}

export const waitingOnOwner = (chat: ChatState, botId: string) =>
  chat.approvals.some((approval) => approval.botId === botId && approval.status === "pending") ||
  chat.continuations.some((continuation) => continuation.botId === botId) ||
  openCards(chat, botId).length > 0;

// A bot's own browser and computer run in its box.
export const drivesBox = (bot: Bot) => bot.control === "browser" || bot.control === "computer";

export const hasBoxScreen = (bot: Bot, boxes: BoxAvailability | undefined) =>
  boxes?.available === true && drivesBox(bot);

function upsert<T extends { id: string }>(items: T[], item: T) {
  return items.some(({ id }) => id === item.id)
    ? items.map((existing) => (existing.id === item.id ? item : existing))
    : [...items, item];
}

function applyEvent(state: ConnectionState, event: ServerEvent) {
  const { chat } = state;
  switch (event.type) {
    case "bot.changed":
    case "bot.archived":
    case "bot.restored":
      return { ...state, chat: { ...chat, bots: upsert(chat.bots, event.bot) } };
    case "bot.deleted": {
      const { botId } = event;
      const dm = chat.bots.find(({ id }) => id === botId)?.roomId;
      const mine = (item: { botId: string }) => item.botId !== botId;
      const routines = chat.routines.filter(mine);
      return {
        ...state,
        chat: {
          ...chat,
          bots: chat.bots.filter(({ id }) => id !== botId),
          rooms: chat.rooms.filter(({ id }) => id !== dm),
          messages: chat.messages
            .filter(({ roomId }) => roomId !== dm)
            .map((message) => (message.botId === botId ? { ...message, botId: null } : message)),
          runs: chat.runs.filter(mine),
          approvals: chat.approvals.filter(mine),
          memories: chat.memories.filter(mine),
          routines,
          firings: chat.firings.filter(({ routineId }) =>
            routines.some(({ id }) => id === routineId),
          ),
          tasks: chat.tasks.filter(
            ({ requesterBotId, ownerBotId }) => requesterBotId !== botId && ownerBotId !== botId,
          ),
          boxes: chat.boxes.filter(mine),
          continuations: chat.continuations.filter(mine),
          // Its own connectors went with it, and its grants on the shared ones.
          connectors: chat.connectors
            .filter(({ ownerBotId }) => ownerBotId !== botId)
            .map((connector) => ({ ...connector, grants: connector.grants.filter(mine) })),
        },
      };
    }
    case "account.changed":
      return { ...state, chat: { ...chat, accounts: upsert(chat.accounts, event.account) } };
    case "message.created":
      return { ...state, chat: { ...chat, messages: [...chat.messages, event.message] } };
    case "run.changed": {
      const { run } = event;
      const previous = chat.runs.find(({ botId }) => botId === run.botId);
      const runs = [...chat.runs.filter(({ botId }) => botId !== run.botId), run];
      const drafts = { ...state.drafts };
      const liveTools = { ...state.liveTools };
      const thinking = { ...state.thinking };
      if (previous && previous.id !== run.id) {
        delete liveTools[previous.id];
      }
      if (!isActive(run)) {
        delete drafts[run.id];
        delete thinking[run.id];
      }
      // A parked run has posted its reply too, and that reply carries the tools.
      if (run.status === "Completed" || run.status === "WaitingUser") {
        delete liveTools[run.id];
      }
      return { ...state, drafts, liveTools, thinking, chat: { ...chat, runs } };
    }
    case "approval.changed":
      return { ...state, chat: { ...chat, approvals: upsert(chat.approvals, event.approval) } };
    case "memory.changed": {
      const { memory } = event;
      // Snapshots hold active and pending only, and replay must land on the same state.
      const memories =
        memory.status === "active" || memory.status === "pending"
          ? upsert(chat.memories, memory)
          : chat.memories.filter(({ id }) => id !== memory.id);
      return { ...state, chat: { ...chat, memories } };
    }
    case "usage.changed": {
      const { limits } = event;
      const others = chat.usageLimits.filter(({ accountId }) => accountId !== limits.accountId);
      return { ...state, chat: { ...chat, usageLimits: [...others, limits] } };
    }
    case "notice.acknowledged":
      return { ...state, chat: { ...chat, noticeAcknowledgedAt: event.acknowledgedAt } };
    case "usage-data.changed":
      return { ...state, chat: { ...chat, usageData: event.on } };
    case "limits.changed":
      return { ...state, chat: { ...chat, limits: event.limits } };
    case "routine.changed":
      return { ...state, chat: { ...chat, routines: upsert(chat.routines, event.routine) } };
    case "routine.deleted": {
      const routines = chat.routines.filter(({ id }) => id !== event.routineId);
      const firings = chat.firings.filter(({ routineId }) => routineId !== event.routineId);
      return { ...state, chat: { ...chat, routines, firings } };
    }
    case "skill.changed": {
      const { skill } = event;
      const others = chat.skills.filter(({ name }) => name !== skill.name);
      const skills = [...others, skill].sort((a, b) => (a.name < b.name ? -1 : 1));
      return { ...state, chat: { ...chat, skills } };
    }
    case "skill.deleted": {
      const skills = chat.skills.filter(({ name }) => name !== event.name);
      return { ...state, chat: { ...chat, skills } };
    }
    case "connector.changed": {
      const { connector } = event;
      const others = chat.connectors.filter(({ id }) => id !== connector.id);
      const connectors = [...others, connector].sort((a, b) =>
        a.name === b.name ? (a.slug < b.slug ? -1 : 1) : a.name < b.name ? -1 : 1,
      );
      return { ...state, chat: { ...chat, connectors } };
    }
    case "connector.deleted": {
      const connectors = chat.connectors.filter(({ id }) => id !== event.connectorId);
      return { ...state, chat: { ...chat, connectors } };
    }
    case "firing.changed": {
      // Snapshots hold each routine's latest only, and replay must land on the same state.
      const { firing } = event;
      const others = chat.firings.filter(({ routineId }) => routineId !== firing.routineId);
      return { ...state, chat: { ...chat, firings: [...others, firing] } };
    }
    case "room.changed":
      return { ...state, chat: { ...chat, rooms: upsert(chat.rooms, event.room) } };
    case "task.changed": {
      // Snapshots hold active tasks only, and replay must land on the same state.
      const { task } = event;
      const tasks = activeTaskStatuses.some((status) => status === task.status)
        ? upsert(chat.tasks, task)
        : chat.tasks.filter(({ id }) => id !== task.id);
      return { ...state, chat: { ...chat, tasks } };
    }
    case "box.changed": {
      const { box } = event;
      const boxes = [...chat.boxes.filter(({ botId }) => botId !== box.botId), box];
      return { ...state, chat: { ...chat, boxes } };
    }
    case "continuation.changed": {
      // Snapshots hold waiting ones only, and replay must land on the same state.
      const { continuation } = event;
      const continuations =
        continuation.status === "waiting"
          ? upsert(chat.continuations, continuation)
          : chat.continuations.filter(({ id }) => id !== continuation.id);
      return { ...state, chat: { ...chat, continuations } };
    }
    case "vault.changed":
      return { ...state, chat: { ...chat, vault: event.vault } };
    case "automated-access.acknowledged":
      return {
        ...state,
        chat: { ...chat, automatedAccessAcknowledgedAt: event.acknowledgedAt },
      };
    case "team-request.changed": {
      // Snapshots hold pending ones only, and replay must land on the same state.
      const { request } = event;
      const teamRequests =
        request.status === "pending"
          ? upsert(chat.teamRequests, request)
          : chat.teamRequests.filter(({ id }) => id !== request.id);
      return { ...state, chat: { ...chat, teamRequests } };
    }
    case "team-settings.changed":
      return { ...state, chat: { ...chat, leadsActWithoutAsking: event.leadsActWithoutAsking } };
    case "meeting.changed": {
      const { meeting } = event;
      const meetings = keepsMeeting(meeting)
        ? upsert(chat.meetings, meeting)
        : chat.meetings.filter(({ id }) => id !== meeting.id);
      return { ...state, chat: { ...chat, meetings } };
    }
  }
}

function keepLive<T>(byRun: Record<string, T>, runs: Run[]) {
  const live = runs.filter(isActive).map(({ id }) => id);
  return Object.fromEntries(Object.entries(byRun).filter(([id]) => live.includes(id)));
}

export function applyServerMessage(state: ConnectionState, message: ServerMessage) {
  switch (message.type) {
    case "snapshot":
      return {
        ...state,
        loaded: true,
        seq: message.seq,
        chat: message.state,
        drafts: keepLive(state.drafts, message.state.runs),
        liveTools: keepLive(state.liveTools, message.state.runs),
        thinking: keepLive(state.thinking, message.state.runs),
      };
    case "delta": {
      const text = (state.drafts[message.runId] ?? "") + message.text;
      return { ...state, drafts: { ...state.drafts, [message.runId]: text } };
    }
    case "thinking": {
      const { runId, active, text } = message;
      const previous = state.thinking[runId]?.text ?? "";
      return {
        ...state,
        thinking: { ...state.thinking, [runId]: { active, text: previous + text } },
      };
    }
    case "tool-start": {
      const { runId, toolId: id, name, detail } = message;
      const known = state.liveTools[runId] ?? [];
      const tools = known.some((tool) => tool.id === id)
        ? known.map((tool) => (tool.id === id ? { ...tool, detail } : tool))
        : [...known, { id, name, detail, status: "running" as const }];
      return { ...state, liveTools: { ...state.liveTools, [runId]: tools } };
    }
    case "tool-end": {
      const { runId, toolId, failed } = message;
      const tools = (state.liveTools[runId] ?? []).map((tool): LiveTool =>
        tool.id === toolId ? { ...tool, status: failed ? "failed" : "done" } : tool,
      );
      return { ...state, liveTools: { ...state.liveTools, [runId]: tools } };
    }
    case "pending-approvals":
      return { ...state, pending: message.approvals };
    case "model-catalog":
      return { ...state, models: message.models };
    case "box-availability":
      return { ...state, boxAvailability: message.availability };
    case "host-control":
      return { ...state, hostControl: message.availability };
    case "thumbnail":
      return { ...state, thumbnails: { ...state.thumbnails, [message.botId]: message.data } };
    case "wall":
      return { ...state, held: message.held };
    case "activity": {
      const seq = (state.activity[message.botId]?.seq ?? 0) + 1;
      return { ...state, activity: { ...state.activity, [message.botId]: { ...message, seq } } };
    }
    case "replay":
    case "event": {
      const incoming = message.type === "replay" ? message.events : [message.event];
      let next = state;
      for (const event of incoming) {
        if (event.seq > next.seq) {
          next = { ...applyEvent(next, event), seq: event.seq };
        }
      }
      return next;
    }
  }
}

// Bodies carry no message content. Snapshots are skipped: they hold history, not news.
export function notificationBodies(state: ConnectionState, message: ServerMessage) {
  const { bots, approvals, routines } = state.chat;
  const name = (botId: string | undefined) => bots.find(({ id }) => id === botId)?.name ?? "A bot";

  if (message.type === "pending-approvals") {
    return message.approvals
      .filter(({ id }) => !state.pending.some((known) => known.id === id))
      .map(({ id }) => `${name(approvals.find((a) => a.id === id)?.botId)} needs your approval`);
  }
  const events =
    message.type === "event" ? [message.event] : message.type === "replay" ? message.events : [];
  return events.flatMap((event) => {
    if (event.seq <= state.seq) {
      return [];
    }
    if (event.type === "run.changed" && event.run.status === "Completed") {
      return [`${name(event.run.botId)} finished`];
    }
    if (event.type === "firing.changed" && event.firing.status === "ready") {
      const routine = routines.find(({ id }) => id === event.firing.routineId);
      return [routineReadyLine(routine?.name ?? "A routine")];
    }
    return [];
  });
}

const params = new URLSearchParams(window.location.search);
// The desktop app hands over its server's address and token. Anywhere else a gateway serves the API
// on this origin and its session cookie signs requests, so no token is read from a link.
const desktop = window.beeDesktop !== undefined;
const serverUrl = desktop ? params.get("serverUrl") : window.location.origin;
const token = desktop ? params.get("token") : null;
const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
// The desktop app's global shortcut for taking the owner's computer back from a bot.
export const stopShortcut = params.get("stopShortcut");

function readLastSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(lastSeenKey) ?? "{}");
  } catch {
    return {};
  }
}

let state: ConnectionState = {
  status: !desktop || (serverUrl && token) ? "connecting" : "unconfigured",
  loaded: false,
  seq: 0,
  chat: {
    bots: [],
    accounts: [],
    messages: [],
    runs: [],
    approvals: [],
    memories: [],
    usageLimits: [],
    routines: [],
    skills: [],
    connectors: [],
    firings: [],
    rooms: [],

    tasks: [],
    noticeAcknowledgedAt: null,
    usageData: null,
    limits: limitDefaults,
    boxes: [],
    continuations: [],
    vault: { apiKeys: [] },
    automatedAccessAcknowledgedAt: null,
    teamRequests: [],
    leadsActWithoutAsking: false,
    meetings: [],
  },
  drafts: {},
  liveTools: {},
  thinking: {},
  pending: [],
  models: undefined,
  boxAvailability: undefined,
  hostControl: undefined,
  engine: undefined,
  engineChecking: false,
  lastSeen: readLastSeen(),
  commandError: undefined,
  thumbnails: {},
  held: [],
  activity: {},
};
const listeners = new Set<() => void>();

function setState(next: ConnectionState) {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

export const getConnectionState = () => state;

export function subscribeToConnection(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function markSeen(botId: string, messageId: string) {
  const lastSeen = { ...state.lastSeen, [botId]: messageId };
  localStorage.setItem(lastSeenKey, JSON.stringify(lastSeen));
  setState({ ...state, lastSeen });
}

export function requestNotifications() {
  if (Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

function endpoint(path: string) {
  const url = new URL(path, serverUrl ?? undefined);
  url.searchParams.set("protocolVersion", String(protocolVersion));
  return url;
}

function wsEndpoint(path: string) {
  const url = endpoint(path);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

// Browsers can't set headers on a WebSocket, so the desktop's token rides in the query.
export function socketUrl(path: string) {
  const url = wsEndpoint(path);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url;
}

let signingIn = false;

// A gateway answers 401 once its session ends. Its sign-in page is /login, where this app never runs.
function signInOn401(status: number) {
  if (status !== 401 || desktop || window.location.pathname === "/login") {
    return false;
  }
  if (!signingIn) {
    signingIn = true;
    const { pathname, search, hash } = window.location;
    window.location.assign(`/login?next=${encodeURIComponent(pathname + search + hash)}`);
  }
  return true;
}

async function apiFetch(url: URL, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, headers: { ...auth, ...init.headers } });
  if (signInOn401(response.status)) {
    throw new Error("Signed out");
  }
  return response;
}

// The login terminal's own socket (R20): its bytes never pass through the event stream.
export function terminalSocketUrl(botId: string, cols: number, rows: number) {
  const url = socketUrl("/terminal");
  url.searchParams.set("botId", botId);
  url.searchParams.set("cols", String(cols));
  url.searchParams.set("rows", String(rows));
  return url;
}

// The ticket stands in for the token, which never rides in this URL.
export function displaySocketUrl(ticket: string) {
  const url = wsEndpoint("/display");
  url.searchParams.set("ticket", ticket);
  return url;
}

let failedAttempts = 0;
let live: WebSocket | undefined;
let wallWatchers = 0;

function sendWall() {
  if (live?.readyState === WebSocket.OPEN) {
    const message: ClientMessage = { type: "wall", watching: wallWatchers > 0 };
    live.send(JSON.stringify(message));
  }
}

// The server takes thumbnails only while some client watches the wall. Returns the unwatch.
export function watchWall() {
  wallWatchers += 1;
  if (wallWatchers === 1) {
    sendWall();
  }
  return () => {
    wallWatchers -= 1;
    if (wallWatchers === 0) {
      sendWall();
    }
  };
}

function sendVisibility() {
  if (live?.readyState === WebSocket.OPEN) {
    const message: ClientMessage = {
      type: "visibility",
      visible: document.visibilityState === "visible",
    };
    live.send(JSON.stringify(message));
  }
}

function reconnect() {
  const delay = Math.min(firstReconnectDelayMs * 2 ** failedAttempts, maxReconnectDelayMs);
  failedAttempts += 1;
  setState({ ...state, status: "disconnected" });
  setTimeout(() => void connect(), delay);
}

async function fetchEngine() {
  try {
    const response = await apiFetch(endpoint("/engine"));
    return response.ok ? EngineStatus.safeParse(await response.json()).data : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchHost() {
  try {
    const response = await apiFetch(endpoint("/host"));
    return response.ok ? HostPlatform.safeParse(await response.json()).data : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchUsage(days: number): Promise<UsageSummary> {
  try {
    const url = endpoint("/usage");
    url.searchParams.set("days", String(days));
    const response = await apiFetch(url);
    return UsageSummary.safeParse(await response.json()).data ?? { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export async function fetchAudit(filter: { botId: string; unattended: boolean }) {
  try {
    const url = endpoint("/audit");
    if (filter.botId) {
      url.searchParams.set("botId", filter.botId);
    }
    url.searchParams.set("unattended", filter.unattended ? "1" : "0");
    const response = await apiFetch(url);
    return AuditPage.safeParse(await response.json()).data;
  } catch {
    return undefined;
  }
}

const refreshNotes = {
  refreshed: undefined,
  busy: "A bot is running, so these update from its turn.",
  throttled: "Checked less than a minute ago.",
  unavailable: undefined,
};

// The rows themselves arrive as an event. What comes back is only why nothing may have changed.
export async function refreshLimits() {
  try {
    const response = await apiFetch(endpoint("/usage/limits"), { method: "POST" });
    const result = UsageRefreshResult.safeParse(await response.json()).data;
    return result ? refreshNotes[result.outcome] : "Could not read limits.";
  } catch {
    return "Can't reach the Bee Bot server. Try again in a moment.";
  }
}

// Each call re-probes the CLI on the server, which can take seconds, so calls never overlap.
export async function checkEngine() {
  if (state.engineChecking) {
    return;
  }
  setState({ ...state, engineChecking: true });
  const engine = await fetchEngine();
  setState({ ...state, engine, engineChecking: false });
}

// A browser can't read the status of a refused WebSocket, so a version mismatch is found over HTTP.
export async function connect() {
  if (state.status === "unconfigured") {
    return;
  }
  // The same listener again on a reconnect is ignored.
  document.addEventListener("visibilitychange", sendVisibility);

  let health: Response;
  try {
    health = await fetch(endpoint("/health"), { headers: auth });
  } catch {
    reconnect();
    return;
  }
  // Also catches a gateway refusing the socket, which a browser can't read: every reconnect lands here.
  if (signInOn401(health.status)) {
    return;
  }
  if (health.status === 426) {
    setState({ ...state, status: "incompatible" });
    return;
  }
  if (!health.ok) {
    reconnect();
    return;
  }

  const socket = new WebSocket(socketUrl("/ws"));
  live = socket;
  socket.onopen = () => {
    const subscribe: ClientMessage = { type: "subscribe", afterSeq: state.seq };
    socket.send(JSON.stringify(subscribe));
    sendVisibility();
    if (wallWatchers > 0) {
      sendWall();
    }
    failedAttempts = 0;
    setState({ ...state, status: "connected" });
    void checkEngine();
  };
  socket.onmessage = (event: MessageEvent<string>) => {
    const message = ServerMessage.parse(JSON.parse(event.data));
    if (!document.hasFocus()) {
      for (const body of notificationBodies(state, message)) {
        void new Notification("Bee Bot", { body });
      }
    }
    setState(applyServerMessage(state, message));
  };
  socket.onclose = reconnect;
}

const errorSentences: Record<string, string> = {
  approval_closed: "This request is already closed.",
  ...routineRefusalLines,
  bot_busy: "This bot is working. Wait for it to finish or stop it, then try again.",
  boxes_unavailable: "Boxes aren't available. Set them up on the Usage page first.",
  boxes_unsupported: "This server can't run boxes.",
  host_control_unavailable: "Bots can't use this computer right now.",
  host_consent_required: "Agree to let this bot use your PC first.",
  no_setup_command: "There's no install command for this computer. Get Podman from podman.io.",
  no_terminal: "Bee Bot couldn't open a terminal. Copy the command and run it in your terminal.",
  terminal_failed: "The terminal didn't open. Copy the command and run it in your terminal.",
  host_screen_failed: "Bee Bot couldn't show your screen. Try again in a moment.",
  bad_egress_host:
    "Enter site names only, like pypi.org: no https://, path, port, wildcard, IP address or local name.",
  automated_access_unacknowledged:
    "Read the notice about bots that run on their own first. It's on the Usage page.",
  credential_conflict:
    "Claude can use your subscription or a saved API key here, not both. To save a key, first set Login to API key in Edit bot. To use your subscription, first remove the saved Claude key on the Usage page.",
  digest_mismatch: "This request changed, so nothing was decided.",
  always_not_allowed: "Always allow isn't available for this request.",
  ambiguous_mention: "More than one bot here goes by that name. Pick one from the @ list.",
  mention_limit: "That names too many bots at once. Mention fewer.",
  no_bot_addressed: "Which bot should answer? Mention one with @, or set a room default.",
  not_member: "That bot isn't in this room.",
  too_many_members: "Everyone answering works for rooms of up to 6 bots.",
  default_bot_required: "Pick a default bot for this room first.",
  bot_archived: "That bot is archived. Restore it first.",
  attachment_not_found: "A file wasn't uploaded, or was already sent. Attach it again.",
  attachment_too_large: "A file can be at most 50 MB.",
  attachment_type: "Bee Bot doesn't accept programs as attachments.",
  engine_not_allowed: "The test engine isn't available here.",
  folder_bee_data: "That folder holds Bee Bot's own data, so bots can't work there.",
  folder_home: "Bots can't work in your whole home folder. Choose a project folder inside it.",
  folder_network: "Network folders aren't supported. Choose a folder on this computer.",
  folder_not_absolute: "Enter the full path to the folder, starting from the drive.",
  folder_not_directory: "That path is a file. Choose a folder.",
  folder_not_found: "That folder doesn't exist.",
  folder_protected: "That folder holds passwords or saved logins, so bots can't work there.",
  folder_root: "Bots can't work in a whole drive. Choose a folder on it.",
  message_id_reused: "That message couldn't be sent. Send it again.",
  not_found: "That's no longer here.",
  protocol_mismatch: "This app and its server don't match. Update Bee Bot.",
  provider_locked: "A bot can't change provider after it's created.",
  storage_failed: "Bee Bot couldn't save that. Try again.",
  unknown_model: "That model isn't available.",
  unsupported_effort: "That model doesn't support this reasoning level.",
  vault_insecure_keyring:
    "This computer has no password manager Bee Bot can use, so it won't save an API key. Set up GNOME Keyring or KWallet, then restart Bee Bot.",
  vault_keyring_unavailable:
    "Bee Bot can't reach this computer's password manager, so it won't save an API key.",
  vault_key_unreadable:
    "Bee Bot can't read its vault key, so it won't save an API key. Your saved keys are unchanged.",
  vault_no_key:
    "This server has no vault key file, so it won't save an API key. Set BEEBOT_VAULT_KEY_FILE and restart it.",
  vault_wrong_key:
    "The vault key doesn't match the keys already saved. Delete the saved keys, then save them again.",
  vault_corrupt: "A saved key is damaged. Delete it and save it again.",
  skill_exists: "A skill with that name is already in the library. Delete it first to replace it.",
  skill_not_folder: "Choose a folder that holds a SKILL.md.",
  skill_unreadable: "Bee Bot couldn't read that folder.",
  skill_md_missing: "There's no SKILL.md at the top of that folder.",
  skill_md_too_large: "SKILL.md is over 256 KB.",
  skill_too_many_files: "A skill can hold at most 200 files.",
  skill_too_large: "A skill can hold at most 16 MB.",
  skill_bad_path:
    "A skill can't hold hidden files, links, or names Windows refuses. Remove this one and try again:",
  skill_link: "A skill can't hold links to other places. Copy the file in instead, then try again:",
  skill_no_front_matter: "SKILL.md must start with a --- block naming the skill and describing it.",
  skill_bad_name:
    "The skill's name must be lowercase letters, numbers and single dashes, at most 64 long.",
  skill_bad_description: "The skill needs a description of at most 1024 characters.",
  skill_not_reviewed: "Read the skill's SKILL.md and mark it reviewed before turning it on.",
  skill_changed: "This skill changed since you reviewed it. Review it again first.",
  connector_bad_url: "That isn't a URL Bee Bot can use.",
  connector_url_not_https: "Use an https:// address. Plain http works only for this computer.",
  connector_url_credentials: "Take the name and password out of the URL, and save a token instead.",
  connector_private_address: "That address is on a private network, which bots may not reach.",
  connector_bad_header:
    "One of those headers isn't allowed: Host, Cookie, Proxy-* and Sec-* headers, or values with line breaks.",
  connector_bad_env: "An environment variable name must be letters, digits and underscores.",
  connector_bad_json: 'That isn\'t an mcpServers block. Paste JSON like {"mcpServers": {...}}.',
  connector_bad_entry: "That entry needs a url, or a command for a local server.",
  connector_slug_taken: "A connector with that name is already added.",
  connector_changed: "Its tools changed while you were reviewing. Review the new list.",
  connector_private: "That connector belongs to another bot.",
  connector_sign_in_failed: "Couldn't start the sign-in. Check the URL, or try again later.",
};

function errorSentence(body: unknown) {
  const code = body && typeof body === "object" && "code" in body ? String(body.code) : "";
  const path = body && typeof body === "object" && "path" in body ? body.path : undefined;
  const sentence = errorSentences[code] ?? "That didn't work. Try again.";
  return typeof path === "string" ? `${sentence} ${path}` : sentence;
}

type CommandResult = { ok: true; body: unknown } | { ok: false; message: string };

// For callers that show their own failure. `message` is always a plain sentence.
export async function postCommand(command: Command): Promise<CommandResult> {
  try {
    const response = await apiFetch(endpoint("/commands"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    const body: unknown = await response.json();
    return response.ok ? { ok: true, body } : { ok: false, message: errorSentence(body) };
  } catch {
    return { ok: false, message: "Can't reach the Bee Bot server. Try again in a moment." };
  }
}

// XMLHttpRequest, not fetch: only it reports how much of the upload has gone.
export function uploadAttachment(
  roomId: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ ok: true; attachment: AttachmentRef } | { ok: false; message: string }> {
  const url = endpoint("/attachments");
  url.searchParams.set("room", roomId);
  url.searchParams.set("name", file.name);
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    for (const [name, value] of Object.entries(auth)) {
      request.setRequestHeader(name, value);
    }
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.upload.onprogress = ({ loaded, total }) => onProgress(total > 0 ? loaded / total : 0);
    request.onload = () => {
      if (signInOn401(request.status)) {
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        body = undefined;
      }
      const parsed = AttachmentRef.safeParse(body);
      resolve(
        request.status === 200 && parsed.success
          ? { ok: true, attachment: parsed.data }
          : { ok: false, message: errorSentence(body) },
      );
    };
    request.onerror = () =>
      resolve({ ok: false, message: "Can't reach the Bee Bot server. Try again in a moment." });
    request.send(file);
  });
}

// A link can't carry the token, so the bytes come through fetch and leave as a blob.
export async function downloadAttachment({ id, name }: AttachmentRef) {
  try {
    const response = await apiFetch(endpoint(`/attachments/${id}`));
    if (!response.ok) {
      throw new Error(String(response.status));
    }
    const href = URL.createObjectURL(await response.blob());
    Object.assign(document.createElement("a"), { href, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  } catch {
    setState({ ...state, commandError: "Could not download the file. Try again in a moment." });
  }
}

// For quick actions with no place of their own: a failure shows above the composer.
export async function sendCommand(command: Command) {
  const result = await postCommand(command);
  setState({ ...state, commandError: result.ok ? undefined : result.message });
}
