import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { mentionKey, Routine } from "@beebot/contracts";
import { hostAllowed } from "@beebot/egress/policy";
import { z } from "zod";

import { attachmentName, attachmentPath, receiveAttachment, refusedName } from "./attachments.ts";
import type { BoxAttach } from "./boxRuntime.ts";
import {
  checkDelegation,
  checkFollowUp,
  checkRoutineCreate,
  checkTreeBudget,
  checkWakeCreate,
  clampLimits,
  maxPendingWakeups,
  maxPendingWaits,
} from "./limits.ts";
import { oneLine } from "./memory.ts";
import { scheduleProblem } from "./routines.ts";
import type { EventStore } from "./store.ts";
import { inboundText } from "./tasks.ts";
import { routineCreated, trackUsage } from "./usageEvents.ts";
import { terminalTask, type WaitCondition } from "./waits.ts";

const text = { type: "string" };
const activityRows = 10;
const followUpKinds = ["ask", "answer", "rework", "cancel"] as const;
const activityChars = 8000;
const activityLineChars = 500;
const maxWakeMinutes = 30 * 24 * 60;
const maxWaitMinutes = 24 * 60;
const waitKinds = ["task_done", "bot_idle", "url_status", "url_changes", "file_exists"] as const;
const schema = (properties: Record<string, object>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
});

export const botTools = [
  {
    name: "send_message",
    description: "Posts a message in a room you are in. Leave room_id out for this room.",
    inputSchema: schema({ text, room_id: text }, ["text"]),
  },
  {
    name: "notify",
    description: "Tells the owner something in your DM. Nobody's turn starts.",
    inputSchema: schema({ text }),
  },
  {
    name: "delegate",
    description:
      "Gives a task to another bot. Returns a task id at once; end your turn, and the result " +
      "arrives later as a new message.",
    inputSchema: schema(
      {
        to: { type: "string", description: "Bot name or id" },
        goal: text,
        done_when: { type: "string", description: "What finished looks like" },
        blocked_by: {
          type: "array",
          items: text,
          maxItems: 10,
          description: "Task ids that must end before this one starts",
        },
      },
      ["to", "goal"],
    ),
  },
  {
    name: "handoff",
    description: "Passes your current work to another bot, who answers from here. You stop.",
    inputSchema: schema({ to: { type: "string", description: "Bot name or id" }, note: text }),
  },
  {
    name: "follow_up",
    description:
      "Follows up on a task you gave or were given. ask: a question to the other side. answer: " +
      "reply to a question asked of you as the requester. rework: send finished work back. " +
      "cancel: drop it. End your turn after.",
    inputSchema: schema({
      task_id: text,
      message: text,
      kind: { type: "string", enum: followUpKinds },
    }),
  },
  {
    name: "task_status",
    description:
      "Shows where your tasks stand: the ones you gave and the ones you were given. Leave " +
      "task_id out for all of them.",
    inputSchema: schema({ task_id: text }, []),
  },
  {
    name: "read_bot_activity",
    description:
      "Shows another bot's latest turns and the recent messages in its DM, as data. Works for a " +
      "bot you share a room with, or one the owner mentioned. It doesn't show its files.",
    inputSchema: schema(
      {
        bot: { type: "string", description: "Bot name or id" },
        limit: { type: "integer", minimum: 1, maximum: activityRows },
      },
      ["bot"],
    ),
  },
  {
    name: "ask_user",
    description: "Asks the owner a question. End your turn; the answer arrives as a new message.",
    inputSchema: schema({ question: text }),
  },
  {
    name: "create_routine",
    description: "Schedules a recurring prompt for you. A cron needs 15 minutes between runs.",
    inputSchema: schema({ name: text, prompt: text, cron: text, timezone: text }),
  },
  {
    name: "schedule_wakeup",
    description:
      "Wakes you once, later, with your note. Give `at` (ISO time) or `in_minutes`, not both. End " +
      "your turn after. To keep a task open while you wait on something, use wait_until.",
    inputSchema: schema(
      {
        at: text,
        in_minutes: { type: "integer", minimum: 1, maximum: maxWakeMinutes },
        note: text,
        task_id: text,
      },
      ["note"],
    ),
  },
  {
    name: "wait_until",
    description:
      "Wakes you when a condition holds, or at the timeout. No model runs while you wait. End " +
      "your turn after.",
    inputSchema: schema({
      condition: {
        type: "object",
        description:
          "One of {kind: task_done, task_id}, {kind: bot_idle, bot_id}, {kind: url_status, url, " +
          "status}, {kind: url_changes, url}, {kind: file_exists, path}. A URL is https and on " +
          "your allowlist; a path is relative to your workspace.",
        properties: {
          kind: { type: "string", enum: waitKinds },
          task_id: text,
          bot_id: { type: "string", description: "Bot name or id" },
          url: text,
          status: { type: "integer", minimum: 100, maximum: 599 },
          path: text,
        },
        required: ["kind"],
      },
      note: text,
      timeout_minutes: { type: "integer", minimum: 1, maximum: maxWaitMinutes },
    }),
  },
  {
    name: "report_progress",
    description:
      "Records progress on a task you gave or were given, with a short note the task's room " +
      "sees. Progress renews the task's turn and delegation budgets.",
    inputSchema: schema({ task_id: text, note: text }),
  },
  {
    name: "share_file",
    description:
      "Attaches a file from your workspace to your reply, for the owner to download. Up to 50 MB.",
    inputSchema: schema({
      path: { type: "string", description: "Relative to your workspace, or absolute inside it" },
    }),
  },
];

export const botToolNames = new Set(botTools.map(({ name }) => name));

// The supervisor parks the run on this. The answer comes back as the owner's next message.
export type UserQuestion = { runId: string; botId: string; messageId: string; question: string };

const Body = z.string().trim().min(1).max(32_000);
const Send = z.object({ text: Body, room_id: z.string().optional() });
const Notify = z.object({ text: Body });
const Delegate = z.object({
  to: z.string().trim().min(1),
  goal: Body,
  done_when: z.string().trim().min(1).max(2000).optional(),
  blocked_by: z
    .array(z.string())
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length)
    .optional(),
});
const Handoff = z.object({ to: z.string().trim().min(1), note: Body });
const Ask = z.object({ question: Body });
const FollowUp = z.object({
  task_id: z.string().trim().min(1),
  message: Body,
  kind: z.enum(followUpKinds),
});
const TaskStatus = z.object({ task_id: z.string().trim().min(1).optional() });
const ReadActivity = z.object({
  bot: z.string().trim().min(1),
  limit: z.number().int().min(1).max(activityRows).default(5),
});
const ShareFile = z.object({ path: z.string().trim().min(1).max(4096) });
const CreateRoutine = z.object({
  name: Routine.shape.name,
  prompt: Routine.shape.prompt,
  cron: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(100),
});

const ScheduleWakeup = z
  .object({
    at: z.iso.datetime({ offset: true }).optional(),
    in_minutes: z.number().int().min(1).max(maxWakeMinutes).optional(),
    note: z.string().trim().min(1).max(2000),
    task_id: z.string().trim().min(1).optional(),
  })
  .refine(({ at, in_minutes }) => (at === undefined) !== (in_minutes === undefined));

const ReportProgress = z.object({
  task_id: z.string().trim().min(1),
  note: z.string().trim().min(1).max(2000),
});

const WaitUrl = z.string().trim().min(1).max(2048);
const WaitUntil = z.object({
  condition: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("task_done"), task_id: z.string().trim().min(1) }),
    z.object({ kind: z.literal("bot_idle"), bot_id: z.string().trim().min(1) }),
    z.object({
      kind: z.literal("url_status"),
      url: WaitUrl,
      status: z.number().int().min(100).max(599),
    }),
    z.object({ kind: z.literal("url_changes"), url: WaitUrl }),
    z.object({ kind: z.literal("file_exists"), path: z.string().trim().min(1).max(4096) }),
  ]),
  note: z.string().trim().min(1).max(2000),
  timeout_minutes: z.number().int().min(1).max(maxWaitMinutes),
});

export const answer = (fields: Record<string, unknown>) => JSON.stringify(fields);
export const refused = (reason: string) =>
  answer({ status: "refused", reason, note: "This is an answer, not an error. Tell the user." });
const malformed = (tool: string) => refused(`invalid_arguments for ${tool}`);
const endTurn = "End your turn now. Don't wait or poll: the answer arrives as a new message.";

type Grant = NonNullable<ReturnType<EventStore["tasks"]["runGrant"]>>;

export const named =
  (to: string) =>
  ({ id, name }: { id: string; name: string }) =>
    id === to || name.toLowerCase() === to.toLowerCase() || mentionKey(name) === to.toLowerCase();

// The one rule for reaching another bot: it shares a room with the caller, the owner mentioned it
// in this chain, or the caller created it. Never the caller itself.
function reachableBot(grant: Grant, to: string) {
  return [...grant.roommates, ...grant.mentioned, ...grant.children].find(
    (bot) => bot.id !== grant.botId && named(to)(bot),
  );
}

// The condition as stored, or why it can't be waited on. A finished task is met already.
function waitCondition(
  store: EventStore,
  grant: Grant,
  condition: z.infer<typeof WaitUntil>["condition"],
): WaitCondition | { refused: string } | { alreadyMet: string } {
  const bot = store.getBot(grant.botId);
  if (!bot) {
    return { refused: "run_ended" };
  }
  switch (condition.kind) {
    case "task_done": {
      const task = store.tasks.getTask(condition.task_id);
      if (!task || (task.requesterBotId !== bot.id && task.ownerBotId !== bot.id)) {
        return { refused: "not_your_task" };
      }
      return terminalTask.has(task.status) ? { alreadyMet: task.status } : condition;
    }
    case "bot_idle": {
      const target = reachableBot(grant, condition.bot_id);
      return target ? { ...condition, bot_id: target.id } : { refused: "not_allowed" };
    }
    case "url_status":
    case "url_changes": {
      const url = URL.parse(condition.url);
      if (url?.protocol !== "https:") {
        return { refused: "url_not_https" };
      }
      // The egress proxy only opens port 443, and hostAllowed refuses IP literals and local names.
      if (url.port !== "" || !hostAllowed(bot.egressHosts, url.hostname, bot.egressAnySite)) {
        return { refused: "egress_not_allowed" };
      }
      return { ...condition, url: url.href };
    }
    case "file_exists": {
      if (bot.boundary !== "box") {
        return { refused: "box_only" };
      }
      const path = NodePath.posix.normalize(condition.path);
      if (NodePath.posix.isAbsolute(path) || path === ".." || path.startsWith("../")) {
        return { refused: "outside_workspace" };
      }
      return { ...condition, path };
    }
  }
}

// Ancestors first: a name can match both, and an ancestor never takes work from its chain. A
// delegate can't go to any bot already in the chain, which would let work come back around.
function destination(store: EventStore, grant: Grant, to: string, kind: "delegate" | "handoff") {
  if (grant.ancestors.some(named(to))) {
    return { refused: "ancestor" };
  }
  const target = reachableBot(grant, to);
  if (!target) {
    return { refused: "not_allowed" };
  }
  if (kind === "delegate" && grant.inChain.includes(target.id)) {
    return { refused: "already_in_chain" };
  }
  return store.botStatus(target.id) === "paused" ? { refused: "target_paused" } : target;
}

// Box bots only: `read` is the box's outbox, and `attach` puts the file on the turn's reply.
export type FileShare = {
  dataDir: string;
  workdir: string;
  read: ((botId: string, path: string) => Promise<BoxAttach>) | undefined;
  attach: (runId: string, attachmentId: string) => boolean;
};

export async function shareFile(
  store: EventStore,
  run: { id: string },
  args: unknown,
  { dataDir, workdir, read, attach }: FileShare,
) {
  const grant = store.tasks.runGrant(run.id);
  if (!grant) {
    return refused("run_ended");
  }
  const { data } = ShareFile.safeParse(args);
  if (!data) {
    return malformed("share_file");
  }
  const path = NodePath.posix.resolve(workdir, data.path);
  if (!path.startsWith(`${workdir}/`)) {
    return refused("outside_workspace");
  }
  const name = attachmentName(NodePath.posix.basename(path));
  if (refusedName(name)) {
    return refused("attachment_type");
  }
  if (!read) {
    return refused("box_only");
  }
  const id = NodeCrypto.randomUUID();
  const { stream, exited } = await read(grant.botId, path);
  stream.end();
  const [received, code] = await Promise.all([
    receiveAttachment(stream, dataDir, grant.roomId, id),
    exited,
  ]);
  if (received === "too_large") {
    return refused("too_large");
  }
  if (code !== 0) {
    await NodeFS.rm(attachmentPath(dataDir, grant.roomId, id), { force: true });
    return refused(code === 3 ? "outside_workspace" : "not_a_file");
  }
  const mime = "application/octet-stream";
  store.addAttachment({ id, roomId: grant.roomId, name, mime, ...received });
  return attach(run.id, id)
    ? answer({ status: "attached", name, size: received.size })
    : refused("run_ended");
}

export function callBotTool(
  store: EventStore,
  run: { id: string; botId: string },
  name: string,
  args: unknown,
  askUser?: (question: UserQuestion) => void,
) {
  const grant = store.tasks.runGrant(run.id);
  if (!grant) {
    return refused("run_ended");
  }
  const from = { botId: grant.botId, chainId: grant.chainId, hop: grant.hop, depth: grant.depth };
  const now = new Date().toISOString();
  const chain = {
    hop: grant.hop,
    depth: grant.depth,
    turns: grant.turns,
    startedAt: grant.startedAt,
  };
  const limits = clampLimits(store.readLimits());

  switch (name) {
    case "send_message": {
      const { data } = Send.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      const sent = store.sendBotMessage(run.id, data.room_id ?? grant.roomId, data.text);
      return "refused" in sent
        ? refused(sent.refused)
        : answer({ status: "sent", message_id: sent.messageId });
    }
    case "notify": {
      const { data } = Notify.safeParse(args);
      const room = store.tasks.dmRoom(grant.botId);
      if (!data) {
        return malformed(name);
      }
      const id = room && store.tasks.postFrom(from, room, "notify", data.text);
      return id ? answer({ status: "posted", message_id: id }) : refused("no_dm");
    }
    case "ask_user": {
      const { data } = Ask.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      const messageId = store.tasks.postFrom(from, grant.roomId, "question", data.question);
      if (!messageId) {
        return refused("not_in_room");
      }
      askUser?.({ runId: run.id, botId: grant.botId, messageId, question: data.question });
      return answer({ status: "waiting", question_id: messageId, note: endTurn });
    }
    // Read-only and capped. Another bot's words are untrusted, so reading them taints the caller.
    case "read_bot_activity": {
      const { data } = ReadActivity.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      const peer = reachableBot(grant, data.bot);
      const bot = peer && store.getBot(peer.id);
      if (!bot) {
        return refused("not_allowed");
      }
      const turns = store
        .turnSummaries(bot.id, data.limit)
        .map(
          ({ endedAt, status, asked, replied }) =>
            `- ${endedAt.slice(0, 16)}Z, ${status}. Asked: "${asked}". Replied: "${replied}".`,
        );
      const messages = store
        .recentMessages(bot.roomId, data.limit)
        .map(
          ({ author, body, name: sender, createdAt }) =>
            `- ${createdAt.slice(0, 16)}Z ${author === "human" ? "Owner" : (sender ?? "Bot")}: ${oneLine(body).slice(0, activityLineChars)}`,
        );
      const body = [
        "Latest turns:",
        ...(turns.length > 0 ? turns : ["- None yet."]),
        "Recent messages in its DM:",
        ...(messages.length > 0 ? messages : ["- None yet."]),
      ]
        .join("\n")
        .slice(0, activityChars);
      store.markUntrusted(run.id);
      const activity = inboundText({
        id: "activity",
        botName: bot.name,
        chainId: null,
        hop: 0,
        body,
      });
      return answer({ status: "ok", bot: bot.name, activity });
    }
    case "delegate": {
      const { data } = Delegate.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      const target = destination(store, grant, data.to, "delegate");
      if ("refused" in target) {
        return refused(target.refused);
      }
      const verdict = checkDelegation(limits, {
        chain,
        tasksInRun: grant.tasksInRun,
        now,
        tree: grant.tree,
      });
      if (verdict.verdict === "refuse") {
        return refused(verdict.reason);
      }
      const blockedBy = data.blocked_by ?? [];
      const unknown = blockedBy.some((id) => {
        const blocker = store.tasks.getTask(id);
        return blocker?.requesterBotId !== grant.botId && blocker?.ownerBotId !== grant.botId;
      });
      if (unknown) {
        return refused("unknown_blocker");
      }
      const digest = NodeCrypto.createHash("sha256").update(`${target.id}\n${data.goal}`);
      const task = store.tasks.createTask(
        {
          kind: "delegate",
          chainId: grant.chainId,
          hop: grant.hop + 1,
          depth: grant.depth + 1,
          parentRunId: run.id,
          requesterBotId: grant.botId,
          ownerBotId: target.id,
          roomId: grant.roomId,
          goal: data.goal,
          parentTaskId: grant.taskId,
          origin:
            grant.source === "routine" ? "routine" : grant.source === "wait" ? "wake" : "human",
          doneWhen: data.done_when ?? null,
          blockedBy,
          deliveryKey: `${run.id}:${digest.digest("hex")}`,
          attended: grant.attended,
        },
        limits.fanOut,
      );
      if ("refused" in task) {
        return refused(task.refused);
      }
      const queued = task.status === "queued";
      const note = queued
        ? `${target.name} is busy; the task starts when they are free. ${endTurn}`
        : endTurn;
      return answer({ status: "delegated", task_id: task.id, to: target.name, queued, note });
    }
    case "handoff": {
      const { data } = Handoff.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      const target = destination(store, grant, data.to, "handoff");
      if ("refused" in target) {
        return refused(target.refused);
      }
      // A handoff moves work sideways, so only the hop grows.
      const sideways = { ...chain, depth: chain.depth - 1 };
      const verdict = checkDelegation(limits, {
        chain: sideways,
        tasksInRun: 0,
        now,
        tree: grant.tree,
      });
      if (verdict.verdict === "refuse") {
        return refused(verdict.reason);
      }
      const move = { fromBotId: grant.botId, toBotId: target.id };
      const owned = grant.taskId ?? undefined;
      if (owned && !grant.owns(owned)) {
        return refused("not_owner");
      }
      if (!owned && !grant.inRoom(grant.roomId, target.id)) {
        return refused("not_in_room");
      }
      const task = owned
        ? store.tasks.handoff(owned, { ...move, hop: grant.hop + 1, note: data.note })
        : store.tasks.createTask(
            {
              kind: "handoff",
              chainId: grant.chainId,
              hop: grant.hop + 1,
              depth: grant.depth,
              parentRunId: run.id,
              requesterBotId: grant.botId,
              ownerBotId: target.id,
              roomId: grant.roomId,
              goal: data.note,
              deliveryKey: `${run.id}:handoff`,
              attended: grant.attended,
            },
            limits.fanOut,
          );
      if (!task) {
        return refused("not_owner");
      }
      if ("refused" in task) {
        return refused(task.refused);
      }
      const note = "You no longer own this work. End your turn now.";
      return answer({
        status: "handed_off",
        task_id: task.id,
        to: target.name,
        queued: task.status === "queued",
        note,
      });
    }
    case "follow_up": {
      const { data } = FollowUp.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      // An answer or cancel only settles what the tree already asked, so it passes a spent budget.
      if (data.kind === "ask" || data.kind === "rework") {
        const budget = checkTreeBudget(limits, grant.tree);
        if (budget.verdict === "refuse") {
          return refused(budget.reason);
        }
      }
      const verdict = checkFollowUp(limits, { chain, now });
      if (verdict.verdict === "refuse") {
        return refused(verdict.reason);
      }
      const task = store.tasks.followUp({
        taskId: data.task_id,
        botId: grant.botId,
        kind: data.kind,
        message: data.message,
        attended: grant.attended,
      });
      if ("refused" in task) {
        return refused(task.refused);
      }
      const note = data.kind === "cancel" ? undefined : endTurn;
      return answer({ status: "sent", task_id: task.id, task_status: task.status, note });
    }
    case "task_status": {
      const { data } = TaskStatus.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      const botName = (id: string) => store.getBot(id)?.name ?? null;
      const tasks = store.tasks.tasksOf(grant.botId, data.task_id).map((task) => ({
        task_id: task.id,
        kind: task.kind,
        status: task.status,
        goal: task.goal.slice(0, 300),
        from: botName(task.requesterBotId),
        to: botName(task.ownerBotId),
        updated_at: task.updatedAt,
      }));
      return answer({
        status: "ok",
        tasks,
        note: "Don't poll: results and questions arrive as new messages.",
      });
    }
    case "create_routine": {
      const { data } = CreateRoutine.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      const problem = scheduleProblem(data, now);
      if (problem) {
        return refused(problem);
      }
      const verdict = checkRoutineCreate({ source: grant.source });
      const approved = verdict.verdict === "allow";
      const routine = store.createRoutine({
        ...data,
        botId: grant.botId,
        enabled: approved,
        skipIfLaterMins: null,
        createdByRunId: run.id,
        approvedAt: approved ? now : null,
      });
      trackUsage(routineCreated(routine));
      return approved
        ? answer({ status: "created", routine_id: routine.id })
        : answer({
            status: "awaiting_approval",
            routine_id: routine.id,
            reason: verdict.verdict === "refuse" ? verdict.reason : null,
            note: "It stays off until the owner turns it on.",
          });
    }
    case "schedule_wakeup": {
      const { data } = ScheduleWakeup.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      if (data.task_id !== undefined && data.task_id !== grant.taskId) {
        return refused("not_your_task");
      }
      const fireMs = data.at
        ? Date.parse(data.at)
        : Date.parse(now) + (data.in_minutes ?? 0) * 60_000;
      const delayMs = fireMs - Date.parse(now);
      if (delayMs < 60_000 || delayMs > maxWakeMinutes * 60_000) {
        return refused("out_of_range");
      }
      const budget = checkTreeBudget(limits, grant.tree);
      if (budget.verdict === "refuse") {
        return refused(budget.reason);
      }
      const verdict = checkWakeCreate(grant);
      if (verdict.verdict === "refuse") {
        return refused(verdict.reason);
      }
      const routine = store.scheduleWakeup(
        {
          botId: grant.botId,
          name: `Wakeup: ${oneLine(data.note).slice(0, 70)}`,
          prompt: data.note,
          fireAt: new Date(fireMs).toISOString(),
          createdByRunId: run.id,
        },
        maxPendingWakeups,
      );
      if ("refused" in routine) {
        return refused(routine.refused);
      }
      return answer({
        status: "scheduled",
        routine_id: routine.id,
        fire_at: routine.fireAt,
        note: endTurn,
      });
    }
    case "wait_until": {
      const { data } = WaitUntil.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      const condition = waitCondition(store, grant, data.condition);
      if ("refused" in condition) {
        return refused(condition.refused);
      }
      if ("alreadyMet" in condition) {
        return answer({ status: "already_met", task_status: condition.alreadyMet });
      }
      const budget = checkTreeBudget(limits, grant.tree);
      if (budget.verdict === "refuse") {
        return refused(budget.reason);
      }
      const verdict = checkWakeCreate(grant);
      if (verdict.verdict === "refuse") {
        return refused(verdict.reason);
      }
      const wait = store.waits.createWait(
        {
          botId: grant.botId,
          taskId: grant.taskId,
          condition,
          note: data.note,
          timeoutMinutes: data.timeout_minutes,
          createdByRunId: run.id,
        },
        maxPendingWaits,
      );
      if ("refused" in wait) {
        return refused(wait.refused);
      }
      const hostOnly =
        store.getBot(grant.botId)?.boundary === "box"
          ? ""
          : " You don't run in a box, so this only reaches you when the owner is here.";
      return answer({
        status: "waiting",
        wait_id: wait.id,
        expires_at: wait.expiresAt,
        note: `End your turn now. You'll be woken when it holds or at the timeout.${hostOnly}`,
      });
    }
    case "report_progress": {
      const { data } = ReportProgress.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      const task = store.tasks.reportProgress(data.task_id, grant.botId, data.note);
      if (!task || task === "not_yours") {
        return refused("not_your_task");
      }
      store.rooms.resetHold(task.roomId);
      return answer({ status: "recorded", task_id: task.id });
    }
    default:
      return refused("unknown_tool");
  }
}
