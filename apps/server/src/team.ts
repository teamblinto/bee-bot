import * as NodeCrypto from "node:crypto";

import {
  type Bot,
  BotModel,
  type Command,
  EngineAccountId,
  type EngineModel,
  SkillName,
  type TeamRequest,
  TeamRequestKind,
} from "@beebot/contracts";
import { z } from "zod";

import { answer, named, refused } from "./botTools.ts";
import { checkDelegation, clampLimits } from "./limits.ts";
import { canonical } from "./policy.ts";
import type { EventStore } from "./store.ts";

const text = { type: "string" };
const botRef = { type: "string", description: "Bot name or id" };
const schema = (properties: Record<string, object>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const waits = " Waits for the owner unless they let leads act without asking.";

export const teamTools = [
  {
    name: "create_bot",
    description: `Creates a bot of your own, in a box on your engine.${waits}`,
    inputSchema: schema(
      {
        name: text,
        personality: text,
        model: text,
        skills: { type: "array", items: text },
        join_rooms: { type: "array", items: text, description: "Group room ids you are in" },
        first_task: { type: "string", description: "A task to delegate to it once it exists" },
      },
      ["name", "personality"],
    ),
  },
  {
    name: "update_bot",
    description: `Renames or reshapes a bot you created.${waits}`,
    inputSchema: schema(
      {
        bot_id: botRef,
        expected_version: { type: "integer", minimum: 1 },
        name: text,
        personality: text,
      },
      ["bot_id", "expected_version"],
    ),
  },
  {
    name: "archive_bot",
    description: `Archives a bot you created.${waits}`,
    inputSchema: schema({ bot_id: botRef }, ["bot_id"]),
  },
  {
    name: "create_room",
    description: `Makes a group room with you in it.${waits}`,
    inputSchema: schema(
      {
        name: text,
        members: { type: "array", items: botRef, minItems: 1, maxItems: 11 },
        default_bot: botRef,
      },
      ["name", "members"],
    ),
  },
  {
    name: "invite_to_room",
    description: `Adds a bot to a group room you are in.${waits}`,
    inputSchema: schema({ room_id: text, bot: botRef }, ["room_id", "bot"]),
  },
];

export const teamToolNames = new Set(teamTools.map(({ name }) => name));

export type CommandResult = { status: number; body: unknown };

const CreateBot = z.strictObject({
  name: z.string().trim().min(1).max(80),
  personality: z.string().trim().max(4000),
  model: BotModel.optional(),
  skills: z.array(SkillName).max(20).optional(),
  join_rooms: z.array(z.string()).max(10).optional(),
  first_task: z.string().trim().min(1).max(32_000).optional(),
});
type CreateBot = z.infer<typeof CreateBot>;
const ref = z.string().trim().min(1).max(200);
const UpdateBot = z
  .strictObject({
    bot_id: ref,
    expected_version: z.number().int().min(1),
    name: CreateBot.shape.name.optional(),
    personality: CreateBot.shape.personality.optional(),
  })
  .refine(({ name, personality }) => name !== undefined || personality !== undefined);
const ArchiveBot = z.strictObject({ bot_id: ref });
const CreateRoom = z.strictObject({
  name: z.string().trim().min(1).max(80),
  members: z.array(ref).min(1).max(11),
  default_bot: ref.optional(),
});
const InviteToRoom = z.strictObject({ room_id: ref, bot: ref });
const schemas = {
  create_bot: CreateBot,
  update_bot: UpdateBot,
  archive_bot: ArchiveBot,
  create_room: CreateRoom,
  invite_to_room: InviteToRoom,
} satisfies Record<TeamRequestKind, z.ZodType<Record<string, unknown>>>;

export const leadCaps = { createsPerTurn: 3, spawnedInWorkspace: 20, pendingPerLead: 10 };

const awaiting = "The owner decides in Needs you. End your turn; you'll hear back in your DM.";
const Code = z.object({ code: z.string() });
const Made = z.object({ id: z.string() });
type Outcome = { status: "applied" | "failed"; result: Record<string, unknown> };
const failed = (code: string): Outcome => ({ status: "failed", result: { code } });

function answerFor(request: TeamRequest) {
  const { id: request_id, status } = request;
  return status === "pending"
    ? answer({ status: "awaiting_approval", request_id, note: awaiting })
    : answer({ status, request_id, ...request.result });
}

function notice({ id, kind, status, result }: TeamRequest) {
  const what = `your ${kind} request (${id})`;
  if (status === "declined") {
    return `The owner declined ${what}. Nothing was changed.`;
  }
  const detail = JSON.stringify(result ?? {});
  return status === "applied"
    ? `The owner approved ${what}, and it is done: ${detail}`
    : `The owner approved ${what}, but it could not be applied: ${detail}`;
}

// A lead's team tools. Each call is a request the owner decides on NeedsYou, applied at once only
// when the owner lets leads act and the run is attended and has read nothing untrusted.
export function createTeam(deps: {
  store: EventStore;
  apply: {
    createBot: (input: {
      name: string;
      personality: string;
      model: string;
      engineAccountId: z.infer<typeof EngineAccountId>;
      parentBotId: string;
      spawnKey: string;
      forceBox: true;
    }) => CommandResult;
    updateBot: (input: {
      botId: string;
      name: string;
      personality: string;
      expectedVersion: number;
    }) => CommandResult;
    archiveBot: (botId: string) => CommandResult;
    createRoom: (input: {
      name: string;
      memberIds: string[];
      defaultBotId: string | null;
    }) => CommandResult;
    addRoomMember: (roomId: string, botId: string) => CommandResult;
  };
  boxesReady: () => boolean;
  modelsOf: (engine: string) => EngineModel[];
}) {
  const { store, apply } = deps;

  function checkCreate(lead: Bot, args: CreateBot) {
    if (!deps.boxesReady()) {
      return "boxes_unavailable";
    }
    const model = args.model ?? lead.model;
    if (!deps.modelsOf(lead.engineAccountId).some(({ id }) => id === model)) {
      return "unknown_model";
    }
    const outside = (args.join_rooms ?? []).some((roomId) => {
      const room = store.rooms.getRoom(roomId);
      return room?.kind !== "group" || !room.members.includes(lead.id);
    });
    return outside ? "not_in_room" : undefined;
  }

  function firstTask(request: TeamRequest, lead: Bot, childId: string, goal: string) {
    const point = store.tasks.runPoint(request.runId);
    if (!point) {
      return { refused: "run_gone" };
    }
    const { source } = point;
    const task = store.tasks.createTask(
      {
        kind: "delegate",
        chainId: point.chainId ?? request.runId,
        hop: point.hop + 1,
        depth: point.depth + 1,
        parentRunId: request.runId,
        requesterBotId: lead.id,
        ownerBotId: childId,
        roomId: point.roomId,
        goal,
        parentTaskId: point.taskId,
        origin: source === "routine" ? "routine" : source === "wait" ? "wake" : "human",
        deliveryKey: `team:${request.id}`,
        attended: point.attended,
      },
      clampLimits(store.readLimits()).fanOut,
    );
    return "refused" in task ? { refused: task.refused } : { taskId: task.id };
  }

  const child = (lead: Bot, bot: string) => {
    const found = store.childrenOf(lead.id).find(named(bot));
    return found && store.getBot(found.id);
  };
  const reachable = (lead: Bot, bot: string) =>
    [...store.childrenOf(lead.id), ...store.tasks.roommatesOf(lead.id)].find(
      (candidate) => candidate.id !== lead.id && named(bot)(candidate),
    );

  // The request as it would be applied now, with bots by id, or why it can't be. Run when asked and
  // again when applied, since the world can move in between.
  function resolve(
    kind: TeamRequestKind,
    lead: Bot,
    args: unknown,
  ): string | Record<string, unknown> {
    switch (kind) {
      case "create_bot": {
        const create = CreateBot.parse(args);
        return checkCreate(lead, create) ?? create;
      }
      case "update_bot": {
        const update = UpdateBot.parse(args);
        const bot = child(lead, update.bot_id);
        if (!bot) {
          return "not_your_bot";
        }
        return bot.version === update.expected_version
          ? { ...update, bot_id: bot.id }
          : "version_conflict";
      }
      case "archive_bot": {
        const bot = child(lead, ArchiveBot.parse(args).bot_id);
        return bot ? { bot_id: bot.id } : "not_your_bot";
      }
      case "create_room": {
        const room = CreateRoom.parse(args);
        const members = room.members.flatMap((bot) => reachable(lead, bot) ?? []);
        if (members.length < room.members.length) {
          return "not_allowed";
        }
        const pick = room.default_bot;
        const defaultBot = pick && [lead, ...members].find(named(pick));
        if (pick && !defaultBot) {
          return "not_member";
        }
        return {
          name: room.name,
          members: members.map(({ id }) => id),
          ...(defaultBot && { default_bot: defaultBot.id }),
        };
      }
      case "invite_to_room": {
        const invite = InviteToRoom.parse(args);
        const room = store.rooms.getRoom(invite.room_id);
        if (room?.kind !== "group" || !room.members.includes(lead.id)) {
          return "not_in_room";
        }
        const bot = reachable(lead, invite.bot);
        return bot ? { room_id: room.id, bot: bot.id } : "not_allowed";
      }
    }
  }

  const outcome = (done: CommandResult, key: "botId" | "roomId"): Outcome =>
    done.status === 200
      ? { status: "applied", result: { [key]: Made.parse(done.body).id } }
      : failed(Code.safeParse(done.body).data?.code ?? "apply_failed");

  // Once the bot exists the request counts as applied: a join, skill or task that is refused is
  // recorded in the result rather than undoing the bot.
  function applyCreate(
    request: TeamRequest,
    lead: Bot,
    args: CreateBot,
    made: { botId?: string },
  ): Outcome {
    const engine = EngineAccountId.safeParse(lead.engineAccountId).data;
    if (!engine) {
      return failed("unknown_engine");
    }
    const created = apply.createBot({
      name: args.name,
      personality: args.personality,
      model: args.model ?? lead.model,
      engineAccountId: engine,
      parentBotId: lead.id,
      spawnKey: `team:${request.id}`,
      forceBox: true,
    });
    if (created.status !== 200) {
      return outcome(created, "botId");
    }
    const botId = Made.parse(created.body).id;
    made.botId = botId;
    const skippedRooms = (args.join_rooms ?? []).filter(
      (roomId) => apply.addRoomMember(roomId, botId).status !== 200,
    );
    const skippedSkills = (args.skills ?? []).filter(
      (skill) => typeof store.setBotSkill(botId, skill, true) === "string",
    );
    const task = args.first_task && firstTask(request, lead, botId, args.first_task);
    return {
      status: "applied",
      result: {
        botId,
        ...(skippedRooms.length > 0 && { skippedRooms }),
        ...(skippedSkills.length > 0 && { skippedSkills }),
        ...(task && { firstTask: task }),
      },
    };
  }

  function applyKind(request: TeamRequest, made: { botId?: string }): Outcome {
    const lead = store.getBot(request.requestedByBotId);
    if (!lead || lead.archivedAt) {
      return failed("lead_gone");
    }
    const payload = resolve(request.kind, lead, request.payload);
    if (typeof payload === "string") {
      return failed(payload);
    }
    switch (request.kind) {
      case "create_bot":
        return applyCreate(request, lead, CreateBot.parse(payload), made);
      case "update_bot": {
        const update = UpdateBot.parse(payload);
        const bot = child(lead, update.bot_id);
        if (!bot) {
          return failed("not_your_bot");
        }
        const done = apply.updateBot({
          botId: bot.id,
          name: update.name ?? bot.name,
          personality: update.personality ?? bot.personality,
          expectedVersion: update.expected_version,
        });
        return outcome(done, "botId");
      }
      case "archive_bot":
        return outcome(apply.archiveBot(ArchiveBot.parse(payload).bot_id), "botId");
      case "create_room": {
        const room = CreateRoom.parse(payload);
        const done = apply.createRoom({
          name: room.name,
          memberIds: [lead.id, ...room.members],
          defaultBotId: room.default_bot ?? null,
        });
        return outcome(done, "roomId");
      }
      case "invite_to_room": {
        const invite = InviteToRoom.parse(payload);
        return outcome(apply.addRoomMember(invite.room_id, invite.bot), "roomId");
      }
    }
  }

  // Undefined when the request was no longer pending.
  function applyRequest(request: TeamRequest) {
    const made: { botId?: string } = {};
    let result: Outcome;
    try {
      result = applyKind(request, made);
    } catch (error) {
      console.error(`beebotd: team request ${request.id} failed`, error);
      result = made.botId
        ? { status: "applied", result: { botId: made.botId, code: "apply_incomplete" } }
        : failed("apply_failed");
    }
    return store.team.finish(request.id, result.status, result.result);
  }

  return {
    call: (run: { id: string; botId: string; attended: boolean }, name: string, args: unknown) => {
      const kind = TeamRequestKind.safeParse(name).data;
      if (!kind) {
        return refused("unknown_tool");
      }
      const grant = store.tasks.runGrant(run.id);
      const lead = store.getBot(run.botId);
      if (!grant || !lead) {
        return refused("run_ended");
      }
      const parsed = schemas[kind].safeParse(args);
      if (!parsed.success) {
        return refused("invalid_arguments");
      }
      const digest = NodeCrypto.createHash("sha256")
        .update(JSON.stringify(canonical({ kind, args: parsed.data })))
        .digest("hex");
      const spawnKey = `${run.id}:${digest}`;
      const replayed = store.team.byKey(spawnKey);
      if (replayed) {
        return answerFor(replayed);
      }
      const payload = resolve(kind, lead, parsed.data);
      if (typeof payload === "string") {
        return refused(payload);
      }
      if (kind === "create_bot" && payload.first_task !== undefined) {
        const { hop, depth, turns, startedAt, tasksInRun, tree } = grant;
        const verdict = checkDelegation(clampLimits(store.readLimits()), {
          chain: { hop, depth, turns, startedAt },
          tasksInRun,
          now: new Date().toISOString(),
          tree,
        });
        if (verdict.verdict === "refuse") {
          return refused(verdict.reason);
        }
      }
      if (kind === "create_bot") {
        if (store.team.countForRun(run.id, kind) >= leadCaps.createsPerTurn) {
          return refused("spawn_cap_turn");
        }
        if (store.spawnedBotCount() + store.team.pendingCreates() >= leadCaps.spawnedInWorkspace) {
          return refused("spawn_cap_workspace");
        }
      }
      if (store.team.pendingFor(lead.id) >= leadCaps.pendingPerLead) {
        return refused("too_many_pending");
      }
      const { request, created } = store.team.insert({
        kind,
        payload,
        requestedByBotId: lead.id,
        runId: run.id,
        spawnKey,
      });
      // Fails closed: a run with no session legs counts as having read something untrusted.
      const clean = store.policy.sessionLegs(run.id)?.readsUntrusted === false;
      if (created && store.leadsActWithoutAsking() && run.attended && clean) {
        return answerFor(applyRequest(request) ?? request);
      }
      return answerFor(request);
    },

    decide: ({
      requestId,
      decision,
    }: Extract<Command, { type: "decide-team-request" }>): CommandResult => {
      const request = store.team.get(requestId);
      if (!request) {
        return { status: 404, body: { code: "not_found" } };
      }
      const decided =
        request.status !== "pending"
          ? undefined
          : decision === "apply"
            ? applyRequest(request)
            : store.team.finish(request.id, "declined", null);
      if (!decided) {
        return { status: 409, body: { code: "team_request_closed" } };
      }
      const lead = store.getBot(decided.requestedByBotId);
      if (lead) {
        const body = notice(decided);
        const id = `team-request:${decided.id}`;
        store.sendMessage({ id, roomId: lead.roomId, body, attended: true }, "approval");
      }
      return { status: 200, body: decided };
    },
  };
}
