import {
  type Bot,
  type ChatState,
  ClientMessage,
  protocolVersion,
  type Routine,
  ServerMessage,
  type ServerEvent,
} from "@beebot/contracts";

const reconnectMs = 2000;

type Known = { bots: Map<string, Bot>; routines: Map<string, Routine> };
export type Notice = { title: string; body: string };

export const knownFrom = (state: Pick<ChatState, "bots" | "routines">): Known => ({
  bots: new Map(state.bots.map((bot) => [bot.id, bot])),
  routines: new Map(state.routines.map((routine) => [routine.id, routine])),
});

// Only what the owner has to act on. Call before `apply`, which forgets the previous bot status.
export function noticeFor(event: ServerEvent, { bots, routines }: Known): Notice | undefined {
  const botName = (id: string | undefined) => (id && bots.get(id)?.name) || "Bee Bot";
  switch (event.type) {
    case "approval.changed":
      return event.approval.status === "pending"
        ? { title: botName(event.approval.botId), body: "Waiting for your approval." }
        : undefined;
    case "bot.changed": {
      const { bot } = event;
      const newlyPaused = bot.status === "paused" && bots.get(bot.id)?.status !== "paused";
      return newlyPaused && bot.pauseReason !== "owner"
        ? { title: bot.name, body: "Paused. Open Bee Bot to see why." }
        : undefined;
    }
    case "firing.changed": {
      const routine = routines.get(event.firing.routineId);
      return event.firing.status === "ready"
        ? {
            title: botName(routine?.botId),
            body: `${routine?.name ?? "A routine"} is ready to start.`,
          }
        : undefined;
    }
    default:
      return undefined;
  }
}

export function apply(event: ServerEvent, { bots, routines }: Known) {
  if (event.type === "bot.changed") {
    bots.set(event.bot.id, event.bot);
  } else if (event.type === "routine.changed") {
    routines.set(event.routine.id, event.routine);
  } else if (event.type === "routine.deleted") {
    routines.delete(event.routineId);
  }
}

// Reconnects until stopped, since the supervisor restarts the server on the same port and token.
export function watchNotices(serverUrl: string, token: string, notify: (notice: Notice) => void) {
  const url = new URL("/ws", serverUrl.replace(/^http/, "ws"));
  url.search = new URLSearchParams({ token, protocolVersion: String(protocolVersion) }).toString();
  let known: Known = knownFrom({ bots: [], routines: [] });
  let afterSeq = 0;
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const handle = (message: ServerMessage) => {
    if (message.type === "snapshot") {
      known = knownFrom(message.state);
      afterSeq = message.seq;
    } else if (message.type === "replay") {
      for (const event of message.events) {
        apply(event, known);
        afterSeq = event.seq;
      }
    } else if (message.type === "event") {
      const notice = noticeFor(message.event, known);
      apply(message.event, known);
      afterSeq = message.event.seq;
      if (notice) {
        notify(notice);
      }
    }
  };

  const connect = () => {
    const current = new WebSocket(url);
    socket = current;
    current.addEventListener("open", () => {
      current.send(JSON.stringify(ClientMessage.parse({ type: "subscribe", afterSeq })));
    });
    current.addEventListener("message", ({ data }) => {
      const parsed = typeof data === "string" ? ServerMessage.safeParse(JSON.parse(data)) : null;
      if (parsed?.success) {
        handle(parsed.data);
      }
    });
    current.addEventListener("close", () => {
      if (!stopped) {
        retry = setTimeout(connect, reconnectMs);
      }
    });
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket?.close();
  };
}
