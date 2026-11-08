import * as NodeCrypto from "node:crypto";

import { admit } from "./admission.ts";
import type { Approvals } from "./approvals.ts";
import type { RunTurn, ThinkingState, ToolStart, TurnOutcome } from "./engine.ts";
import { createOutboxWorker, type Deliver } from "./outbox.ts";
import { continueCap, recoveryVerdict } from "./recovery.ts";
import type { ClaimedRun, EventStore, FinishedRun, Wake } from "./store.ts";
import type { WindowUpdate } from "./usage.ts";
import { createAwakeClock, createWatchdog } from "./watchdog.ts";

const defaultTurnTimeoutMs = 10 * 60_000;
const defaultSilenceMs = 5 * 60_000;
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
  onRateLimit?: ((accountId: string, updates: WindowUpdate[]) => void) | undefined;
  onTurnEnded?: ((accountId: string) => void) | undefined;
  // A usage check can race a turn's token refresh, so a turn waits for it.
  accountHeld?: ((accountId: string) => boolean) | undefined;
  turnTimeoutMs?: number | undefined;
  silenceMs?: number | undefined;
  outboxHandlers?: ReadonlyMap<string, Deliver> | undefined;
  now?: (() => number) | undefined;
};

// A limit or auth failure is a fact about the account, so it holds even if the turn was aborted.
// A finished reply holds too: a stop or timeout landing after `result` has nothing left to stop.
function finishedRun(
  outcome: TurnOutcome,
  abortReason: unknown,
  tools: string[],
  parked: boolean,
): FinishedRun {
  if (outcome.kind === "limited") {
    const blockMs = Math.min(Math.max(outcome.retryAfterMs, minBlockMs), maxBlockMs);
    return {
      status: "WaitingQuota",
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
    return {
      status: parked ? "WaitingUser" : "Completed",
      reason: null,
      reply: outcome.text,
      tools,
    };
  }
  if (outcome.kind === "folder_missing") {
    return { status: "Failed", reason: "folder_missing" };
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
  onRateLimit,
  onTurnEnded,
  accountHeld,
  turnTimeoutMs = defaultTurnTimeoutMs,
  silenceMs = defaultSilenceMs,
  outboxHandlers = new Map(),
  now = Date.now,
}: Options) {
  const bootId = NodeCrypto.randomUUID();
  const clock = createAwakeClock(now);
  const outbox = createOutboxWorker(store.effects, outboxHandlers);
  const turns = new Map<
    string,
    {
      controller: AbortController;
      ended: Promise<void>;
      pauseClock: () => void;
      resumeClock: () => void;
      watchdog: ReturnType<typeof createWatchdog>;
      parked?: boolean;
    }
  >();
  let closing = false;

  store.recover(bootId, (run, at) =>
    recoveryVerdict({
      unsettledEffects: store.effects.settleRunEffects(run.id, "uncertain").length,
      continuedAt: store.recentRecoveries(run.botId, continueCap),
      now: at,
    }),
  );

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
    const { attended, launch } = run;
    const plan = launch.mode === "plan";
    const token = approvals.openRun(run.id, launch.botId, { attended, plan });
    const gate = approvals.authenticate(token);
    const tools: string[] = [];
    const seenTools = new Set<string>();
    const deltas = batchDeltas((text) => onDelta(run.id, text));
    const watchdog = createWatchdog(clock, silenceMs);
    const effects = new Map<string, string>();
    // Awake time only: a timer that fires on wake re-arms for whatever the sleep didn't use.
    let usedMs = 0;
    let since: number | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const used = () => usedMs + (since === undefined ? 0 : clock.awakeNow() - since);
    const arm = () => {
      clearTimeout(timeout);
      const leftMs = turnTimeoutMs - used();
      if (leftMs <= 0) {
        controller.abort("timeout");
      } else {
        timeout = setTimeout(arm, leftMs);
      }
    };
    const resumeClock = () => {
      if (since === undefined) {
        since = clock.awakeNow();
        arm();
      }
    };
    const pauseClock = () => {
      if (since !== undefined) {
        clearTimeout(timeout);
        usedMs = used();
        since = undefined;
      }
    };
    resumeClock();
    const recordEffect = (tool: ToolStart) => {
      try {
        const { id } = store.effects.recordEffect({
          runId: run.id,
          tool: tool.name,
          target: tool.id,
          idempotencyKey: `${run.id}:${tool.id}`,
        });
        effects.set(tool.id, id);
      } catch (error) {
        console.error(`beebotd: effect of run ${run.id} was not recorded`, error);
      }
    };
    const settleEffect = (toolId: string, failed: boolean) => {
      const id = effects.get(toolId);
      try {
        if (id) {
          store.effects.settleEffect(id, failed ? "failed" : "done");
        }
      } catch (error) {
        console.error(`beebotd: effect of run ${run.id} was not settled`, error);
      }
    };
    const attempt = (prompt: string, sessionId: string, resume: boolean) =>
      runTurn({
        prompt,
        sessionId,
        resume,
        launch: run.launch,
        signal: controller.signal,
        onDelta: (text) => {
          watchdog.touch();
          deltas.add(text);
        },
        onToolStart: (tool) => {
          deltas.flush();
          watchdog.toolStart(tool.id);
          if (!seenTools.has(tool.id)) {
            seenTools.add(tool.id);
            tools.push(tool.name);
            recordEffect(tool);
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
          watchdog.toolEnd(id);
          settleEffect(id, failed);
          onToolEnd(run.id, id, failed);
        },
        onThinking: (state) => {
          deltas.flush();
          watchdog.touch();
          onThinking(run.id, state);
        },
        onRateLimit: (updates) => {
          try {
            onRateLimit?.(run.launch.engineAccountId, updates);
          } catch (error) {
            // Usage is a side view: it must never cost the turn.
            console.error(`beebotd: usage of run ${run.id} was not recorded`, error);
          }
        },
        permissions: { url: permissionsUrl(), token },
        onDelivered: () => {
          try {
            store.markDelivered(run.id);
          } catch (error) {
            console.error(`beebotd: delivery of run ${run.id} was not recorded`, error);
          }
        },
        onSessionId: (sessionId) => store.setSessionId(run.id, sessionId),
        approve: (tool, input) =>
          gate
            ? approvals.approve(gate, { tool_name: tool, input }, controller.signal)
            : Promise.resolve({ behavior: "deny", message: "Refused: this run has ended." }),
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
        const parked = turns.get(run.id)?.parked ?? false;
        turns.delete(run.id);
        approvals.closeRun(run.id);
        // Left Running on purpose: the next boot marks it Interrupted.
        if (!closing) {
          try {
            const finished = finishedRun(outcome, controller.signal.reason, tools, parked);
            store.effects.settleRunEffects(
              run.id,
              outcome.kind === "completed" ? "done" : "uncertain",
            );
            store.finishRun(run.id, bootId, finished);
          } catch (error) {
            // A run left Running would hold its bot and account until the next boot.
            console.error(`beebotd: run ${run.id} did not finish cleanly`, error);
            store.finishRun(run.id, bootId, { status: "Failed", reason: "engine_failed" });
          }
          store.ingestRun(run.id);
          pump();
          onTurnEnded?.(run.launch.engineAccountId);
        }
      })
      .catch((error: unknown) => console.error(error));
    turns.set(run.id, { controller, ended, pauseClock, resumeClock, watchdog });
  }

  function startRun(runId: string, botId: string, accountId: string, now: string) {
    if (store.botStatus(botId) === "paused") {
      store.refuseQueuedRun(runId, "bot_paused");
      return;
    }
    if (accountHeld?.(accountId)) {
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
      store.fireDueRoutines(now);
      for (const wake of store.dueWakes(now)) {
        try {
          settleWake(wake, now);
        } catch (error) {
          console.error(`beebotd: wake ${wake.id} failed`, error);
        }
      }
      for (const run of store.queuedRuns()) {
        try {
          startRun(run.id, run.botId, run.engineAccountId, now);
        } catch (error) {
          console.error(`beebotd: run ${run.id} failed`, error);
        }
      }
      outbox.drain(now);
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

  // A turn waiting on the owner isn't silent either.
  function watch() {
    for (const [runId, { watchdog, controller }] of turns) {
      if (approvals.isHolding(runId)) {
        watchdog.touch();
      } else if (watchdog.stalled()) {
        controller.abort("timeout");
      }
    }
  }

  const ticker = setInterval(() => {
    clock.observe();
    watch();
    pump();
  }, tickMs);
  ticker.unref();

  return {
    pump,
    stopBot,
    syncClocks,
    // Every chain ends here: parked runs and open tasks too, so nothing wakes back up after.
    stopAll: () => {
      for (const botId of store.botIds()) {
        stopBot(botId);
      }
      for (const task of store.tasks.openTasks()) {
        store.tasks.finishTask(task.id, "cancelled");
      }
    },
    suspend: () => clock.suspend(),
    resume: () => {
      clock.resume();
      pump();
    },
    // For a tool that needs the owner: the turn is left to end on its own, then the run parks as
    // WaitingUser with the turn's reply, releasing its bot and account. The tool posts the question.
    parkWaitingUser: (runId: string) => {
      const turn = turns.get(runId);
      if (!turn || turn.controller.signal.aborted) {
        return false;
      }
      turn.parked = true;
      return true;
    },
    resumeFromUser: (runId: string, answer: string) => {
      const result = store.resumeFromUser(runId, answer);
      pump();
      return result;
    },
    close: async () => {
      closing = true;
      clearInterval(ticker);
      const ending = [...turns.values()];
      for (const { controller } of ending) {
        controller.abort("shutdown");
      }
      await Promise.all([...ending.map(({ ended }) => ended), outbox.idle()]);
    },
  };
}
