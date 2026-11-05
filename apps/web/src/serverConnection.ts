import {
  type ClientMessage,
  DiagnosticResult,
  ProtocolNotice,
  protocolVersion,
  type ServerEvent,
  ServerMessage,
} from "@beebot/contracts";

const reconnectDelayMs = 1000;

export type ConnectionState = {
  status: "unconfigured" | "connecting" | "connected" | "disconnected" | "incompatible";
  notice: string | undefined;
  seq: number;
  events: ServerEvent[];
  lastCommandSeq: number | undefined;
  commandError: string | undefined;
};

export function applyServerMessage(state: ConnectionState, message: ServerMessage) {
  if (message.type === "snapshot") {
    return { ...state, seq: message.seq, events: message.events };
  }
  const incoming = message.type === "replay" ? message.events : [message.event];
  const fresh = incoming.filter((event) => event.seq > state.seq);
  return {
    ...state,
    seq: fresh.at(-1)?.seq ?? state.seq,
    events: [...state.events, ...fresh],
  };
}

const params = new URLSearchParams(window.location.search);
const serverUrl = params.get("serverUrl");
const token = params.get("token");

let state: ConnectionState = {
  status: serverUrl && token ? "connecting" : "unconfigured",
  notice: undefined,
  seq: 0,
  events: [],
  lastCommandSeq: undefined,
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

function request(path: string, method: string) {
  return fetch(endpoint(path), { method, headers: { Authorization: `Bearer ${token}` } });
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
    health = await request("/health", "GET");
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

export async function runDiagnostic() {
  try {
    const response = await request("/commands/diagnostic", "POST");
    if (!response.ok) {
      throw new Error(`The server answered ${response.status}.`);
    }
    const { event } = DiagnosticResult.parse(await response.json());
    setState({ ...state, lastCommandSeq: event.seq, commandError: undefined });
  } catch (error) {
    setState({ ...state, commandError: String(error) });
  }
}
