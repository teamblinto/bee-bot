import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { LimitOverrides, type ResponderMode, Room } from "@beebot/contracts";
import { z } from "zod";

import { clampLimits } from "./limits.ts";
import { everyoneOptionalCap, type Member } from "./routing.ts";
import type { StoreTx } from "./store.ts";

const RoomRow = Room.omit({ members: true, held: true, heldUntil: true }).extend({
  limits: z.string().transform((json) => LimitOverrides.catch({}).parse(JSON.parse(json))),
  ringUntil: z.string().nullable(),
  escalations: z.number(),
});
const MemberRow = z.object({ botId: z.string() });
const NamedMember = z.object({ id: z.string(), name: z.string() });
const Round = z.object({
  botPosts: z.number(),
  windowStartedAt: z.string().nullable(),
  escalations: z.number(),
  ringUntil: z.string().nullable(),
});

// A member who leaves keeps their scope row, which their past runs and wakes point at.
export function openRooms(
  db: DatabaseSync,
  { transaction, emit }: StoreTx,
  readLimits: () => LimitOverrides,
) {
  const roomColumns = `r.id, r.kind, r.name, r.default_bot_id AS defaultBotId,
    r.created_at AS createdAt, r.responder_mode AS responderMode, r.lead_bot_id AS leadBotId,
    r.bulletin, r.limits_json AS limits, rr.ring_until AS ringUntil,
    COALESCE(rr.escalations, 0) AS escalations
    FROM rooms r LEFT JOIN room_rounds rr ON rr.room_id = r.id`;
  const selectRoom = db.prepare(`SELECT ${roomColumns} WHERE r.id = ?`);
  const selectRooms = db.prepare(`SELECT ${roomColumns} ORDER BY r.rowid`);
  const selectMembers = db.prepare(
    "SELECT bot_id AS botId FROM scopes WHERE room_id = ? AND left_at IS NULL ORDER BY rowid",
  );
  const selectNamedMembers = db.prepare(
    `SELECT b.id, b.name FROM scopes s JOIN bots b ON b.id = s.bot_id
     WHERE s.room_id = ? AND s.left_at IS NULL ORDER BY s.rowid`,
  );
  const insertRoom = db.prepare(
    `INSERT INTO rooms (id, kind, name, default_bot_id, created_at)
     VALUES (?, 'group', ?, ?, ?)`,
  );
  const updateRoom = db.prepare("UPDATE rooms SET name = ?, default_bot_id = ? WHERE id = ?");
  const updateSettings = db.prepare(
    `UPDATE rooms SET responder_mode = ?, lead_bot_id = ?, bulletin = ?, limits_json = ?
     WHERE id = ?`,
  );
  const joinScope = db.prepare(
    `INSERT INTO scopes (id, room_id, bot_id) VALUES (?, ?, ?)
     ON CONFLICT (room_id, bot_id) DO UPDATE SET left_at = NULL`,
  );
  const leaveScope = db.prepare(
    "UPDATE scopes SET left_at = ? WHERE room_id = ? AND bot_id = ? AND left_at IS NULL",
  );
  const closeScopeWakes = db.prepare(
    `UPDATE wakes SET status = 'done' WHERE status = 'pending'
       AND scope_id = (SELECT id FROM scopes WHERE room_id = ? AND bot_id = ?)`,
  );
  const clearDefault = db.prepare(
    "UPDATE rooms SET default_bot_id = NULL WHERE id = ? AND default_bot_id = ?",
  );
  const clearLead = db.prepare(
    "UPDATE rooms SET lead_bot_id = NULL WHERE id = ? AND lead_bot_id = ?",
  );
  const selectRound = db.prepare(
    `SELECT bot_posts AS botPosts, window_started_at AS windowStartedAt, escalations,
       ring_until AS ringUntil
     FROM room_rounds WHERE room_id = ?`,
  );
  const resetRound = db.prepare(
    `INSERT INTO room_rounds (room_id, chain_id, bot_posts, window_started_at, updated_at)
     VALUES (?, ?, 0, NULL, ?)
     ON CONFLICT (room_id) DO UPDATE SET chain_id = excluded.chain_id, bot_posts = 0,
       window_started_at = NULL, escalations = 0, ring_until = NULL,
       updated_at = excluded.updated_at`,
  );
  const addRefusal = db.prepare(
    `INSERT INTO room_rounds (room_id, chain_id, bot_posts, escalations, updated_at)
     VALUES (?, NULL, 0, 1, ?)
     ON CONFLICT (room_id) DO UPDATE SET escalations = escalations + 1,
       updated_at = excluded.updated_at`,
  );
  const setRingUntil = db.prepare(
    `INSERT INTO room_rounds (room_id, chain_id, bot_posts, ring_until, updated_at)
     VALUES (?, NULL, 0, ?, ?)
     ON CONFLICT (room_id) DO UPDATE SET ring_until = excluded.ring_until,
       updated_at = excluded.updated_at`,
  );
  const clearEscalations = db.prepare(
    "UPDATE room_rounds SET escalations = 0, updated_at = ? WHERE room_id = ?",
  );
  const addBotPost = db.prepare(
    `INSERT INTO room_rounds (room_id, chain_id, bot_posts, window_started_at, updated_at)
     VALUES (?, NULL, 1, ?, ?)
     ON CONFLICT (room_id) DO UPDATE SET bot_posts = bot_posts + 1,
       window_started_at = COALESCE(window_started_at, excluded.window_started_at),
       updated_at = excluded.updated_at`,
  );

  const members = (roomId: string) =>
    z
      .array(MemberRow)
      .parse(selectMembers.all(roomId))
      .map(({ botId }) => botId);

  const toRoom = (row: unknown): Room => {
    const { ringUntil, escalations, ...room } = RoomRow.parse(row);
    const { escalationCap } = clampLimits({ ...readLimits(), ...room.limits });
    const escalated = escalations > 0 && escalations >= escalationCap;
    const ringing = ringUntil !== null && ringUntil > new Date().toISOString();
    return {
      ...room,
      members: members(room.id),
      held: escalated ? "escalation" : ringing ? "ring" : null,
      heldUntil: !escalated && ringing ? ringUntil : null,
    };
  };

  const getRoom = (id: string) => {
    const row = selectRoom.get(id);
    return row ? toRoom(row) : undefined;
  };

  const changed = (id: string) => {
    const room = toRoom(selectRoom.get(id));
    emit({ type: "room.changed", room });
    return room;
  };

  // Runs inside the caller's transaction, and tells clients when the room's hold changed.
  const holding = (roomId: string, work: () => void) => {
    const before = getRoom(roomId);
    work();
    const after = getRoom(roomId);
    if (before && after && (before.held !== after.held || before.heldUntil !== after.heldUntil)) {
      emit({ type: "room.changed", room: after });
    }
  };

  const groupRoom = (id: string) => {
    const room = getRoom(id);
    return room?.kind === "group" ? room : undefined;
  };

  return {
    getRoom,
    members,
    listRooms: () => selectRooms.all().map(toRoom),
    namedMembers: (roomId: string): Member[] =>
      z.array(NamedMember).parse(selectNamedMembers.all(roomId)),

    // Round state: bot posts and refused posts since the room's last human message. These join
    // the caller's transaction.
    round: (roomId: string) =>
      Round.parse(
        selectRound.get(roomId) ?? {
          botPosts: 0,
          windowStartedAt: null,
          escalations: 0,
          ringUntil: null,
        },
      ),
    startRound: (roomId: string, chainId: string, now: string) =>
      holding(roomId, () => resetRound.run(roomId, chainId, now)),
    noteRefusal: (roomId: string) =>
      holding(roomId, () => addRefusal.run(roomId, new Date().toISOString())),
    tripRing: (roomId: string, until: string) =>
      holding(roomId, () => setRingUntil.run(roomId, until, new Date().toISOString())),
    resetEscalations: (roomId: string) =>
      transaction(() =>
        holding(roomId, () => clearEscalations.run(new Date().toISOString(), roomId)),
      ),
    countBotPost: (roomId: string, now: string) => {
      addBotPost.run(roomId, now, now);
    },

    createGroupRoom: (input: { name: string; memberIds: string[]; defaultBotId?: string | null }) =>
      transaction(() => {
        const { name, defaultBotId = null } = input;
        const memberIds = [...new Set(input.memberIds)];
        if (defaultBotId !== null && !memberIds.includes(defaultBotId)) {
          return undefined;
        }
        const id = NodeCrypto.randomUUID();
        insertRoom.run(id, name, defaultBotId, new Date().toISOString());
        for (const botId of memberIds) {
          joinScope.run(NodeCrypto.randomUUID(), id, botId);
        }
        return changed(id);
      }),

    // A missing field keeps its value. The default must be a member.
    updateGroupRoom: (roomId: string, input: { name?: string; defaultBotId?: string | null }) =>
      transaction(() => {
        const room = groupRoom(roomId);
        if (!room) {
          return "not_found";
        }
        const { name = room.name, defaultBotId = room.defaultBotId } = input;
        if (defaultBotId !== null && !room.members.includes(defaultBotId)) {
          return "not_member";
        }
        updateRoom.run(name, defaultBotId, roomId);
        return changed(roomId);
      }),

    // A mode is checked only when this call sets it, so a room whose lead or default left can
    // still take other edits. Limits keep only the keys sent.
    setRoomSettings: (
      roomId: string,
      input: {
        responderMode?: ResponderMode | undefined;
        leadBotId?: string | null | undefined;
        bulletin?: string | undefined;
        limits?: LimitOverrides | undefined;
      },
    ) =>
      transaction(() => {
        const room = groupRoom(roomId);
        if (!room) {
          return "not_found";
        }
        const {
          responderMode = room.responderMode,
          leadBotId = room.leadBotId,
          bulletin = room.bulletin,
        } = input;
        const sent = input.responderMode;
        if (
          (leadBotId !== null && !room.members.includes(leadBotId)) ||
          (sent === "lead" && leadBotId === null)
        ) {
          return "not_member";
        }
        if (sent === "everyone_optional" && room.members.length > everyoneOptionalCap) {
          return "too_many_members";
        }
        if (sent === "default" && room.defaultBotId === null) {
          return "default_bot_required";
        }
        const sentLimits = input.limits;
        const limits = sentLimits
          ? Object.fromEntries(
              Object.entries(clampLimits(sentLimits)).filter(([key]) =>
                Object.hasOwn(sentLimits, key),
              ),
            )
          : room.limits;
        updateSettings.run(responderMode, leadBotId, bulletin, JSON.stringify(limits), roomId);
        return changed(roomId);
      }),

    // DMs keep their one bot, so only a group's members change.
    addMember: (roomId: string, botId: string) =>
      transaction(() => {
        const room = groupRoom(roomId);
        if (!room) {
          return undefined;
        }
        if (
          room.responderMode === "everyone_optional" &&
          !room.members.includes(botId) &&
          room.members.length >= everyoneOptionalCap
        ) {
          return "too_many_members";
        }
        joinScope.run(NodeCrypto.randomUUID(), roomId, botId);
        return changed(roomId);
      }),

    removeMember: (roomId: string, botId: string) =>
      transaction(() => {
        if (!groupRoom(roomId)) {
          return undefined;
        }
        if (leaveScope.run(new Date().toISOString(), roomId, botId).changes === 0) {
          return getRoom(roomId);
        }
        closeScopeWakes.run(roomId, botId);
        clearDefault.run(roomId, botId);
        clearLead.run(roomId, botId);
        return changed(roomId);
      }),
  };
}
