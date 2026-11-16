import { type Bot, Room } from "@beebot/contracts";
import { CircleAlert, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { postCommand } from "../serverConnection";
import { Avatar } from "./Avatar";
import { Tooltip } from "./Tooltip";
import { iconProps } from "./ui";

function Dialog({
  title,
  confirm,
  busy,
  error,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  confirm: string;
  busy: boolean;
  error: string | undefined;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!dialog.current?.open) {
      dialog.current?.showModal();
      dialog.current?.querySelector("input")?.focus();
    }
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-label={title}
      className="dialog m-auto w-[min(560px,calc(100vw-32px))] p-6 backdrop:bg-scrim"
      onClose={onClose}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="flex items-start gap-2">
          <h2 className="flex-1 pt-1 text-title-s font-semibold">{title}</h2>
          <Tooltip label="Close">
            <button
              type="button"
              aria-label="Close"
              className="button button-icon"
              onClick={() => dialog.current?.close()}
            >
              <X {...iconProps} />
            </button>
          </Tooltip>
        </div>
        {children}
        {error && (
          <p role="alert" className="text-body-s text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="button button-outline"
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {confirm}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function FieldError({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} className="flex items-center gap-1 text-caption text-danger">
      <CircleAlert {...iconProps} size={12} className="text-danger-status" />
      {children}
    </p>
  );
}

function NameField({
  name,
  setName,
  invalid,
}: {
  name: string;
  setName: (name: string) => void;
  invalid: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="field-label">Name</span>
      <input
        className="field"
        maxLength={80}
        placeholder="For example, Research desk"
        aria-invalid={invalid}
        aria-describedby={invalid ? "room-name-error" : undefined}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      {invalid && <FieldError id="room-name-error">Give the room a name.</FieldError>}
    </label>
  );
}

export function RoomDialog({
  bots,
  onSaved,
  onClose,
}: {
  bots: Bot[];
  onSaved: (room: Room) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [defaultBotId, setDefaultBotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string>();
  const members = bots.filter(({ id }) => memberIds.includes(id));
  const noName = tried && name.trim() === "";
  const noBots = tried && memberIds.length === 0;

  function toggle(botId: string, on: boolean) {
    setMemberIds((ids) => (on ? [...ids, botId] : ids.filter((id) => id !== botId)));
    if (!on && defaultBotId === botId) {
      setDefaultBotId("");
    }
  }

  async function submit() {
    setTried(true);
    if (busy || name.trim() === "" || memberIds.length === 0) {
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
    <Dialog
      title="New room"
      confirm="Create room"
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <NameField name={name} setName={setName} invalid={noName} />
      <fieldset
        className="flex flex-col"
        aria-describedby={noBots ? "room-bots-error" : "room-bots-help"}
      >
        <legend className="field-label">Bots</legend>
        {noBots ? (
          <p id="room-bots-error" className="mt-1 text-caption text-danger">
            Pick at least one bot
          </p>
        ) : (
          <p id="room-bots-help" className="field-help mt-1">
            Pick the bots that can answer here.
          </p>
        )}
        <div className="mt-1 flex flex-col">
          {bots.map((bot) => (
            <label
              key={bot.id}
              className="flex h-9 cursor-default items-center gap-2 rounded-row px-2 text-body-s font-medium hover:bg-hover"
            >
              <input
                type="checkbox"
                className="size-4 accent-brand-fill"
                checked={memberIds.includes(bot.id)}
                onChange={(event) => toggle(bot.id, event.target.checked)}
              />
              <Avatar seed={bot.avatarSeed} className="size-5" />
              <span className="truncate">{bot.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex flex-col gap-1">
        <span className="field-label">Answers when nobody is @mentioned</span>
        <select
          className="field"
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
        <span className="field-help">Only bots ticked above can answer by default.</span>
      </label>
    </Dialog>
  );
}

export function RenameRoomDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const [name, setName] = useState(room.name ?? "");
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    setTried(true);
    if (busy || name.trim() === "") {
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await postCommand({ type: "update-room", roomId: room.id, name });
    setBusy(false);
    if (result.ok) {
      onClose();
    } else {
      setError(result.message);
    }
  }

  return (
    <Dialog
      title="Rename room"
      confirm="Save name"
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <NameField name={name} setName={setName} invalid={tried && name.trim() === ""} />
    </Dialog>
  );
}
