import type { Bot, Room, TeamRequest } from "@beebot/contracts";
import { useRef, useState } from "react";

import { postCommand } from "../serverConnection";

const text = (value: unknown) => (typeof value === "string" ? value : "");
const ids = (value: unknown) =>
  Array.isArray(value) ? value.filter((id) => typeof id === "string") : [];

// The server stores bots and rooms by id; one may be gone by the time the owner looks.
function fields(request: TeamRequest, bots: Bot[], rooms: Room[]): [string, string][] {
  const { payload } = request;
  const bot = (id: unknown) => bots.find((b) => b.id === id)?.name ?? "a removed bot";
  const room = (id: unknown) => rooms.find((r) => r.id === id)?.name ?? "a removed room";
  switch (request.kind) {
    case "create_bot":
      return [
        ["Name", text(payload.name)],
        ["Personality", text(payload.personality)],
        ["Model", text(payload.model)],
        ["Rooms", ids(payload.join_rooms).map(room).join(", ")],
        ["First task", text(payload.first_task)],
      ];
    case "update_bot":
      return [
        ["Bot", bot(payload.bot_id)],
        ["New name", text(payload.name)],
        ["New personality", text(payload.personality)],
      ];
    case "archive_bot":
      return [["Bot", bot(payload.bot_id)]];
    case "create_room":
      return [
        ["Name", text(payload.name)],
        ["Members", ids(payload.members).map(bot).join(", ")],
      ];
    case "invite_to_room":
      return [
        ["Room", room(payload.room_id)],
        ["Bot", bot(payload.bot)],
      ];
  }
}

export function TeamRequestCard({
  request,
  bots,
  rooms,
  connected,
}: {
  request: TeamRequest;
  bots: Bot[];
  rooms: Room[];
  connected: boolean;
}) {
  const deciding = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(decision: "apply" | "decline") {
    if (deciding.current) {
      return;
    }
    deciding.current = true;
    setBusy(true);
    setError(undefined);
    const result = await postCommand({
      type: "decide-team-request",
      requestId: request.id,
      decision,
    });
    // On success the lock stays: this card closes when the request event arrives.
    if (!result.ok) {
      deciding.current = false;
      setBusy(false);
      setError(result.message);
    }
  }

  const disabled = busy || !connected;
  return (
    <article className="surface flex max-w-[560px] flex-col gap-2 p-4">
      <dl className="flex flex-col gap-1 text-body-s">
        {fields(request, bots, rooms)
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="flex gap-2">
              <dt className="shrink-0 text-ink-secondary">{label}</dt>
              <dd className="max-h-60 overflow-y-auto wrap-anywhere whitespace-pre-wrap">
                {value}
              </dd>
            </div>
          ))}
      </dl>
      {error && <p className="text-caption text-ink-secondary">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button
          type="button"
          className="button button-sm button-outline"
          disabled={disabled}
          onClick={() => void decide("decline")}
        >
          Decline
        </button>
        <button
          type="button"
          className="button button-sm button-primary"
          disabled={disabled}
          onClick={() => void decide("apply")}
        >
          Apply
        </button>
      </div>
    </article>
  );
}
