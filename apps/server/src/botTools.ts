import * as NodeCrypto from "node:crypto";

import { Routine } from "@beebot/contracts";
import { z } from "zod";

import { checkDelegation, checkRoutineCreate, clampLimits } from "./limits.ts";
import { scheduleProblem } from "./routines.ts";
import type { EventStore } from "./store.ts";

const text = { type: "string" };
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
    name: "ask_user",
    description: "Asks the owner a question. End your turn; the answer arrives as a new message.",
    inputSchema: schema({ question: text }),
  },
  {
    name: "create_routine",
    description: "Schedules a recurring prompt for you. A cron needs 15 minutes between runs.",
    inputSchema: schema({ name: text, prompt: text, cron: text, timezone: text }),
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

// Ancestors first: a name can match both, and an ancestor never takes work from its chain.
function destination(store: EventStore, grant: Grant, to: string) {
  const matches = ({ id, name }: { id: string; name: string }) =>
    id === to || name.toLowerCase() === to.toLowerCase();
  if (grant.ancestors.some(matches)) {
    return { refused: "ancestor" };
  }
  const target = grant.roommates.find(matches);
  if (!target) {
    return { refused: "not_allowed" };
  }
  return store.botStatus(target.id) === "paused" ? { refused: "target_paused" } : target;
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
    case "delegate": {
      const { data } = Delegate.safeParse(args);
      if (!data) {
        return malformed(name);
      }
      const target = destination(store, grant, data.to);
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
      const target = destination(store, grant, data.to);
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
