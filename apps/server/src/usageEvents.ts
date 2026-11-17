import {
  type Approval,
  type Bot,
  type Command,
  type Connector,
  type Continuation,
  EngineAccountId,
  type EngineLane,
  type EngineStatus,
  ErrorName,
  type EventBody,
  type HandoffReason,
  type Room,
  type Routine,
  type Run,
  type UsageEventName,
  type UsageProperties,
  type WakeSource,
} from "@beebot/contracts";
import { z } from "zod";

import { track } from "./analytics.ts";

export type Usage = {
  [E in UsageEventName]: { event: E; properties: UsageProperties<E> };
}[UsageEventName];

export function trackUsage(usage: Usage | undefined) {
  if (usage) {
    track(usage.event, usage.properties);
  }
}

const usage = <E extends UsageEventName>(event: E, properties: UsageProperties<E>) => ({
  event,
  properties,
});

const engineOf = (bot: Bot) => EngineAccountId.safeParse(bot.engineAccountId).data;
const elapsed = (from: string, to: string | null) =>
  to === null ? 0 : Math.max(0, Date.parse(to) - Date.parse(from));
const finished = new Set<Run["status"]>([
  "Refused",
  "Completed",
  "Failed",
  "Cancelled",
  "Interrupted",
]);

export type UsageLookup = {
  bot: (botId: string) => Bot | undefined;
  wake: (runId: string) => { source: WakeSource; attended: boolean } | undefined;
  lane: (engine: string) => EngineLane;
  // Approvals and continuations the owner answered with "always".
  always: ReadonlySet<string>;
};

export function runUsage(run: Run, lookup: UsageLookup) {
  const bot = lookup.bot(run.botId);
  const engine = bot && engineOf(bot);
  if (!bot || !engine) {
    return undefined;
  }
  const { boundary } = bot;
  if (run.status === "Running") {
    const wake = lookup.wake(run.id);
    return (
      wake &&
      usage("run_started", {
        engine,
        boundary,
        source: wake.source,
        attended: wake.attended,
        queued_ms: elapsed(run.createdAt, run.startedAt),
      })
    );
  }
  if (run.status === "WaitingQuota") {
    return usage("quota_limited", { engine, lane: lookup.lane(engine) });
  }
  if (!finished.has(run.status)) {
    return undefined;
  }
  return usage("run_finished", {
    engine,
    boundary,
    status: run.status,
    reason: run.reason,
    duration_ms: elapsed(run.startedAt ?? run.createdAt, run.endedAt),
  });
}

// Only the owner's answers and timeouts: a stop or a restart decides nothing.
function decided(
  kind: "tool" | "action" | "hand_off",
  allowed: boolean,
  {
    reason,
    createdAt,
    decidedAt,
  }: { reason: string | null; createdAt: string; decidedAt: string | null },
  always: boolean,
) {
  const answer = !allowed ? "deny" : always ? "always" : "allow";
  const decision = reason === "timeout" ? "expired" : reason === "owner" ? answer : undefined;
  return (
    decision &&
    usage("approval_decided", { kind, decision, wait_ms: elapsed(createdAt, decidedAt) })
  );
}

export function approvalUsage(approval: Approval, lookup: Pick<UsageLookup, "always">) {
  if (approval.status === "pending") {
    return usage("approval_requested", { kind: "tool" });
  }
  return decided("tool", approval.status === "allowed", approval, lookup.always.has(approval.id));
}

export function continuationUsage(continuation: Continuation, lookup: Pick<UsageLookup, "always">) {
  const kind = continuation.kind === "approval" ? "action" : "hand_off";
  const { status, id } = continuation;
  if (status === "waiting") {
    return usage("approval_requested", { kind });
  }
  // A hand_off the owner did goes straight to succeeded; an action's later steps decide nothing.
  const answered =
    status === "approved" ||
    status === "denied" ||
    status === "expired" ||
    (status === "succeeded" && kind === "hand_off");
  return answered
    ? decided(
        kind,
        status !== "denied",
        // An expiry sets only `finishedAt`.
        { ...continuation, decidedAt: continuation.decidedAt ?? continuation.finishedAt },
        lookup.always.has(id),
      )
    : undefined;
}

export function usageOf(event: EventBody, lookup: UsageLookup) {
  switch (event.type) {
    case "run.changed":
      return runUsage(event.run, lookup);
    case "approval.changed":
      return approvalUsage(event.approval, lookup);
    case "continuation.changed":
      return continuationUsage(event.continuation, lookup);
    case "firing.changed": {
      const { status, reason, missedBefore, retryAt } = event.firing;
      // A retry being scheduled re-sends a ran firing: it fired once.
      return status === "ready" || retryAt !== null
        ? undefined
        : usage("routine_fired", { status, reason, missed_before: missedBefore });
    }
    default:
      return undefined;
  }
}

export function botCreated(bot: Bot, first: boolean) {
  const engine = engineOf(bot);
  const { boundary, control, access, projectPath } = bot;
  return (
    engine &&
    usage("bot_created", {
      engine,
      boundary,
      control,
      access,
      has_project_folder: projectPath !== null,
      first,
    })
  );
}

export function botEngineChanged(before: Bot, after: Bot) {
  const engine = engineOf(after);
  const { effort, mode, access } = after;
  return (
    engine &&
    usage("bot_engine_changed", {
      engine,
      model_changed: after.model !== before.model,
      effort,
      mode,
      access,
    })
  );
}

export const worksOnChanged = ({ boundary, control }: Bot) =>
  usage("bot_works_on_changed", { boundary, control });

export const connectorAdded = (connector: Connector, source: "url" | "import") =>
  usage("connector_added", {
    transport: connector.transport,
    auth: connector.auth,
    source,
    bot_only: connector.ownerBotId !== null,
  });

export const routineCreated = (routine: Routine) =>
  usage("routine_created", {
    enabled: routine.enabled,
    has_skip_window: routine.skipIfLaterMins !== null,
  });

export const messageSent = (
  command: Extract<Command, { type: "send-message" }>,
  room: Room["kind"],
) =>
  usage("message_sent", {
    room,
    chars: command.body.length,
    attachments: command.attachmentIds?.length ?? 0,
    mentions: command.mentions?.length ?? 0,
    is_reply: command.replyToId !== undefined,
  });

export const engineChecked = (engine: z.infer<typeof EngineAccountId>, status: EngineStatus) =>
  usage("engine_checked", {
    engine,
    cli_found: status.cliFound,
    auth: status.auth,
    pause_reason: status.pauseReason,
  });

export const handoffRequested = (reason: HandoffReason, note: string | null) =>
  usage("browser_handoff_requested", {
    reason:
      reason === "captcha"
        ? "challenge"
        : reason === "hand_off" && note === "human_only"
          ? "human_only"
          : "other",
  });

// The web app's own reports aren't failures worth counting.
const uncounted = new Set<Command["type"]>(["track", "report-error"]);

export function commandFailed(command: Command["type"], status: number, body: unknown) {
  if (status < 400 || uncounted.has(command)) {
    return undefined;
  }
  const code = z.object({ code: ErrorName }).safeParse(body).data?.code ?? "storage_failed";
  return usage("command_failed", { command, status, code });
}
