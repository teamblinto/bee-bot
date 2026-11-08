import * as NodeCrypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { Room } from "@beebot/contracts";
import { z } from "zod";

import type { StoreTx } from "./store.ts";

const RoomRow = Room.omit({ members: true });
const MemberRow = z.object({ botId: z.string() });

// A member who leaves keeps their scope row, which their past runs and wakes point at.
export function openRooms(db: DatabaseSync, { transaction, emit }: StoreTx) {
  const roomColumns = "id, kind, name, default_bot_id AS defaultBotId, created_at AS createdAt";
  const selectRoom = db.prepare(`SELECT ${roomColumns} FROM rooms WHERE id = ?`);
  const selectRooms = db.prepare(`SELECT ${roomColumns} FROM rooms ORDER BY rowid`);
  const selectMembers = db.prepare(
    "SELECT bot_id AS botId FROM scopes WHERE room_id = ? AND left_at IS NULL ORDER BY rowid",
  );
  const insertRoom = db.prepare(
    `INSERT INTO rooms (id, kind, name, default_bot_id, created_at)
     VALUES (?, 'group', ?, ?, ?)`,
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

  const members = (roomId: string) =>
    z
      .array(MemberRow)
      .parse(selectMembers.all(roomId))
      .map(({ botId }) => botId);

  const toRoom = (row: unknown): Room => {
    const room = RoomRow.parse(row);
    return { ...room, members: members(room.id) };
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

  const groupRoom = (id: string) => (getRoom(id)?.kind === "group" ? id : undefined);

  return {
    getRoom,
    members,
    listRooms: () => selectRooms.all().map(toRoom),

    createGroupRoom: (input: { name: string; memberIds: string[]; defaultBotId?: string | null }) =>
      transaction(() => {
        const { name, memberIds, defaultBotId = null } = input;
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

    // DMs keep their one bot, so only a group's members change.
    addMember: (roomId: string, botId: string) =>
      transaction(() => {
        if (!groupRoom(roomId)) {
          return undefined;
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
        return changed(roomId);
      }),
  };
}
