import {
  AuditPage,
  type ChatState,
  type ClientMessage,
  type Command,
  EngineStatus,
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

// Lives only in this client's memory: after a reload a finished turn has names alone.
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
  // Tool rows of replies finished since this client connected, by message ID.
  finishedTools: Record<string, LiveTool[]>;
  // Card content for pending approvals. The server resends the whole set, so it is never merged.
  pending: PendingApproval[];
  // Undefined until the server sends it, so no model is called unavailable before then.
  models: ModelCatalog | undefined;
  engine: EngineStatus | undefined;
  engineChecking: boolean;
  // Last bot message read, by bot ID. Mirrors localStorage.
  lastSeen: Record<string, string>;
  commandError: string | undefined;
};

export const isActive = (run: Run | undefined) =>
  run?.status === "Queued" || run?.status === "Running";

export function openCards({ routines, firings }: ChatState, botId: string) {
  return firings.flatMap((firing) => {
    const routine = routines.find(({ id }) => id === firing.routineId);
    return routine?.botId === botId && firing.status === "ready" ? [{ routine, firing }] : [];
  });
}

function upsert<T extends { id: string }>(items: T[], item: T) {
  return items.some(({ id }) => id === item.id)
    ? items.map((existing) => (existing.id === item.id ? item : existing))
    : [...items, item];
}

// A tool still open when its turn ended was cut off, not failed: the engine never said.
const settled = (tools: LiveTool[]) =>
  tools.map((tool): LiveTool => (tool.status === "running" ? { ...tool, status: "done" } : tool));

function applyEvent(state: ConnectionState, event: ServerEvent) {
  const { chat } = state;
  switch (event.type) {
    case "bot.changed":
      return { ...state, chat: { ...chat, bots: upsert(chat.bots, event.bot) } };
    case "account.changed":
      return { ...state, chat: { ...chat, accounts: upsert(chat.accounts, event.account) } };
    case "message.created": {
      const { message } = event;
      const next = { ...state, chat: { ...chat, messages: [...chat.messages, message] } };
      const botId = chat.bots.find(({ roomId }) => roomId === message.roomId)?.id;
      const runId = chat.runs.find((run) => run.botId === botId)?.id;
      const tools = runId && state.liveTools[runId];
      return message.author === "bot" && tools
        ? { ...next, finishedTools: { ...state.finishedTools, [message.id]: settled(tools) } }
        : next;
    }
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
    case "routine.changed":
      return { ...state, chat: { ...chat, routines: upsert(chat.routines, event.routine) } };
    case "routine.deleted": {
      const routines = chat.routines.filter(({ id }) => id !== event.routineId);
      const firings = chat.firings.filter(({ routineId }) => routineId !== event.routineId);
      return { ...state, chat: { ...chat, routines, firings } };
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
      // Snapshots hold open tasks only, and replay must land on the same state.
      const { task } = event;
      const tasks =
        task.status === "open"
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
const serverUrl = params.get("serverUrl");
const token = params.get("token");

function readLastSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(lastSeenKey) ?? "{}");
  } catch {
    return {};
  }
}

let state: ConnectionState = {
  status: serverUrl && token ? "connecting" : "unconfigured",
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
    firings: [],
    rooms: [],
    tasks: [],
    noticeAcknowledgedAt: null,
    boxes: [],
    continuations: [],
    vault: { apiKeys: [] },
    automatedAccessAcknowledgedAt: null,
  },
  drafts: {},
  liveTools: {},
  thinking: {},
  finishedTools: {},
  pending: [],
  models: undefined,
  engine: undefined,
  engineChecking: false,
  lastSeen: readLastSeen(),
  commandError: undefined,
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

// The login terminal's own socket (R20): its bytes never pass through the event stream.
export function terminalSocketUrl(botId: string, cols: number, rows: number) {
  const url = endpoint("/terminal");
  url.protocol = "ws:";
  url.searchParams.set("token", token ?? "");
  url.searchParams.set("botId", botId);
  url.searchParams.set("cols", String(cols));
  url.searchParams.set("rows", String(rows));
  return url;
}

// Browsers can't set headers on a WebSocket, so the token rides in the query.
export function socketUrl(path: string) {
  const url = endpoint(path);
  url.protocol = "ws:";
  url.searchParams.set("token", token ?? "");
  return url;
}

let failedAttempts = 0;

function reconnect() {
  const delay = Math.min(firstReconnectDelayMs * 2 ** failedAttempts, maxReconnectDelayMs);
  failedAttempts += 1;
  setState({ ...state, status: "disconnected" });
  setTimeout(() => void connect(), delay);
}

async function fetchEngine() {
  try {
    const response = await fetch(endpoint("/engine"), {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok ? EngineStatus.safeParse(await response.json()).data : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchUsage(days: number): Promise<UsageSummary> {
  try {
    const url = endpoint("/usage");
    url.searchParams.set("days", String(days));
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
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
    const response = await fetch(endpoint("/usage/limits"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
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
  if (!serverUrl || !token) {
    return;
  }

  let health: Response;
  try {
    health = await fetch(endpoint("/health"), { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    reconnect();
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
  socket.onopen = () => {
    const subscribe: ClientMessage = { type: "subscribe", afterSeq: state.seq };
    socket.send(JSON.stringify(subscribe));
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
  digest_mismatch: "This request changed, so nothing was decided.",
  always_not_allowed: "Always allow isn't available for this request.",
  ambiguous_mention: "More than one bot here goes by that name. Pick one from the @ list.",
  mention_limit: "That names too many bots at once. Mention fewer.",
  no_bot_addressed: "Which bot should answer? Mention one with @, or set a room default.",
  not_member: "That bot isn't in this room.",
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
};

function errorSentence(body: unknown) {
  const code = body && typeof body === "object" && "code" in body ? String(body.code) : "";
  return errorSentences[code] ?? "That didn't work. Try again.";
}

type CommandResult = { ok: true; body: unknown } | { ok: false; message: string };

// For callers that show their own failure. `message` is always a plain sentence.
export async function postCommand(command: Command): Promise<CommandResult> {
  try {
    const response = await fetch(endpoint("/commands"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    const body: unknown = await response.json();
    return response.ok ? { ok: true, body } : { ok: false, message: errorSentence(body) };
  } catch {
    return { ok: false, message: "Can't reach the Bee Bot server. Try again in a moment." };
  }
}

// For quick actions with no place of their own: a failure shows above the composer.
export async function sendCommand(command: Command) {
  const result = await postCommand(command);
  setState({ ...state, commandError: result.ok ? undefined : result.message });
}
