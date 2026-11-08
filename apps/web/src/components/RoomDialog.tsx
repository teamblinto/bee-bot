import { type Bot, Room } from "@beebot/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { postCommand } from "../serverConnection";
import { Avatar } from "./Avatar";

const labelClass = "flex flex-col gap-1 text-label text-ink-secondary";

export function RoomDialog({
  bots,
  onSaved,
  onClose,
}: {
  bots: Bot[];
  onSaved: (room: Room) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [defaultBotId, setDefaultBotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const members = bots.filter(({ id }) => memberIds.includes(id));
  const canCreate = !busy && name.trim() !== "" && memberIds.length > 0;

  useEffect(() => {
    if (!dialog.current?.open) {
      dialog.current?.showModal();
    }
  }, []);

  function toggle(botId: string, on: boolean) {
    setMemberIds((ids) => (on ? [...ids, botId] : ids.filter((id) => id !== botId)));
    if (!on && defaultBotId === botId) {
      setDefaultBotId("");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await postCommand({
      type: "create-room",
      name,
      memberIds,
      defaultBotId: defaultBotId || null,
    });
    setBusy(false);
    if (result.ok) {
      onSaved(Room.parse(result.body));
    } else {
      setError(result.message);
    }
  }

  return (
    <dialog
      ref={dialog}
      aria-label="New room"
      className="dialog m-auto w-[min(440px,calc(100vw-32px))] p-5 backdrop:bg-scrim"
      onClose={onClose}
    >
      <h2 className="mb-4 text-title font-semibold">New room</h2>
      <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
        <label className={labelClass}>
          Name
          <input
            className="field text-ink"
            maxLength={80}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-label text-ink-secondary">Bots</legend>
          {bots.map((bot) => (
            <label key={bot.id} className="flex items-center gap-2 text-small">
              <input
                type="checkbox"
                checked={memberIds.includes(bot.id)}
                onChange={(event) => toggle(bot.id, event.target.checked)}
              />
              <Avatar seed={bot.avatarSeed} className="size-5" />
              {bot.name}
            </label>
          ))}
        </fieldset>
        <label className={labelClass}>
          Answers when no bot is mentioned
          <select
            className="field text-ink"
            value={defaultBotId}
            onChange={(event) => setDefaultBotId(event.target.value)}
          >
            <option value="">Nobody, ask me</option>
            {members.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>
        {error && (
          <p role="alert" className="text-small text-ink-secondary">
            {error}
          </p>
        )}
        <div className="mt-1 flex items-center justify-end gap-1">
          <button type="button" className="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={!canCreate}>
            Create room
          </button>
        </div>
      </form>
    </dialog>
  );
}
