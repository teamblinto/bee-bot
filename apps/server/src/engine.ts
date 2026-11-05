import { once } from "node:events";
import * as NodeTimers from "node:timers/promises";

import type { PauseReason } from "@beebot/contracts";

export type TurnOutcome =
  | { kind: "completed"; text: string }
  | { kind: "failed" }
  | { kind: "limited"; retryAfterMs: number }
  | { kind: "auth_failed"; pauseReason?: PauseReason }
  // The engine no longer has this session: the supervisor restarts from the room digest.
  | { kind: "session_lost" };

export type BotLaunch = {
  botId: string;
  name: string;
  personality: string;
  engineAccountId: string;
};

// Must settle once `signal` aborts: the supervisor finalizes a run only after its turn has ended.
export type RunTurn = (turn: {
  prompt: string;
  sessionId: string;
  resume: boolean;
  launch: BotLaunch;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  // Call once the prompt reached the engine: from then on it must never be sent again.
  onDelivered: () => void;
}) => Promise<TurnOutcome>;

const wordDelayMs = 40;
const defaultLimitSeconds = 30;

// The last line of the prompt scripts the turn: /fail, /auth, /limit [seconds], /hang.
// Anything else streams a reply word by word.
export const fakeRunTurn: RunTurn = async ({ prompt, signal, onDelta }) => {
  const [directive, argument] = (prompt.split("\n").at(-1) ?? "").trim().split(/\s+/);
  switch (directive) {
    case "/fail":
      return { kind: "failed" };
    case "/auth":
      return { kind: "auth_failed" };
    case "/limit":
      return { kind: "limited", retryAfterMs: (Number(argument) || defaultLimitSeconds) * 1000 };
    case "/hang":
      if (!signal.aborted) {
        await once(signal, "abort");
      }
      return { kind: "failed" };
    default: {
      const text = `Test engine reply: ${prompt}`;
      for (const word of text.split(/(?<=\s)/)) {
        await NodeTimers.setTimeout(wordDelayMs, undefined, { signal });
        onDelta(word);
      }
      return { kind: "completed", text };
    }
  }
};
