import * as NodeCrypto from "node:crypto";

import { admit } from "./admission.ts";
import type { Approvals } from "./approvals.ts";
import type { RunTurn, ThinkingState, ToolStart, TurnOutcome } from "./engine.ts";
import type { ClaimedRun, EventStore, FinishedRun, Wake } from "./store.ts";

const defaultTurnTimeoutMs = 10 * 60_000;
const tickMs = 1000;
const minBlockMs = 1000;
const maxBlockMs = 24 * 60 * 60_000;
const deltaBatchMs = 50;

type Options = {
  store: EventStore;
  runTurn: RunTurn;
  approvals: Approvals;
  permissionsUrl: () => string;
  onDelta: (runId: string, text: string) => void;
  onToolStart: (runId: string, tool: ToolStart) => void;
  onToolEnd: (runId: string, id: string, failed: boolean) => void;
  onThinking: (runId: string, state: ThinkingState) => void;
  turnTimeoutMs?: number | undefined;
};

// A limit or auth failure is a fact about the account, so it holds even if the turn was aborted.
// A finished reply holds too: a stop or timeout landing after `result` has nothing left to stop.
function finishedRun(outcome: TurnOutcome, abortReason: unknown, tools: string[]): FinishedRun {
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
  if (outcome.kind === "completed") {
    return { status: "Completed", reason: null, reply: outcome.text, tools };
  }
  if (abortReason === "stop") {
    return { status: "Cancelled", reason: "stopped" };
  }
  return abortReason === "timeout"
    ? { status: "Failed", reason: "timeout" }
    : { status: "Failed", reason: "engine_failed" };
}

// Everything else a run emits flushes first, so a client sees the turn in the order it happened.
function batchDeltas(send: (text: string) => void) {
  let pending = "";
  let timer: NodeJS.Timeout | undefined;
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (pending) {
      const text = pending;
      pending = "";
      send(text);
    }
  }
  return {
    flush,
    add(text: string) {
      pending += text;
      timer ??= setTimeout(flush, deltaBatchMs);
    },
  };
}

export function createSupervisor({
  store,
  runTurn,
  approvals,
  permissionsUrl,
  onDelta,
  onToolStart,
  onToolEnd,
  onThinking,
  turnTimeoutMs = defaultTurnTimeoutMs,
}: Options) {
  const bootId = NodeCrypto.randomUUID();
  const turns = new Map<
    string,
    {
      controller: AbortController;
      ended: Promise<void>;
      pauseClock: () => void;
      resumeClock: () => void;
    }
  >();
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
    const token = approvals.openRun(run.id, run.launch.botId);
    const tools: string[] = [];
    const seenTools = new Set<string>();
    const deltas = batchDeltas((text) => onDelta(run.id, text));
    let remainingMs = turnTimeoutMs;
    let resumedAt = 0;
    let timeout: NodeJS.Timeout | undefined;
    const resumeClock = () => {
      if (!timeout) {
        resumedAt = Date.now();
        timeout = setTimeout(() => controller.abort("timeout"), remainingMs);
      }
    };
    const pauseClock = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
        remainingMs = Math.max(remainingMs - (Date.now() - resumedAt), 0);
      }
    };
    resumeClock();
    const attempt = (prompt: string, sessionId: string, resume: boolean) =>
      runTurn({
        prompt,
        sessionId,
        resume,
        launch: run.launch,
        signal: controller.signal,
        onDelta: deltas.add,
        onToolStart: (tool) => {
          deltas.flush();
          if (!seenTools.has(tool.id)) {
            seenTools.add(tool.id);
            tools.push(tool.name);
            if (!tool.name.startsWith("mcp__bee__")) {
              try {
                store.markTainted(run.id);
              } catch (error) {
                console.error(`beebotd: taint of run ${run.id} was not recorded`, error);
              }
            }
          }
          onToolStart(run.id, tool);
        },
        onToolEnd: (id, failed) => {
          deltas.flush();
          onToolEnd(run.id, id, failed);
        },
        onThinking: (state) => {
          deltas.flush();
          onThinking(run.id, state);
        },
        permissions: { url: permissionsUrl(), token },
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
        deltas.flush();
        pauseClock();
        turns.delete(run.id);
        approvals.closeRun(run.id);
        // Left Running on purpose: the next boot marks it Interrupted.
        if (!closing) {
          try {
            store.finishRun(run.id, bootId, finishedRun(outcome, controller.signal.reason, tools));
          } catch (error) {
            // A run left Running would hold its bot and account until the next boot.
            console.error(`beebotd: run ${run.id} did not finish cleanly`, error);
            store.finishRun(run.id, bootId, { status: "Failed", reason: "engine_failed" });
          }
          pump();
        }
      })
      .catch((error: unknown) => console.error(error));
    turns.set(run.id, { controller, ended, pauseClock, resumeClock });
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
      approvals.closeRun(running);
      turns.get(running)?.controller.abort("stop");
    }
  }

  // A turn waiting on the owner isn't using its time.
  function syncClocks() {
    for (const [runId, { pauseClock, resumeClock }] of turns) {
      if (approvals.isHolding(runId)) {
        pauseClock();
      } else {
        resumeClock();
      }
    }
  }

  const ticker = setInterval(pump, tickMs);
  ticker.unref();

  return {
    pump,
    stopBot,
    syncClocks,
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
