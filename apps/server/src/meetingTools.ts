import { teamManageGrant } from "@beebot/contracts";
import { z } from "zod";

import { answer, named, refused } from "./botTools.ts";
import { badTime, maxDaysAhead } from "./meetings.ts";
import type { EventStore } from "./store.ts";

const text = { type: "string" };
const botRef = { type: "string", description: "Bot name or id" };
const itemId = { type: "string", description: 'Agenda item id: "1", "2", …' };
const schema = (properties: Record<string, object>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const endTurn = " End your turn; you are woken when everyone has answered.";

const scheduleTool = {
  name: "schedule_meeting",
  description:
    "Schedules a meeting in a group room you are in, with you as facilitator. Give at or " +
    "in_minutes. Invites go to the room and each participant's DM.",
  inputSchema: schema(
    {
      title: text,
      agenda: { type: "array", items: text, minItems: 1, maxItems: 10 },
      participants: {
        type: "array",
        items: text,
        minItems: 1,
        maxItems: 8,
        description: 'Bot names or ids, or ["all"] for every other member of the room',
      },
      room: { type: "string", description: "Room name or id. Leave out for this room" },
      at: { type: "string", description: "ISO time" },
      in_minutes: { type: "integer", minimum: 0, maximum: maxDaysAhead * 24 * 60 },
      timebox_minutes: { type: "integer", minimum: 5, maximum: 180 },
      max_rounds_per_item: { type: "integer", minimum: 1, maximum: 4 },
    },
    ["title", "agenda", "participants"],
  ),
};

const facilitatorTools = [
  {
    name: "start_item",
    description: `Opens an agenda item and asks every participant in turn.${endTurn}`,
    inputSchema: schema({ item_id: itemId, prompt: text }),
  },
  {
    name: "next_round",
    description: `Asks every participant again on the current item.${endTurn}`,
    inputSchema: schema({ prompt: text }),
  },
  {
    name: "ask_participant",
    description: `Asks one participant a question.${endTurn}`,
    inputSchema: schema({ bot: botRef, question: text }),
  },
  {
    name: "record",
    description:
      'Adds a line to the minutes. An action needs an owner: "owner", or a participant or you.',
    inputSchema: schema(
      {
        kind: { type: "string", enum: ["decision", "action", "note", "risk"] },
        text,
        item_id: itemId,
        owner: { type: "string", description: '"owner", or a bot name or id' },
        due: text,
      },
      ["kind", "text"],
    ),
  },
  {
    name: "close_item",
    description: "Closes the active agenda item with a summary.",
    inputSchema: schema({ item_id: itemId, summary: text }),
  },
  {
    name: "defer_item",
    description: "Defers an agenda item to a later meeting.",
    inputSchema: schema({ item_id: itemId, reason: text }, ["item_id"]),
  },
  {
    name: "close_meeting",
    description: "Ends the meeting and posts the minutes.",
    inputSchema: schema({}),
  },
  {
    name: "propose",
    description: `Puts options to the participants, who each take a position.${endTurn}`,
    inputSchema: schema(
      {
        options: { type: "array", items: text, minItems: 2, maxItems: 6 },
        text,
        item_id: itemId,
      },
      ["options"],
    ),
  },
];

const positionTool = {
  name: "position",
  description: "Takes your position on a proposal: one of its options, with a reason.",
  inputSchema: schema({ proposal_id: text, option: text, reason: text }),
};

export const meetingTools = [scheduleTool, ...facilitatorTools, positionTool];
export const meetingToolNames = new Set(meetingTools.map(({ name }) => name));
const facilitatorToolNames = new Set(facilitatorTools.map(({ name }) => name));

const Line = z.string().trim().min(1).max(200);
const Schedule = z
  .object({
    title: Line,
    agenda: z.array(Line).min(1).max(10),
    participants: z.array(z.string().trim().min(1)).min(1).max(8),
    room: z.string().trim().min(1).optional(),
    at: z.iso.datetime({ offset: true }).optional(),
    in_minutes: z
      .number()
      .int()
      .min(0)
      .max(maxDaysAhead * 24 * 60)
      .optional(),
    timebox_minutes: z.number().int().min(5).max(180).default(30),
    max_rounds_per_item: z.number().int().min(1).max(4).default(2),
  })
  .refine(({ at, in_minutes }) => (at === undefined) !== (in_minutes === undefined));

const Prompt = z.string().trim().min(1).max(2000);
const StartItem = z.object({ item_id: z.string(), prompt: Prompt });
const NextRound = z.object({ prompt: Prompt });
const Ask = z.object({ bot: z.string().trim().min(1), question: Prompt });
const Ref = z.string().trim().min(1).max(200);
const RecordArgs = z.object({
  kind: z.enum(["decision", "action", "note", "risk"]),
  text: Prompt,
  item_id: Ref.optional(),
  owner: Ref.optional(),
  due: Ref.optional(),
});
const CloseItem = z.object({ item_id: Ref, summary: Prompt });
const DeferItem = z.object({ item_id: Ref, reason: Prompt.optional() });
const Propose = z.object({
  options: z.array(Line).min(2).max(6),
  text: Prompt.optional(),
  item_id: Ref.optional(),
});
const Position = z.object({
  proposal_id: Ref,
  option: Ref,
  reason: z.string().trim().min(1).max(1000),
});

type Grant = NonNullable<ReturnType<EventStore["tasks"]["runGrant"]>>;

const canSchedule = (store: EventStore, grant: Grant) =>
  (store.getBot(grant.botId)?.manifest.includes(teamManageGrant) ?? false) ||
  store.meetings.chainAsksForMeeting(grant.chainId);

export function meetingToolsFor(store: EventStore, runId: string) {
  const grant = store.tasks.runGrant(runId);
  if (!grant) {
    return [];
  }
  const role = store.meetings.role(grant.roomId, grant.botId);
  return [
    ...(canSchedule(store, grant) ? [scheduleTool] : []),
    ...(role === "facilitator" ? facilitatorTools : []),
    ...(role === "participant" ? [positionTool] : []),
  ];
}

function schedule(store: EventStore, grant: Grant, args: unknown) {
  const { data } = Schedule.safeParse(args);
  if (!data) {
    return refused("invalid_arguments for schedule_meeting");
  }
  const now = new Date();
  const scheduledAt =
    data.at === undefined
      ? new Date(now.getTime() + (data.in_minutes ?? 0) * 60_000).toISOString()
      : new Date(data.at).toISOString();
  if (badTime(scheduledAt, now.toISOString())) {
    return refused("bad_time");
  }
  const mine = store.rooms
    .listRooms()
    .filter(({ kind, members }) => kind === "group" && members.includes(grant.botId));
  const here = mine.find(({ id }) => id === grant.roomId);
  const asked = data.room?.toLowerCase();
  const room =
    asked === undefined
      ? here
      : mine.find(({ id, name }) => id === data.room || name?.toLowerCase() === asked);
  if (asked !== undefined && !room) {
    return refused("not_in_room");
  }
  const pool = room ? store.rooms.namedMembers(room.id) : [...grant.roommates, ...grant.mentioned];
  const others = pool.filter(({ id }) => id !== grant.botId);
  const everyone = data.participants.length === 1 && data.participants[0]?.toLowerCase() === "all";
  const picked = everyone && room ? others : data.participants.map((to) => others.find(named(to)));
  if (picked.length === 0 || picked.includes(undefined)) {
    return refused("not_in_room");
  }
  const ids = [...new Set(picked.flatMap((bot) => (bot ? [bot.id] : [])))];
  if (ids.length > 8 || store.meetings.atLiveLimit(grant.botId)) {
    return refused("too_many");
  }
  let roomId = room?.id;
  if (!roomId) {
    if (!grant.attended || grant.tainted) {
      return refused("room_required");
    }
    roomId = store.rooms.createGroupRoom({
      name: data.title,
      memberIds: [grant.botId, ...ids],
    })?.id;
    if (!roomId) {
      return refused("room_required");
    }
  }
  const meeting = store.meetings.schedule({
    facilitatorBotId: grant.botId,
    roomId,
    title: data.title,
    participants: ids,
    agenda: data.agenda,
    scheduledAt,
    timeboxMin: data.timebox_minutes,
    maxRoundsPerItem: data.max_rounds_per_item,
    createdByRunId: grant.runId,
    chain: { chainId: grant.chainId, hop: grant.hop, depth: grant.depth },
  });
  if ("refused" in meeting) {
    return refused(meeting.refused);
  }
  return answer({
    status: "scheduled",
    meeting_id: meeting.id,
    room_id: meeting.roomId,
    scheduled_at: meeting.scheduledAt,
    note: "Invites are sent. End your turn; you are woken in the room when the meeting starts.",
  });
}

// The engine may have cached its tool list, so every call checks the caller's role again.
export function callMeetingTool(
  store: EventStore,
  run: { id: string },
  name: string,
  args: unknown,
) {
  const grant = store.tasks.runGrant(run.id);
  if (!grant) {
    return refused("run_ended");
  }
  if (name === "schedule_meeting") {
    return canSchedule(store, grant) ? schedule(store, grant, args) : refused("not_allowed");
  }
  if (store.meetings.live(grant.roomId)?.status !== "running") {
    return refused("not_running");
  }
  const role = store.meetings.role(grant.roomId, grant.botId);
  if (facilitatorToolNames.has(name) && role !== "facilitator") {
    return refused("not_facilitator");
  }
  if (name === "position" && role !== "participant") {
    return refused("not_participant");
  }
  const meetingId = store.meetings.live(grant.roomId)?.id ?? "";
  const { botId, attended } = grant;
  const passed = (result: ReturnType<EventStore["meetings"]["startItem"]>, status: string) =>
    "refused" in result ? refused(result.refused) : answer({ status, note: endTurn.trim() });
  if (name === "start_item") {
    const { data } = StartItem.safeParse(args);
    return data
      ? passed(
          store.meetings.startItem(meetingId, botId, data.item_id, data.prompt, attended),
          "started",
        )
      : refused("invalid_arguments for start_item");
  }
  if (name === "next_round") {
    const { data } = NextRound.safeParse(args);
    return data
      ? passed(store.meetings.nextRound(meetingId, botId, data.prompt, attended), "started")
      : refused("invalid_arguments for next_round");
  }
  if (name === "ask_participant") {
    const { data } = Ask.safeParse(args);
    return data
      ? passed(
          store.meetings.askParticipant(meetingId, botId, data.bot, data.question, attended),
          "asked",
        )
      : refused("invalid_arguments for ask_participant");
  }
  if (name === "record") {
    const { data } = RecordArgs.safeParse(args);
    if (!data) {
      return refused("invalid_arguments for record");
    }
    const { item_id: itemId, ...input } = data;
    const record = store.meetings.record(
      meetingId,
      botId,
      { ...input, itemId },
      { id: grant.runId, attended },
    );
    if ("refused" in record) {
      return refused(record.refused);
    }
    const task = record.taskId ? { task_id: record.taskId } : {};
    return answer({ status: "recorded", record_id: record.id, ...task, note: "Recorded." });
  }
  if (name === "close_item" || name === "defer_item") {
    const close = CloseItem.safeParse(args).data;
    const defer = DeferItem.safeParse(args).data;
    const result =
      name === "close_item"
        ? close && store.meetings.closeItem(meetingId, botId, close.item_id, close.summary)
        : defer && store.meetings.deferItem(meetingId, botId, defer.item_id, defer.reason);
    if (!result) {
      return refused(`invalid_arguments for ${name}`);
    }
    return "refused" in result
      ? refused(result.refused)
      : answer({
          status: name === "close_item" ? "closed" : "deferred",
          note: "Start the next item, or close_meeting when the agenda is done.",
        });
  }
  if (name === "propose") {
    const { data } = Propose.safeParse(args);
    if (!data) {
      return refused("invalid_arguments for propose");
    }
    const input = { options: data.options, text: data.text, itemId: data.item_id };
    const result = store.meetings.propose(meetingId, botId, input, attended);
    return "refused" in result
      ? refused(result.refused)
      : answer({ status: "proposed", proposal_id: result.proposal_id, note: endTurn.trim() });
  }
  if (name === "position") {
    const { data } = Position.safeParse(args);
    if (!data) {
      return refused("invalid_arguments for position");
    }
    const input = { proposalId: data.proposal_id, option: data.option, reason: data.reason };
    const result = store.meetings.position(meetingId, botId, input);
    return "refused" in result
      ? refused(result.refused)
      : answer({ status: "recorded", position: result.text, note: "End your turn." });
  }
  return refused("unknown_tool");
}
