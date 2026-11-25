import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { AgendaItem, keepsMeeting, Meeting, MeetingRecord, MeetingStatus } from "@beebot/contracts";
import { z } from "zod";

import type { StoreTx } from "./store.ts";
import type { ChainPoint } from "./tasks.ts";

export type MeetingRefusal =
  | "not_running"
  | "not_facilitator"
  | "not_participant"
  | "item_not_found"
  | "item_active"
  | "item_not_active"
  | "round_cap"
  | "turn_cap"
  | "times_up"
  | "room_busy"
  | "too_many"
  | "bad_time"
  | "not_in_room"
  | "room_required"
  | "owner_required"
  | "option_not_found"
  | "proposal_closed"
  | "illegal_transition"
  | "record_cap";

export type MeetingDelivery = {
  post(m: { id: string; roomId: string; botId: string; body: string } & ChainPoint): void;
};

export const maxDaysAhead = 7;
const maxLivePerFacilitator = 3;

// The model's clock can lag a little, so a time up to a minute past still counts as now.
export const badTime = (at: string, now: string) =>
  Date.parse(at) < Date.parse(now) - 60_000 ||
  Date.parse(at) > Date.parse(now) + maxDaysAhead * 86_400_000;

const legal: Record<MeetingStatus, MeetingStatus[]> = {
  scheduled: ["open", "cancelled"],
  open: ["running", "cancelled"],
  running: ["closed", "cancelled"],
  closed: [],
  cancelled: [],
};

export const turnCap = (participants: number, items: number, maxRounds: number) =>
  participants * items * maxRounds + items * 3 + 4;

export const canTransition = (from: MeetingStatus, to: MeetingStatus) => legal[from].includes(to);

const json = <T extends z.ZodType>(schema: T) =>
  z.string().transform((text): z.infer<T> => schema.parse(JSON.parse(text)));
const MeetingRow = Meeting.omit({ records: true }).extend({
  participants: json(z.array(z.string())),
  agenda: json(z.array(AgendaItem)),
});
const RecordRow = MeetingRecord.extend({
  ownerIsHuman: z.number().transform(Boolean),
  options: json(z.array(z.string())),
});

const Named = z.object({ name: z.string() });
const Invitee = z.object({ name: z.string(), dmRoomId: z.string() });

export function openMeetings(
  db: DatabaseSync,
  { transaction, emit }: StoreTx,
  deliver: MeetingDelivery,
) {
  const columns = `id, room_id AS roomId, facilitator_bot_id AS facilitatorBotId, title,
    scheduled_at AS scheduledAt, timebox_min AS timeboxMin, status,
    participants_json AS participants, agenda_json AS agenda, current_item AS currentItem, round,
    max_rounds_per_item AS maxRoundsPerItem, minutes_message_id AS minutesMessageId,
    turn_cap AS turnCap, turns_used AS turnsUsed, started_at AS startedAt, ends_at AS endsAt,
    times_up_at AS timesUpAt, ended_at AS endedAt, created_at AS createdAt FROM meetings`;
  const live = "status IN ('scheduled', 'open', 'running')";
  const selectOne = db.prepare(`SELECT ${columns} WHERE id = ?`);
  const selectLive = db.prepare(`SELECT ${columns} WHERE room_id = ? AND ${live}`);
  const selectVisible = db.prepare(
    `SELECT ${columns} WHERE ${live} OR id IN (SELECT meeting_id FROM meeting_records
       WHERE kind = 'action' AND owner_is_human = 1 AND done_at IS NULL)
     ORDER BY created_at, rowid`,
  );
  const selectRecords = db.prepare(
    `SELECT id, meeting_id AS meetingId, kind, item_id AS itemId, text, owner_bot_id AS ownerBotId,
       owner_is_human AS ownerIsHuman, task_id AS taskId, due, proposal_id AS proposalId,
       options_json AS options, done_at AS doneAt, created_by_bot_id AS createdByBotId,
       created_at AS createdAt
     FROM meeting_records WHERE meeting_id = ? ORDER BY created_at, rowid`,
  );
  const updateStatus = db.prepare(
    `UPDATE meetings SET status = ?, updated_at = ?, ended_at = COALESCE(?, ended_at)
     WHERE id = ? AND status IN (SELECT value FROM json_each(?)) RETURNING id`,
  );
  const reserveTurns = db.prepare(
    `UPDATE meetings SET turns_used = turns_used + ?, updated_at = ?
     WHERE id = ? AND status = 'running' AND turns_used + ? <= turn_cap RETURNING id`,
  );

  const countLive = db.prepare(
    `SELECT COUNT(*) AS count FROM meetings WHERE facilitator_bot_id = ? AND ${live}`,
  );
  const insertMeeting = db.prepare(
    `INSERT INTO meetings (id, room_id, facilitator_bot_id, title, scheduled_at, timebox_min,
       status, participants_json, agenda_json, max_rounds_per_item, created_by_run_id,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)`,
  );
  const selectBotName = db.prepare("SELECT name FROM bots WHERE id = ?");
  const selectRoomName = db.prepare("SELECT name FROM rooms WHERE id = ?");
  const selectInvitee = db.prepare(
    `SELECT b.name, r.id AS dmRoomId FROM bots b
     JOIN rooms r ON r.kind = 'dm' AND r.default_bot_id = b.id WHERE b.id = ?`,
  );
  const selectOpening = db.prepare(
    "SELECT body FROM messages WHERE chain_id = ? AND hop = 0 AND author = 'human' LIMIT 1",
  );

  const withRecords = (row: unknown): Meeting | undefined => {
    if (row === undefined) {
      return undefined;
    }
    const meeting = MeetingRow.parse(row);
    return { ...meeting, records: z.array(RecordRow).parse(selectRecords.all(meeting.id)) };
  };
  const get = (id: string) => withRecords(selectOne.get(id));
  const changed = (id: string) => {
    const meeting = get(id);
    if (meeting) {
      emit({ type: "meeting.changed", meeting });
    }
    return meeting;
  };

  const liveIn = (roomId: string) => withRecords(selectLive.get(roomId));

  const transitionIn = (id: string, to: MeetingStatus, now: string) => {
    const from = MeetingStatus.options.filter((status) => canTransition(status, to));
    const ended = legal[to].length === 0 ? now : null;
    const moved = updateStatus.get(to, now, ended, id, JSON.stringify(from));
    return (moved && changed(id)) || { refused: "illegal_transition" as const };
  };

  const reserveIn = (id: string, turns: number) => {
    const reserved = reserveTurns.get(turns, new Date().toISOString(), id, turns) !== undefined;
    if (reserved) {
      changed(id);
    }
    return reserved;
  };

  return {
    get,
    live: liveIn,
    visible: () =>
      selectVisible
        .all()
        .flatMap((row) => withRecords(row) ?? [])
        .filter(keepsMeeting),
    transition: (id: string, to: MeetingStatus, now: string) =>
      transaction(() => transitionIn(id, to, now)),
    reserve: (id: string, turns: number) => transaction(() => reserveIn(id, turns)),

    // Defined only while the room's live meeting is running: that is when meeting tools apply.
    role: (roomId: string, botId: string) => {
      const meeting = liveIn(roomId);
      if (meeting?.status !== "running") {
        return undefined;
      }
      if (meeting.facilitatorBotId === botId) {
        return "facilitator" as const;
      }
      return meeting.participants.includes(botId) ? ("participant" as const) : undefined;
    },

    // shortcut: keyword match on the owner's opening message, upgrade if owners ask for meetings in other words
    chainAsksForMeeting: (chainId: string) => {
      const row = z.object({ body: z.string() }).optional().parse(selectOpening.get(chainId));
      return row !== undefined && /meeting/i.test(row.body);
    },

    schedule: (input: {
      facilitatorBotId: string;
      roomId: string;
      title: string;
      participants: string[];
      agenda: string[];
      scheduledAt: string;
      timeboxMin: number;
      maxRoundsPerItem: number;
      createdByRunId: string;
      chain: ChainPoint;
    }): Meeting | { refused: MeetingRefusal } =>
      transaction(() => {
        const now = new Date().toISOString();
        const { facilitatorBotId, roomId, title, participants, scheduledAt, chain } = input;
        if (badTime(scheduledAt, now)) {
          return { refused: "bad_time" };
        }
        if (liveIn(roomId)) {
          return { refused: "room_busy" };
        }
        const { count } = z.object({ count: z.number() }).parse(countLive.get(facilitatorBotId));
        if (count >= maxLivePerFacilitator) {
          return { refused: "too_many" };
        }
        const agenda: AgendaItem[] = input.agenda.map((itemTitle, index) => ({
          id: String(index + 1),
          title: itemTitle,
          ownerBotId: null,
          status: "pending",
          summary: null,
        }));
        const id = NodeCrypto.randomUUID();
        insertMeeting.run(
          id,
          roomId,
          facilitatorBotId,
          title,
          scheduledAt,
          input.timeboxMin,
          JSON.stringify(participants),
          JSON.stringify(agenda),
          input.maxRoundsPerItem,
          input.createdByRunId,
          now,
          now,
        );
        const invitees = participants.map((botId) => Invitee.parse(selectInvitee.get(botId)));
        const facilitator = Named.parse(selectBotName.get(facilitatorBotId)).name;
        const body =
          `Meeting "${title}" at ${scheduledAt}. Facilitator: ${facilitator}. ` +
          `Participants: ${invitees.map(({ name }) => name).join(", ")}. ` +
          `Agenda: ${agenda.map((item) => `${item.id}. ${item.title}`).join(" ")}`;
        const roomName = Named.parse(selectRoomName.get(roomId)).name;
        const from = { botId: facilitatorBotId, ...chain };
        deliver.post({ ...from, id: `meeting:${NodeCrypto.randomUUID()}`, roomId, body });
        for (const { dmRoomId } of invitees) {
          const notice = `${body} in ${roomName}`;
          deliver.post({ ...from, id: NodeCrypto.randomUUID(), roomId: dmRoomId, body: notice });
        }
        const meeting = changed(id);
        if (!meeting) {
          throw new Error(`meeting ${id} was not saved`);
        }
        return meeting;
      }),
  };
}
