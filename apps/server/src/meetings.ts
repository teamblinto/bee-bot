import type { DatabaseSync } from "node:sqlite";

import { AgendaItem, keepsMeeting, Meeting, MeetingRecord, MeetingStatus } from "@beebot/contracts";
import { z } from "zod";

import type { StoreTx } from "./store.ts";

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

export function openMeetings(db: DatabaseSync, { transaction, emit }: StoreTx) {
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

  return {
    get,
    live: (roomId: string) => withRecords(selectLive.get(roomId)),
    visible: () =>
      selectVisible
        .all()
        .flatMap((row) => withRecords(row) ?? [])
        .filter(keepsMeeting),
    transition: (id: string, to: MeetingStatus, now: string) =>
      transaction(() => {
        const from = MeetingStatus.options.filter((status) => canTransition(status, to));
        const ended = legal[to].length === 0 ? now : null;
        const moved = updateStatus.get(to, now, ended, id, JSON.stringify(from));
        return (moved && changed(id)) || { refused: "illegal_transition" as const };
      }),
    reserve: (id: string, turns: number) =>
      transaction(() => {
        const reserved = reserveTurns.get(turns, new Date().toISOString(), id, turns) !== undefined;
        if (reserved) {
          changed(id);
        }
        return reserved;
      }),
  };
}
