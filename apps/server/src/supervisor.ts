import * as NodeCrypto from "node:crypto";

import type { ChatMessage } from "@beebot/contracts";

import { admit } from "./admission.ts";
import type { Approvals } from "./approvals.ts";
import { BoxLimitReached } from "./boxRuntime.ts";
import { recoverTakeovers } from "./browser.ts";
import { outcomeText } from "./continuations.ts";
import type { RunTurn, Steer, ThinkingState, ToolStart, TurnOutcome } from "./engine.ts";
import { backoffUntil } from "./limits.ts";
import { createOutboxWorker, type Deliver } from "./outbox.ts";
import { continueCap, recoveryVerdict } from "./recovery.ts";
import type { ClaimedRun, EventStore, FinishedRun, Wake } from "./store.ts";
import type { InboxFile } from "./attachments.ts";
import type { WindowUpdate } from "./usage.ts";
import { createWaitEvaluator, type WaitProbes } from "./waits.ts";
import { type AwakeClock, createAwakeClock, createWatchdog } from "./watchdog.ts";

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
  clock?: AwakeClock | undefined;
  // Whether a box runtime can run boxes now. Only a box bot may run unattended.
  boxesReady?: (() => boolean) | undefined;
  // Server mode: a bot outside a box never runs, attended or not.
  boxOnly?: boolean | undefined;
  // Whatever else a stopped bot leaves waiting, such as a takeover.
  onStopBot?: ((botId: string) => void) | undefined;
  // Puts the files a turn's input names into the bot's inbox, before the turn starts.
  copyInbox?: ((botId: string, files: InboxFile[]) => Promise<void>) | undefined;
  // Server mode: brings the bot's box up before its turn, throwing BoxLimitReached when every slot
  // is taken.
  prepareBox?: ((botId: string) => Promise<void>) | undefined;
  // Server mode: refuses API-key runs once this calendar month's spend reaches it.
  monthlyBudgetUsd?: number | null | undefined;
  waitProbes?: WaitProbes | undefined;
};

// A limit or auth failure is a fact about the account, so it holds even if the turn was aborted.
// A finished reply holds too: a stop or timeout landing after `result` has nothing left to stop.
function finishedRun(
  outcome: TurnOutcome,
  abortReason: unknown,
  tools: ChatMessage["tools"],
  parked: boolean,
  attachmentIds: string[],
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
  if (outcome.kind === "waiting") {
    return { status: "WaitingUser", reason: null, reply: outcome.text, tools, attachmentIds };
  }
  if (outcome.kind === "completed") {
    return {
      status: parked ? "WaitingUser" : "Completed",
      reason: null,
      reply: outcome.text,
      tools,
      attachmentIds,
    };
  }
  if (outcome.kind === "folder_missing") {
    return { status: "Failed", reason: "folder_missing" };
  }
  if (outcome.kind === "box_limit") {
    return { status: "Failed", reason: "box_limit" };
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
  clock = createAwakeClock(),
  boxesReady = () => false,
  boxOnly = false,
  onStopBot = () => {},
  copyInbox = async () => {},
  prepareBox,
  monthlyBudgetUsd = null,
  waitProbes = { url: async () => null, file: async () => null },
}: Options) {
  const bootId = NodeCrypto.randomUUID();
  const outbox = createOutboxWorker(store.effects, outboxHandlers);
  const waits = createWaitEvaluator(store, waitProbes, () => queueMicrotask(pump));
  const turns = new Map<
    string,
    {
      controller: AbortController;
      ended: Promise<void>;
      pauseClock: () => void;
      resumeClock: () => void;
      watchdog: ReturnType<typeof createWatchdog>;
      parked?: boolean;
      steer: () => void;
      // Files the turn shared, for its reply.
      shared: string[];
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
  store.continuations.recoverContinuations();
  recoverTakeovers(store);

  // An outcome is the owner's answer to the bot's waiting reply, so the next turn resumes the
  // saved session with it. The fixed message ID makes a repeat after a crash a no-op.
  function deliverOutcomes() {
    for (const row of store.continuations.unresumedContinuations()) {
      try {
        const target = store.continuations.deliveryTarget(row.id);
        const sent =
          target &&
          store.sendMessage({
            id: `continuation:${row.id}`,
            roomId: target.roomId,
            body: outcomeText(row),
            attended: row.reason === "owner" || target.attended,
            ...(target.replyToId && { replyToId: target.replyToId }),
          });
        if (sent !== "sent" && sent !== "duplicate") {
          console.error(`beebotd: outcome of ${row.id} was not delivered: ${sent}`);
        }
        store.continuations.markResumed(row.id);
      } catch (error) {
        console.error(`beebotd: outcome of ${row.id} failed`, error);
      }
    }
  }

  function settleWake(wake: Wake, now: string) {
    const {
      hasActiveRun,
      hasInput,
      boundary,
      bothClaudeCredentials,
      source,
      noProgressRuns,
      lastEndedAt,
      ...admission
    } = store.wakeContext(wake, now);
    if (hasActiveRun) {
      return;
    }
    // Everything this wake was for was already answered by a run that started after it.
    if (!hasInput) {
      store.closeWake(wake.id);
      return;
    }
    const until = backoffUntil({ noProgressRuns, source, lastEndedAt, now });
    if (until) {
      store.deferWake(wake.id, until);
      return;
    }
    if (boxOnly && boundary !== "box") {
      store.refuseWake(wake, "box_unavailable");
      return;
    }
    if (boxOnly && bothClaudeCredentials) {
      store.refuseWake(wake, "credential_conflict");
      return;
    }
    const box = boundary !== "box" ? "none" : boxesReady() ? "ready" : "unavailable";
    const decision = admit({ ...admission, box, attended: wake.attended, monthlyBudgetUsd, now });
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
    const tools = new Map<string, ChatMessage["tools"][number]>();
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
    const settleEffect = (toolId: string, failed: boolean, cutOff: boolean) => {
      const id = effects.get(toolId);
      try {
        if (id) {
          store.effects.settleEffect(id, cutOff ? "uncertain" : failed ? "failed" : "done");
        }
      } catch (error) {
        console.error(`beebotd: effect of run ${run.id} was not settled`, error);
      }
    };
    // One batch in flight at a time. Whatever lands meanwhile goes in the next one. An engine may
    // stop the attempt to take a steer, so it waits for a moment with no tool in flight: a cut-off
    // tool could be redone on the resume. A parked or ending turn takes none: its reply is final.
    let steer: Steer | undefined;
    let steering = false;
    const steerTurn = () => {
      const live = !controller.signal.aborted && !turns.get(run.id)?.parked;
      const send = steering || !live || watchdog.busy() ? undefined : steer;
      const input = send && store.steerInput(run.id);
      if (!send || !input) {
        return;
      }
      steering = true;
      send(input.text)
        .then((taken) => {
          if (taken) {
            store.markSteered(run.id, input.highSeq);
          }
        })
        .catch((error: unknown) => console.error(`beebotd: steer of run ${run.id} failed`, error))
        .finally(() => {
          steering = false;
        });
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
          const known = tools.get(tool.id);
          tools.set(tool.id, {
            name: tool.name,
            detail: tool.detail,
            failed: known?.failed ?? false,
          });
          if (!known) {
            recordEffect(tool);
            // Bee and connector tools taint through the broker, by their own labels.
            if (!tool.name.startsWith("mcp__bee__") && !tool.name.startsWith("mcp__connectors__")) {
              try {
                store.markTainted(run.id);
              } catch (error) {
                console.error(`beebotd: taint of run ${run.id} was not recorded`, error);
              }
            }
          }
          onToolStart(run.id, tool);
        },
        onToolEnd: (id, failed, cutOff = false) => {
          deltas.flush();
          watchdog.toolEnd(id);
          settleEffect(id, failed, cutOff);
          const known = tools.get(id);
          if (known) {
            known.failed = failed;
          }
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
        onCost: (usd) => {
          try {
            store.recordSpend(run.id, usd);
          } catch (error) {
            console.error(`beebotd: cost of run ${run.id} was not recorded`, error);
          }
        },
        onTokens: (tokens) => {
          try {
            store.recordTokens(run.id, tokens);
          } catch (error) {
            console.error(`beebotd: tokens of run ${run.id} were not recorded`, error);
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
        onSteerable: (send) => {
          steer = send;
        },
        approve: (tool, input) =>
          gate
            ? approvals.approve(gate, { tool_name: tool, input }, controller.signal)
            : Promise.resolve({ behavior: "deny", message: "Refused: this run has ended." }),
      });
    const turn = (async (): Promise<TurnOutcome> => {
      try {
        await prepareBox?.(launch.botId);
      } catch (error) {
        // Any other failure is left to the engine's own start, as without a box limit.
        if (error instanceof BoxLimitReached) {
          return { kind: "box_limit" };
        }
      }
      if (run.inbox.length > 0) {
        // The turn still runs: a missing file is something the bot can report.
        await copyInbox(launch.botId, run.inbox).catch((error: unknown) => {
          console.error(`beebotd: inbox of run ${run.id} not copied: ${(error as Error)?.message}`);
        });
      }
      const outcome = await attempt(run.prompt, run.sessionId, run.resume);
      if (outcome.kind !== "session_lost" || controller.signal.aborted) {
        return outcome;
      }
      const { prompt, sessionId } = store.restartSession(run.id, run.launch.memory !== "");
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
        const { parked = false, shared = [] } = turns.get(run.id) ?? {};
        turns.delete(run.id);
        approvals.closeRun(run.id);
        // Left Running on purpose: the next boot marks it Interrupted.
        if (!closing) {
          try {
            const finished = finishedRun(
              outcome,
              controller.signal.reason,
              [...tools.values()],
              parked,
              shared,
            );
            store.effects.settleRunEffects(
              run.id,
              outcome.kind === "completed" || outcome.kind === "waiting" ? "done" : "uncertain",
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
    turns.set(run.id, {
      controller,
      ended,
      pauseClock,
      resumeClock,
      watchdog,
      steer: steerTurn,
      shared: [],
    });
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
      store.fireDueRoutines(
        now,
        (botId) => boxesReady() && store.getBot(botId)?.boundary === "box",
      );
      waits.tick(now);
      store.continuations.expireContinuations();
      deliverOutcomes();
      for (const wake of store.dueWakes(now)) {
        try {
          settleWake(wake, now);
        } catch (error) {
          console.error(`beebotd: wake ${wake.id} failed`, error);
        }
      }
      for (const [runId, { steer }] of turns) {
        try {
          steer();
        } catch (error) {
          console.error(`beebotd: steer of run ${runId} failed`, error);
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
    store.continuations.stopContinuations(botId);
    onStopBot(botId);
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
    // Every chain ends here: parked runs and active tasks too, so nothing wakes back up after. Tasks
    // go first, or a run's end would open the next queued one.
    stopAll: () => {
      for (const task of store.tasks.activeTasks()) {
        store.tasks.finishTask(task.id, "cancelled");
      }
      store.waits.cancelWaits(null);
      for (const botId of store.botIds()) {
        stopBot(botId);
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
    shareFile: (runId: string, attachmentId: string) => {
      const turn = turns.get(runId);
      if (!turn || turn.controller.signal.aborted) {
        return false;
      }
      turn.shared.push(attachmentId);
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
      await Promise.all([...ending.map(({ ended }) => ended), outbox.idle(), waits.idle()]);
    },
  };
}
