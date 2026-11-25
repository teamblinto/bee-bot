import { type Bot, limitCeilings, limitDefaults, Room } from "@beebot/contracts";
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

const everyoneCap = 6;

export function RoomSettingsDialog({
  room,
  bots,
  onClose,
}: {
  room: Room;
  bots: Bot[];
  onClose: () => void;
}) {
  const startPosts = room.limits.posts ?? limitDefaults.posts;
  const [mode, setMode] = useState(room.responderMode);
  const [leadBotId, setLeadBotId] = useState(room.leadBotId ?? "");
  const [bulletin, setBulletin] = useState(room.bulletin);
  const [posts, setPosts] = useState(startPosts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const members = room.members.flatMap((id) => bots.filter((bot) => bot.id === id));
  const crowded = room.members.length > everyoneCap;
  const choices = [
    { value: "mentions", label: "Bots you name, else the default bot", off: false },
    { value: "default", label: "The default bot", off: room.defaultBotId === null },
    { value: "everyone_optional", label: "Everyone, one at a time, may stay quiet", off: crowded },
    { value: "lead", label: "A lead, who passes work on", off: false },
  ] as const;

  async function submit() {
    if (busy) {
      return;
    }
    if (mode === "lead" && leadBotId === "") {
      setError("Pick the bot that leads.");
      return;
    }
    const changes = {
      ...(mode !== room.responderMode && { responderMode: mode }),
      ...(mode === "lead" && leadBotId !== room.leadBotId && { leadBotId }),
      ...(bulletin !== room.bulletin && { bulletin }),
      ...(posts !== startPosts && { limits: { ...room.limits, posts } }),
    };
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await postCommand({ type: "update-room", roomId: room.id, ...changes });
    setBusy(false);
    if (result.ok) {
      onClose();
    } else {
      setError(result.message);
    }
  }

  return (
    <Dialog
      title="Room settings"
      confirm="Save settings"
      busy={busy}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <fieldset className="flex flex-col gap-1">
        <legend className="field-label">Who answers</legend>
        {choices.map(({ value, label, off }) => (
          <label key={value} className="flex min-h-8 items-center gap-2 text-body-s">
            <input
              type="radio"
              name="responder-mode"
              className="size-4 accent-brand-fill"
              value={value}
              disabled={off}
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            <span className={off ? "text-ink-disabled" : undefined}>{label}</span>
          </label>
        ))}
        {room.defaultBotId === null && (
          <p className="field-help">The default bot needs a room with a default bot.</p>
        )}
        {crowded && (
          <p className="field-help">
            Everyone answering works for rooms of up to {everyoneCap} bots.
          </p>
        )}
        {mode === "lead" && (
          <label className="mt-1 flex flex-col gap-1">
            <span className="field-label">Lead</span>
            <select
              className="field"
              value={leadBotId}
              onChange={(event) => setLeadBotId(event.target.value)}
            >
              <option value="" disabled>
                Pick a bot
              </option>
              {members.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </fieldset>
      <label className="flex flex-col gap-1">
        <span className="field-label">Bulletin</span>
        <textarea
          className="field min-h-20 py-2"
          maxLength={4000}
          placeholder="Notes every bot here reads first"
          value={bulletin}
          onChange={(event) => setBulletin(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="field-label">Bot posts per 5 minutes</span>
        <input
          type="number"
          className="field w-24"
          min={0}
          max={limitCeilings.posts}
          step={1}
          value={posts}
          onChange={(event) =>
            setPosts(Math.min(limitCeilings.posts, Math.max(0, event.target.valueAsNumber || 0)))
          }
        />
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
