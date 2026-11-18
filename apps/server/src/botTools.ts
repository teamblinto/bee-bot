import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import { mentionKey, Routine } from "@beebot/contracts";
import { z } from "zod";

import { attachmentName, attachmentPath, receiveAttachment, refusedName } from "./attachments.ts";
import type { BoxAttach } from "./boxRuntime.ts";
import { checkDelegation, checkRoutineCreate, clampLimits } from "./limits.ts";
import { oneLine } from "./memory.ts";
import { scheduleProblem } from "./routines.ts";
import type { EventStore } from "./store.ts";
import { inboundText } from "./tasks.ts";
import { routineCreated, trackUsage } from "./usageEvents.ts";

const text = { type: "string" };
const activityRows = 10;
const activityChars = 8000;
const activityLineChars = 500;
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
    inputSchema: schema({ to: { type: "string", description: "Bot name or id" }, goal: text }),
  },
  {
    name: "handoff",
    description: "Passes your current work to another bot, who answers from here. You stop.",
    inputSchema: schema({ to: { type: "string", description: "Bot name or id" }, note: text }),
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
const Delegate = z.object({ to: z.string().trim().min(1), goal: Body });
const Handoff = z.object({ to: z.string().trim().min(1), note: Body });
const Ask = z.object({ question: Body });
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

const answer = (fields: Record<string, unknown>) => JSON.stringify(fields);
const refused = (reason: string) =>
  answer({ status: "refused", reason, note: "This is an answer, not an error. Tell the user." });
const malformed = (tool: string) => refused(`invalid_arguments for ${tool}`);
const endTurn = "End your turn now. Don't wait or poll: the answer arrives as a new message.";

type Grant = NonNullable<ReturnType<EventStore["tasks"]["runGrant"]>>;

const named =
  (to: string) =>
  ({ id, name }: { id: string; name: string }) =>
    id === to || name.toLowerCase() === to.toLowerCase() || mentionKey(name) === to.toLowerCase();

// The one rule for reaching another bot: it shares a room with the caller, or the owner mentioned
// it in this chain. Never the caller itself.
function reachableBot(grant: Grant, to: string) {
  return [...grant.roommates, ...grant.mentioned].find(
    (bot) => bot.id !== grant.botId && named(to)(bot),
  );
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
  const limits = clampLimits({});

  switch (name) {
    case "send_message": {
      const { data } = Send.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      const id = store.tasks.postFrom(from, data.room_id ?? grant.roomId, "message", data.text);
      return id ? answer({ status: "sent", message_id: id }) : refused("not_in_room");
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
      const verdict = checkDelegation(limits, { chain, tasksInRun: grant.tasksInRun, now });
      if (verdict.verdict === "refuse") {
        return refused(verdict.reason);
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
          deliveryKey: `${run.id}:${digest.digest("hex")}`,
          attended: grant.attended,
        },
        limits.fanOut,
      );
      if ("refused" in task) {
        return refused(task.refused);
      }
      return answer({ status: "delegated", task_id: task.id, to: target.name, note: endTurn });
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
      const verdict = checkDelegation(limits, { chain: sideways, tasksInRun: 0, now });
      if (verdict.verdict === "refuse") {
        return refused(verdict.reason);
      }
      const move = { fromBotId: grant.botId, toBotId: target.id, attended: grant.attended };
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
      return answer({ status: "handed_off", task_id: task.id, to: target.name, note });
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
    default:
      return refused("unknown_tool");
  }
}
