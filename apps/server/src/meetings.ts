import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  AgendaItem,
  keepsMeeting,
  Meeting,
  MeetingRecord,
  MeetingStatus,
  type Run,
} from "@beebot/contracts";
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
  post(m: { id: string; roomId: string; botId: string | null; body: string } & ChainPoint): void;
  // False when the bot has no live scope in the room or is archived.
  wake(roomId: string, botId: string, key: string, attended: boolean, chain: ChainPoint): boolean;
};

export const maxDaysAhead = 7;
const maxLivePerFacilitator = 3;
const openGraceMs = 60 * 60_000;

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
  const selectDue = db.prepare(
    `SELECT ${columns} WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at`,
  );
  const selectStale = db.prepare(
    `SELECT ${columns} WHERE status = 'open' AND scheduled_at <= ? ORDER BY scheduled_at`,
  );
  const startMeeting = db.prepare(
    `UPDATE meetings SET status = 'running', turn_cap = ?, turns_used = 1, started_at = ?,
       ends_at = ?, updated_at = ?
     WHERE id = ? AND status = 'open' RETURNING id`,
  );
  const selectScopeRoom = db.prepare("SELECT room_id AS roomId FROM scopes WHERE id = ?");
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
  const atLiveLimit = (botId: string) =>
    z.object({ count: z.number() }).parse(countLive.get(botId)).count >= maxLivePerFacilitator;

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

  const notice = (meeting: Meeting, body: string) =>
    deliver.post({
      id: `notice:${NodeCrypto.randomUUID()}`,
      roomId: meeting.roomId,
      botId: null,
      body,
      chainId: meeting.id,
      hop: 0,
      depth: 0,
    });
  const cancel = (meeting: Meeting, why: string, now: string) => {
    if (!("refused" in transitionIn(meeting.id, "cancelled", now))) {
      notice(meeting, why);
    }
  };
  const nameOf = (botId: string) => Named.parse(selectBotName.get(botId)).name;

  const open = (meeting: Meeting, now: string, attended: boolean) => {
    if ("refused" in transitionIn(meeting.id, "open", now)) {
      return;
    }
    notice(meeting, `Meeting "${meeting.title}" is starting.`);
    const chain = { chainId: meeting.id, hop: 0, depth: 0 };
    const key = `meeting:${meeting.id}:open`;
    if (!deliver.wake(meeting.roomId, meeting.facilitatorBotId, key, attended, chain)) {
      const name = nameOf(meeting.facilitatorBotId);
      cancel(meeting, `${name} couldn't start the meeting (not in the room).`, now);
    }
  };

  // Each row in its own transaction, so one bad row can't block the others.
  const eachRow = (rows: unknown[], act: (meeting: Meeting) => void) => {
    for (const row of rows) {
      try {
        const meeting = withRecords(row);
        if (meeting) {
          transaction(() => act(meeting));
        }
      } catch (error) {
        console.error(`beebotd: meeting ${MeetingRow.safeParse(row).data?.id} failed`, error);
      }
    }
  };

  // Facilitator and participants of the room's live meeting, from its opening.
  const takesPart = (roomId: string, botId: string) => {
    const meeting = liveIn(roomId);
    return (
      (meeting?.status === "open" || meeting?.status === "running") &&
      (meeting.facilitatorBotId === botId || meeting.participants.includes(botId))
    );
  };

  return {
    get,
    live: liveIn,
    atLiveLimit,
    takesPart,

    tick: (now: string, attended: boolean) => {
      const stale = new Date(Date.parse(now) - openGraceMs).toISOString();
      eachRow(selectStale.all(stale), (meeting) =>
        cancel(
          meeting,
          `Meeting "${meeting.title}" didn't start within an hour, so it's cancelled.`,
          now,
        ),
      );
      eachRow(selectDue.all(now), (meeting) => open(meeting, now, attended));
    },

    // Runs inside claimRun's transaction: the meeting starts when its facilitator's turn does.
    claimed: (run: { botId: string }, roomId: string, now: string) => {
      const meeting = liveIn(roomId);
      if (meeting?.status !== "open" || meeting.facilitatorBotId !== run.botId) {
        return;
      }
      const cap = turnCap(
        meeting.participants.length,
        meeting.agenda.length,
        meeting.maxRoundsPerItem,
      );
      const endsAt = new Date(Date.parse(now) + meeting.timeboxMin * 60_000).toISOString();
      if (startMeeting.get(cap, now, endsAt, now, meeting.id)) {
        changed(meeting.id);
      }
    },

    // Runs inside the caller's transaction, next to tasks.settleRun.
    settleRun: (
      run: Pick<Run, "botId" | "chainId" | "reason"> & { scopeId: string },
      status: "done" | "failed" | "cancelled" | "refused",
    ) => {
      const scope = z
        .object({ roomId: z.string() })
        .optional()
        .parse(selectScopeRoom.get(run.scopeId));
      const meeting = scope && liveIn(scope.roomId);
      if (
        status === "refused" &&
        meeting?.status === "open" &&
        meeting.facilitatorBotId === run.botId &&
        run.chainId === meeting.id
      ) {
        const why = `${nameOf(run.botId)} couldn't start the meeting (${run.reason ?? "refused"}).`;
        cancel(meeting, why, new Date().toISOString());
      }
    },

    frameFor: (roomId: string, botId: string) => {
      const meeting = liveIn(roomId);
      return meeting?.status === "running" &&
        meeting.facilitatorBotId === botId &&
        meeting.currentItem === null
        ? `[meeting] "${meeting.title}"
The meeting has started. Call start_item for item 1.`
        : "";
    },
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
        if (atLiveLimit(facilitatorBotId)) {
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
        const facilitator = nameOf(facilitatorBotId);
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
