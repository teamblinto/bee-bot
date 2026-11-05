import * as NodeCrypto from "node:crypto";

import { admit } from "./admission.ts";
import type { RunTurn, TurnOutcome } from "./engine.ts";
import type { ClaimedRun, EventStore, FinishedRun, Wake } from "./store.ts";

const defaultTurnTimeoutMs = 10 * 60_000;
const tickMs = 1000;
const minBlockMs = 1000;
const maxBlockMs = 24 * 60 * 60_000;

type Options = {
  store: EventStore;
  runTurn: RunTurn;
  onDelta: (runId: string, text: string) => void;
  turnTimeoutMs?: number | undefined;
};

// A limit or auth failure is a fact about the account, so it holds even if the turn was aborted.
function finishedRun(outcome: TurnOutcome, abortReason: unknown): FinishedRun {
  if (outcome.kind === "limited") {
    const blockMs = Math.min(Math.max(outcome.retryAfterMs, minBlockMs), maxBlockMs);
    return {
      status: "Failed",
      reason: "limited",
      blockedUntil: new Date(Date.now() + blockMs).toISOString(),
    };
  }
  if (outcome.kind === "auth_failed") {
    return {
      status: "Failed",
      reason: "auth_failed",
      pauseBot: outcome.pauseReason ?? "auth_failed",
    };
  }
  if (abortReason === "stop") {
    return { status: "Cancelled", reason: "stopped" };
  }
  if (abortReason === "timeout") {
    return { status: "Failed", reason: "timeout" };
  }
  return outcome.kind === "completed"
    ? { status: "Completed", reason: null, reply: outcome.text }
    : { status: "Failed", reason: "engine_failed" };
}

export function createSupervisor({
  store,
  runTurn,
  onDelta,
  turnTimeoutMs = defaultTurnTimeoutMs,
}: Options) {
  const bootId = NodeCrypto.randomUUID();
  const turns = new Map<string, { controller: AbortController; ended: Promise<void> }>();
  let closing = false;

  store.recover(bootId);

  function settleWake(wake: Wake, now: string) {
    const { hasActiveRun, hasInput, ...admission } = store.wakeContext(wake, now);
    if (hasActiveRun) {
      return;
    }
    // Everything this wake was for was already answered by a run that started after it.
    if (!hasInput) {
      store.closeWake(wake.id);
      return;
    }
    const decision = admit({ ...admission, attended: wake.attended, now });
    if (decision.verdict === "refuse") {
      store.refuseWake(wake, decision.reason);
    } else if (decision.verdict === "defer") {
      store.deferWake(wake.id, decision.until);
    } else {
      store.queueRun(wake);
    }
  }

  function startTurn(run: ClaimedRun) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("timeout"), turnTimeoutMs);
    const attempt = (prompt: string, sessionId: string, resume: boolean) =>
      runTurn({
        prompt,
        sessionId,
        resume,
        launch: run.launch,
        signal: controller.signal,
        onDelta: (text) => onDelta(run.id, text),
        onDelivered: () => {
          try {
            store.markDelivered(run.id);
          } catch (error) {
            console.error(`beebotd: delivery of run ${run.id} was not recorded`, error);
          }
        },
      });
    const turn = (async () => {
      const outcome = await attempt(run.prompt, run.sessionId, run.resume);
      if (outcome.kind !== "session_lost" || controller.signal.aborted) {
        return outcome;
      }
      const { prompt, sessionId } = store.restartSession(run.id);
      return attempt(prompt, sessionId, false);
    })();
    const ended = turn
      .catch((error: unknown): TurnOutcome => {
        // Engine errors can quote the prompt, so only the kind of error is logged.
        console.error(`beebotd: turn ${run.id} threw ${(error as Error)?.name}`);
        return { kind: "failed" };
      })
      .then((outcome) => {
        clearTimeout(timeout);
        turns.delete(run.id);
        // Left Running on purpose: the next boot marks it Interrupted.
        if (!closing) {
          try {
            store.finishRun(run.id, bootId, finishedRun(outcome, controller.signal.reason));
          } catch (error) {
            // A run left Running would hold its bot and account until the next boot.
            console.error(`beebotd: run ${run.id} did not finish cleanly`, error);
            store.finishRun(run.id, bootId, { status: "Failed", reason: "engine_failed" });
          }
          pump();
        }
      })
      .catch((error: unknown) => console.error(error));
    turns.set(run.id, { controller, ended });
  }

  function startRun(runId: string, botId: string, now: string) {
    if (store.botStatus(botId) === "paused") {
      store.refuseQueuedRun(runId, "bot_paused");
      return;
    }
    const claimed = store.claimRun(runId, bootId, now);
    if (claimed) {
      startTurn(claimed);
    }
  }

  // Synchronous and row by row, so one bad row can't block the others or the boot.
  function pump() {
    if (closing) {
      return;
    }
    const now = new Date().toISOString();
    try {
      store.clearExpiredBlocks(now);
      for (const wake of store.dueWakes(now)) {
        try {
          settleWake(wake, now);
        } catch (error) {
          console.error(`beebotd: wake ${wake.id} failed`, error);
        }
      }
      for (const run of store.queuedRuns()) {
        try {
          startRun(run.id, run.botId, now);
        } catch (error) {
          console.error(`beebotd: run ${run.id} failed`, error);
        }
      }
    } catch (error) {
      console.error(error);
    }
  }

  function stopBot(botId: string) {
    const running = store.stopBot(botId);
    if (running) {
      turns.get(running)?.controller.abort("stop");
    }
  }

  const ticker = setInterval(pump, tickMs);
  ticker.unref();

  return {
    pump,
    stopBot,
    stopAll: () => {
      for (const botId of store.botIds()) {
        stopBot(botId);
      }
    },
    close: async () => {
      closing = true;
      clearInterval(ticker);
      const ending = [...turns.values()];
      for (const { controller } of ending) {
        controller.abort("shutdown");
      }
      await Promise.all(ending.map(({ ended }) => ended));
    },
  };
}
