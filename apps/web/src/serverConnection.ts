import {
  Bot,
  type ChatState,
  type ClientMessage,
  type Command,
  ProtocolNotice,
  protocolVersion,
  type Run,
  type ServerEvent,
  ServerMessage,
} from "@beebot/contracts";

const reconnectDelayMs = 1000;

export type ConnectionState = {
  status: "unconfigured" | "connecting" | "connected" | "disconnected" | "incompatible";
  notice: string | undefined;
  seq: number;
  chat: ChatState;
  // Live output by run ID. Lost on a reconnect; the final reply arrives as a message.
  drafts: Record<string, string>;
  commandError: string | undefined;
};

export const isActive = (run: Run | undefined) =>
  run?.status === "Queued" || run?.status === "Running";

function upsert<T extends { id: string }>(items: T[], item: T) {
  return items.some(({ id }) => id === item.id)
    ? items.map((existing) => (existing.id === item.id ? item : existing))
    : [...items, item];
}

function applyEvent(state: ConnectionState, event: ServerEvent) {
  const { chat } = state;
  switch (event.type) {
    case "bot.changed":
      return { ...state, chat: { ...chat, bots: upsert(chat.bots, event.bot) } };
    case "account.changed":
      return { ...state, chat: { ...chat, accounts: upsert(chat.accounts, event.account) } };
    case "message.created":
      return { ...state, chat: { ...chat, messages: [...chat.messages, event.message] } };
    case "run.changed": {
      const { run } = event;
      const runs = [...chat.runs.filter(({ botId }) => botId !== run.botId), run];
      const drafts = { ...state.drafts };
      if (!isActive(run)) {
        delete drafts[run.id];
      }
      return { ...state, drafts, chat: { ...chat, runs } };
    }
  }
}

export function applyServerMessage(state: ConnectionState, message: ServerMessage) {
  switch (message.type) {
    case "snapshot": {
      const live = message.state.runs.filter(isActive).map(({ id }) => id);
      const drafts = Object.fromEntries(
        Object.entries(state.drafts).filter(([id]) => live.includes(id)),
      );
      return { ...state, seq: message.seq, chat: message.state, drafts };
    }
    case "delta": {
      const text = (state.drafts[message.runId] ?? "") + message.text;
      return { ...state, drafts: { ...state.drafts, [message.runId]: text } };
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

const params = new URLSearchParams(window.location.search);
const serverUrl = params.get("serverUrl");
const token = params.get("token");

let state: ConnectionState = {
  status: serverUrl && token ? "connecting" : "unconfigured",
  notice: undefined,
  seq: 0,
  chat: { bots: [], accounts: [], messages: [], runs: [] },
  drafts: {},
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

function endpoint(path: string) {
  const url = new URL(path, serverUrl ?? undefined);
  url.searchParams.set("protocolVersion", String(protocolVersion));
  return url;
}

function reconnect() {
  setState({ ...state, status: "disconnected" });
  setTimeout(() => void connect(), reconnectDelayMs);
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
    const notice = ProtocolNotice.parse(await health.json());
    setState({ ...state, status: "incompatible", notice: notice.message });
    return;
  }
  if (!health.ok) {
    reconnect();
    return;
  }

  const url = endpoint("/ws");
  url.protocol = "ws:";
  url.searchParams.set("token", token);
  const socket = new WebSocket(url);
  socket.onopen = () => {
    const subscribe: ClientMessage = { type: "subscribe", afterSeq: state.seq };
    socket.send(JSON.stringify(subscribe));
    setState({ ...state, status: "connected" });
  };
  socket.onmessage = (message: MessageEvent<string>) => {
    setState(applyServerMessage(state, ServerMessage.parse(JSON.parse(message.data))));
  };
  socket.onclose = reconnect;
}

// Answers undefined on failure, after reporting it in `commandError`.
export async function sendCommand(command: Command) {
  try {
    const response = await fetch(endpoint("/commands"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!response.ok) {
      throw new Error(`The server answered ${response.status}.`);
    }
    const body: unknown = await response.json();
    setState({ ...state, commandError: undefined });
    return body;
  } catch (error) {
    setState({ ...state, commandError: String(error) });
    return undefined;
  }
}

export async function createBot(
  name: string,
  personality: string,
  engineAccountId: "claude" | "fake",
) {
  const command = { type: "create-bot", name, personality, engineAccountId } as const;
  return Bot.safeParse(await sendCommand(command)).data;
}
