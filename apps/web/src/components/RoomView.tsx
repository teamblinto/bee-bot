import type { Bot, ChatState, Room } from "@beebot/contracts";
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Ellipsis,
  LoaderCircle,
  PanelLeft,
  Pencil,
  Plus,
  Settings,
  Users,
} from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import { connectionLines, shortTime } from "../labels";
import {
  type ConnectionState,
  isActive,
  postCommand,
  requestNotifications,
  sendCommand,
  waitingOnOwner,
} from "../serverConnection";
import { buildTranscript } from "../transcript";
import { AttachButton, UploadChips, useAttachments } from "./Attachments";
import { Avatar } from "./Avatar";
import { useMentionMenu } from "./MentionMenu";
import { RenameRoomDialog, RoomSettingsDialog } from "./RoomDialog";
import { Tooltip } from "./Tooltip";
import { Transcript } from "./Transcript";
import { columnClass, iconProps } from "./ui";

const menuItemClass =
  "flex min-h-8 w-full items-center gap-2 rounded-row px-2 py-1 text-left text-body-s transition-colors hover:bg-hover disabled:text-ink-disabled";
const menuLabelClass = "px-2 pt-2 pb-1 text-caption text-ink-secondary";
const nobodyHint = "Bots answer only when you @mention them";

function StatusChip({ chat, bot }: { chat: ChatState; bot: Bot }) {
  const run = chat.runs.find(({ botId }) => botId === bot.id);
  if (waitingOnOwner(chat, bot.id)) {
    return (
      <span className="flex h-[22px] shrink-0 items-center gap-1 rounded-full bg-waiting-surface px-2 text-label text-waiting">
        <CircleAlert {...iconProps} size={12} className="text-waiting-status" />
        Waiting on you
      </span>
    );
  }
  const [Icon, label, tone] =
    bot.status === "paused"
      ? [CirclePause, "Paused", "text-neutral-status"]
      : isActive(run)
        ? [LoaderCircle, "Working", "text-success-status"]
        : run
          ? [CircleCheck, "Done", "text-success-status"]
          : [];
  if (!Icon) {
    return null;
  }
  return (
    <span className="flex h-[22px] shrink-0 items-center gap-1 text-label text-ink-secondary">
      <Icon {...iconProps} size={12} className={tone} />
      {label}
    </span>
  );
}

function hide(target: HTMLElement) {
  target.closest<HTMLElement>("[popover]")?.hidePopover();
}

function DefaultAnswerer({
  room,
  members,
  connected,
}: {
  room: Room;
  members: Bot[];
  connected: boolean;
}) {
  const current = members.find(({ id }) => id === room.defaultBotId);
  const pick = (defaultBotId: string | null) =>
    void sendCommand({ type: "update-room", roomId: room.id, defaultBotId });
  return (
    <>
      <button
        type="button"
        popoverTarget="room-default-menu"
        className="button button-sm min-w-0 shrink [anchor-name:--room-default-menu]"
      >
        <span className="truncate">
          {current ? `${current.name} answers by default` : "Nobody answers by default"}
        </span>
        <ChevronDown {...iconProps} />
      </button>
      <div
        id="room-default-menu"
        popover="auto"
        className="menu m-0 mt-1 w-72 p-1 [position-anchor:--room-default-menu] [position-area:bottom_span-right]"
      >
        <p className={menuLabelClass}>Answers when nobody is @mentioned</p>
        <button
          type="button"
          className={`${menuItemClass} h-auto`}
          disabled={!connected}
          onClick={({ currentTarget }) => {
            pick(null);
            hide(currentTarget);
          }}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            Nobody, ask me
            <span className="text-caption text-ink-secondary">{nobodyHint}</span>
          </span>
          {!current && <Check {...iconProps} className="text-brand-icon" />}
        </button>
        {members.map((bot) => (
          <button
            key={bot.id}
            type="button"
            className={menuItemClass}
            disabled={!connected}
            onClick={({ currentTarget }) => {
              pick(bot.id);
              hide(currentTarget);
            }}
          >
            <Avatar seed={bot.avatarSeed} className="size-5" />
            <span className="min-w-0 flex-1 truncate">{bot.name}</span>
            {bot === current && <Check {...iconProps} className="text-brand-icon" />}
          </button>
        ))}
      </div>
    </>
  );
}

function MembersMenu({
  room,
  members,
  others,
  chat,
  connected,
  adding,
  setAdding,
}: {
  room: Room;
  members: Bot[];
  others: Bot[];
  chat: ChatState;
  connected: boolean;
  adding: boolean;
  setAdding: (adding: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip label="Room members" side="bottom">
        <button
          type="button"
          aria-label="Room members"
          aria-expanded={open}
          popoverTarget="room-menu"
          className="button button-icon [anchor-name:--room-menu] aria-expanded:bg-brand-surface aria-expanded:text-brand-icon"
        >
          <Users {...iconProps} />
        </button>
      </Tooltip>
      <div
        id="room-menu"
        popover="auto"
        className="menu m-0 mt-1 hidden w-[min(360px,calc(100vw-16px))] flex-col gap-0.5 p-1 [position-anchor:--room-menu] [position-area:bottom_span-left] open:flex"
        onToggle={(event) => {
          const opened = event.newState === "open";
          setOpen(opened);
          if (!opened) {
            setAdding(false);
          }
        }}
      >
        {adding ? (
          <>
            <p className="px-2 pt-1.5 pb-1 text-label font-medium">Add to this room</p>
            {others.length === 0 && (
              <p className="px-2 pb-2 text-caption text-ink-secondary">
                Every bot is already here.
              </p>
            )}
            {others.map((bot) => (
              <button
                key={bot.id}
                type="button"
                className={`${menuItemClass} h-9`}
                disabled={!connected}
                onClick={() =>
                  void sendCommand({ type: "add-room-member", roomId: room.id, botId: bot.id })
                }
              >
                <Avatar seed={bot.avatarSeed} className="size-5" />
                <span className="min-w-0 flex-1 truncate font-medium">{bot.name}</span>
                <StatusChip chat={chat} bot={bot} />
              </button>
            ))}
          </>
        ) : (
          <>
            <p className="flex items-baseline gap-1.5 px-2 pt-1.5 pb-1">
              <span className="text-label font-medium">Room members</span>
              <span className="text-caption text-ink-secondary">{members.length}</span>
            </p>
            {members.map((bot) => (
              <div
                key={bot.id}
                className="flex min-h-9 items-center gap-2 rounded-row px-2 py-1 hover:bg-hover"
              >
                <Avatar seed={bot.avatarSeed} className="size-5" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body-s font-medium">{bot.name}</span>
                  {bot.id === room.defaultBotId && (
                    <span className="truncate text-caption text-ink-secondary">
                      Answers by default
                    </span>
                  )}
                </span>
                <StatusChip chat={chat} bot={bot} />
                <button
                  type="button"
                  aria-label={`Remove ${bot.name}`}
                  className="button button-sm"
                  disabled={!connected}
                  onClick={() =>
                    void sendCommand({
                      type: "remove-room-member",
                      roomId: room.id,
                      botId: bot.id,
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button button-sm self-start"
              disabled={!connected || others.length === 0}
              onClick={() => setAdding(true)}
            >
              <Plus {...iconProps} />
              Add bot
            </button>
            <hr className="border-edge-subtle" />
            <label className="flex flex-col gap-1 px-2 pt-1 pb-2">
              <span className="field-label">Answers when nobody is @mentioned</span>
              <select
                className="field"
                disabled={!connected}
                value={room.defaultBotId ?? ""}
                onChange={(event) =>
                  void sendCommand({
                    type: "update-room",
                    roomId: room.id,
                    defaultBotId: event.target.value || null,
                  })
                }
              >
                <option value="">Nobody, ask me</option>
                {members.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
    </>
  );
}

function RoomOptions({ room, bots, connected }: { room: Room; bots: Bot[]; connected: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <>
      <Tooltip label="Room options" side="bottom">
        <button
          type="button"
          aria-label="Room options"
          popoverTarget="room-options"
          className="button button-icon [anchor-name:--room-options]"
        >
          <Ellipsis {...iconProps} />
        </button>
      </Tooltip>
      <div
        id="room-options"
        popover="auto"
        className="menu m-0 mt-1 w-48 p-1 [position-anchor:--room-options] [position-area:bottom_span-left]"
      >
        <button
          type="button"
          className={menuItemClass}
          disabled={!connected}
          onClick={({ currentTarget }) => {
            hide(currentTarget);
            setRenaming(true);
          }}
        >
          <Pencil {...iconProps} className="text-ink-secondary" />
          Rename
        </button>
        <button
          type="button"
          className={menuItemClass}
          disabled={!connected}
          onClick={({ currentTarget }) => {
            hide(currentTarget);
            setEditing(true);
          }}
        >
          <Settings {...iconProps} className="text-ink-secondary" />
          Settings
        </button>
      </div>
      {renaming && <RenameRoomDialog room={room} onClose={() => setRenaming(false)} />}
      {editing && <RoomSettingsDialog room={room} bots={bots} onClose={() => setEditing(false)} />}
    </>
  );
}

function RoomComposer({
  room,
  members,
  canSend,
  chat,
}: {
  room: Room;
  members: Bot[];
  canSend: boolean;
  chat: ChatState;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const [text, setText] = useState("");
  const [messageId, setMessageId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string>();
  const mentions = useMentionMenu(text, setText, members, box, {
    room: true,
    renderStatus: (bot) => <StatusChip chat={chat} bot={bot} />,
  });
  const name = room.name ?? "the room";
  const files = useAttachments(room.id);
  const ready = (text.trim() !== "" || files.ids.length > 0) && !files.uploading;
  const empty = members.length === 0;

  async function send() {
    const body = text;
    if (sending.current || !canSend || !ready) {
      return;
    }
    sending.current = true;
    requestNotifications();
    setError(undefined);
    setText("");
    const result = await postCommand({
      type: "send-message",
      messageId,
      roomId: room.id,
      body,
      ...(files.ids.length > 0 && { attachmentIds: files.ids }),
    });
    sending.current = false;
    if (result.ok) {
      files.clear();
      setMessageId(crypto.randomUUID());
    } else {
      setText((current) => current || body);
      setError(`Not sent. ${result.message}`);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (composing || mentions.onKeyDown(event)) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="pb-4">
      {error && (
        <p role="alert" className="mb-2 text-label text-danger">
          {error}
        </p>
      )}
      <form
        className="relative flex flex-col gap-1 rounded-composer border border-edge-strong bg-card p-2 shadow-composer transition-[border-color,box-shadow] has-[textarea:disabled]:border-edge-subtle has-[textarea:disabled]:bg-disabled has-[textarea:focus-visible]:border-focus has-[textarea:focus-visible]:ring-1 has-[textarea:focus-visible]:ring-focus"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        onDrop={files.onDrop}
        onDragOver={files.onDragOver}
      >
        <UploadChips uploads={files.uploads} onRemove={files.remove} />
        {mentions.menu}
        <textarea
          ref={box}
          data-composer
          autoFocus
          disabled={empty}
          className="max-h-40 min-h-12 resize-none bg-transparent px-2 py-1 text-body field-sizing-content outline-none placeholder:text-ink-faint disabled:placeholder:text-ink-disabled"
          aria-label={`Message ${name}`}
          {...mentions.textBoxProps}
          placeholder={
            empty
              ? "Add a bot to this room to send a message"
              : "Message the room · @ to mention a bot"
          }
          rows={1}
          value={text}
          onChange={({ target }) => {
            setText(target.value);
            mentions.onCaret(target, true);
            setMessageId(crypto.randomUUID());
          }}
          onSelect={({ currentTarget }) => mentions.onCaret(currentTarget, false)}
          onKeyDown={onKeyDown}
          onPaste={files.onPaste}
        />
        <div className="flex items-center gap-1">
          <AttachButton disabled={!canSend} onFiles={files.add} />
          <span className="flex-1" />
          <button
            type="submit"
            aria-label="Send"
            className="icon-send"
            disabled={!canSend || !ready}
          >
            <ArrowUp {...iconProps} />
          </button>
        </div>
      </form>
    </div>
  );
}

const nameList = new Intl.ListFormat("en-GB", { type: "conjunction" });

export function RoomView({
  room,
  connection,
  onOpenDrawer,
}: {
  room: Room;
  connection: ConnectionState;
  onOpenDrawer: () => void;
}) {
  const { chat, status, commandError } = connection;
  const [adding, setAdding] = useState(false);
  const connected = status === "connected";
  const members = room.members.flatMap((id) => chat.bots.filter((bot) => bot.id === id));
  const others = chat.bots.filter(
    ({ id, archivedAt }) => !archivedAt && !room.members.includes(id),
  );
  const messages = chat.messages.filter(({ roomId }) => roomId === room.id);
  const items = buildTranscript(messages, [], [], []);
  const busy = members.filter(({ id }) => isActive(chat.runs.find(({ botId }) => botId === id)));
  const systemLine = busy.length > 0 ? `${busy.map(({ name }) => name).join(", ")} working…` : "";
  const authorName = (botId: string) => chat.bots.find(({ id }) => id === botId)?.name;
  const notices = [status !== "connected" && connectionLines[status], commandError].filter(
    (line) => typeof line === "string",
  );
  const defaultBot = members.find(({ id }) => id === room.defaultBotId);
  const here = `${nameList.format(members.map(({ name }) => name))} ${members.length === 1 ? "is" : "are"} here.`;
  const noBots = members.length === 0;
  const held =
    room.held === "ring"
      ? `Bots were going in circles, so they're paused until ${room.heldUntil ? shortTime(room.heldUntil) : "later"}.`
      : room.held === "escalation" &&
        "The bots are waiting for you. Post a message to let them go on.";
  const emptyState = (title: string, body: string) => (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <span className="mb-2 flex size-10 items-center justify-center rounded-full bg-raised text-ink-secondary">
        <Users {...iconProps} />
      </span>
      <p className={items.length === 0 ? "text-title font-semibold" : "text-title-s font-semibold"}>
        {title}
      </p>
      <p className="text-body-s text-ink-secondary">{body}</p>
      {noBots && (
        <button
          type="button"
          popoverTarget="room-menu"
          className="button button-sm button-primary mt-2"
          disabled={!connected || others.length === 0}
          onClick={() => setAdding(true)}
        >
          <Plus {...iconProps} />
          Add bot
        </button>
      )}
    </div>
  );
  const noBotsState = emptyState(
    "No bots in this room",
    items.length === 0
      ? "Add a bot to start talking here."
      : "Add a bot to start talking here. The history stays.",
  );

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label={`Room ${room.name ?? ""}`}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge-subtle pr-4 pl-6 max-md:pl-2">
        <Tooltip label="Open bot list" side="bottom" className="inline-flex md:hidden">
          <button
            type="button"
            aria-label="Open bot list"
            className="button button-icon"
            onClick={onOpenDrawer}
          >
            <PanelLeft {...iconProps} />
          </button>
        </Tooltip>
        <h2 className="truncate text-title-s font-semibold">{room.name}</h2>
        <span className="flex shrink-0 -space-x-1">
          {members.map((bot) => (
            <Avatar key={bot.id} seed={bot.avatarSeed} className="size-5" />
          ))}
        </span>
        {members.length > 0 && (
          <DefaultAnswerer room={room} members={members} connected={connected} />
        )}
        <span className="flex-1" />
        <MembersMenu
          room={room}
          members={members}
          others={others}
          chat={chat}
          connected={connected}
          adding={adding}
          setAdding={setAdding}
        />
        <RoomOptions room={room} bots={chat.bots} connected={connected} />
      </header>
      {held && (
        <div className={columnClass}>
          <p
            role="status"
            className="mt-3 flex items-center gap-2 rounded-row bg-waiting-surface px-3 py-2 text-body-s text-waiting"
          >
            <CircleAlert {...iconProps} className="shrink-0 text-waiting-status" />
            {held}
          </p>
        </div>
      )}
      {items.length === 0 && !systemLine ? (
        <div className={`${columnClass} flex flex-1 flex-col justify-center`}>
          {noBots
            ? noBotsState
            : emptyState(
                room.name ?? "",
                `${here} @mention a bot to ask it${defaultBot ? `, or ${defaultBot.name} answers.` : "."}`,
              )}
        </div>
      ) : (
        <Transcript
          bot={{ name: room.name ?? "" }}
          items={items}
          connected={connected}
          draft={undefined}
          liveTools={[]}
          workingSince={undefined}
          endedWork={undefined}
          thought={undefined}
          systemLine={systemLine}
          onContinue={undefined}
          authorName={authorName}
        />
      )}
      <div className={columnClass}>
        {noBots && items.length > 0 && noBotsState}
        <div role="status">
          {notices.map((notice) => (
            <p key={notice} className="mb-2 text-label text-ink-secondary">
              {notice}
            </p>
          ))}
        </div>
        <RoomComposer
          key={room.id}
          room={room}
          members={members.filter(({ archivedAt }) => !archivedAt)}
          canSend={connected && members.length > 0}
          chat={chat}
        />
      </div>
    </section>
  );
}
