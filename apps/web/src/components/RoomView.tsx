import type { Bot, Room } from "@beebot/contracts";
import { ArrowUp, PanelLeft, Users } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { connectionLines } from "../labels";
import { insertMention, mentionAt, mentionMatches } from "../mentions";
import {
  type ConnectionState,
  isActive,
  postCommand,
  requestNotifications,
  sendCommand,
} from "../serverConnection";
import { buildTranscript } from "../transcript";
import { Avatar } from "./Avatar";
import { Transcript } from "./Transcript";
import { columnClass, iconProps } from "./ui";

const menuItemClass =
  "rounded-field px-2 py-1 text-small transition-colors hover:bg-hover disabled:text-ink-faint";

function MembersMenu({
  room,
  members,
  others,
  connected,
}: {
  room: Room;
  members: Bot[];
  others: Bot[];
  connected: boolean;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Room members"
        popoverTarget="room-menu"
        className="button !px-2 [anchor-name:--room-menu]"
      >
        <Users {...iconProps} />
        {members.length}
      </button>
      <div
        id="room-menu"
        popover="auto"
        className="menu m-0 mt-1 w-64 p-2 [position-anchor:--room-menu] [position-area:bottom_span-left]"
      >
        <ul className="flex flex-col gap-0.5">
          {members.map((bot) => (
            <li key={bot.id} className="flex items-center gap-2">
              <Avatar seed={bot.avatarSeed} className="size-5" />
              <span className="min-w-0 flex-1 truncate text-small">{bot.name}</span>
              <button
                type="button"
                className={menuItemClass}
                disabled={!connected}
                onClick={() =>
                  void sendCommand({ type: "remove-room-member", roomId: room.id, botId: bot.id })
                }
              >
                Remove
              </button>
            </li>
          ))}
          {others.map((bot) => (
            <li key={bot.id} className="flex items-center gap-2 text-ink-secondary">
              <Avatar seed={bot.avatarSeed} className="size-5 opacity-60" />
              <span className="min-w-0 flex-1 truncate text-small">{bot.name}</span>
              <button
                type="button"
                className={menuItemClass}
                disabled={!connected}
                onClick={() =>
                  void sendCommand({ type: "add-room-member", roomId: room.id, botId: bot.id })
                }
              >
                Add
              </button>
            </li>
          ))}
        </ul>
        <label className="mt-2 flex flex-col gap-1 border-t border-edge pt-2 text-label text-ink-secondary">
          Answers when no bot is mentioned
          <select
            className="field text-ink"
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
      </div>
    </>
  );
}

function RoomComposer({
  room,
  members,
  canSend,
}: {
  room: Room;
  members: Bot[];
  canSend: boolean;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  // The start of a mention the owner closed the picker on, so it stays closed while they type.
  const [dismissed, setDismissed] = useState<number>();
  const [messageId, setMessageId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string>();
  const mention = mentionAt(text, caret);
  const matches =
    mention && mention.start !== dismissed ? mentionMatches(members, mention.query) : [];
  const highlighted = matches[Math.min(highlight, matches.length - 1)];
  const name = room.name ?? "the room";

  function pick(bot: Bot) {
    if (!mention) {
      return;
    }
    const next = insertMention(text, caret, mention.start, bot.name);
    flushSync(() => {
      setText(next.text);
      setCaret(next.caret);
      setHighlight(0);
    });
    box.current?.focus();
    box.current?.setSelectionRange(next.caret, next.caret);
  }

  async function send() {
    const body = text;
    if (sending.current || !canSend || !body.trim()) {
      return;
    }
    sending.current = true;
    requestNotifications();
    setError(undefined);
    setText("");
    const result = await postCommand({ type: "send-message", messageId, roomId: room.id, body });
    sending.current = false;
    if (result.ok) {
      setMessageId(crypto.randomUUID());
    } else {
      setText((current) => current || body);
      setError(`Not sent. ${result.message}`);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (composing) {
      return;
    }
    if (highlighted && mention) {
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step) {
        event.preventDefault();
        setHighlight((matches.indexOf(highlighted) + step + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(highlighted);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(mention.start);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="pb-4">
      {error && (
        <p role="alert" className="mb-2 text-small text-ink-secondary">
          {error}
        </p>
      )}
      <form
        className="relative flex items-end gap-1 rounded-composer border border-edge bg-card/80 p-1.5 shadow-composer backdrop-blur-md transition-[border-color] has-[textarea:focus-visible]:border-edge-strong"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {highlighted && (
          <ul
            id="mention-list"
            role="listbox"
            aria-label="Bots in this room"
            className="menu absolute bottom-full left-0 mb-1 w-56 p-1"
          >
            {matches.map((bot) => (
              <li
                key={bot.id}
                id={`mention-${bot.id}`}
                role="option"
                aria-selected={bot === highlighted}
                className="flex cursor-default items-center gap-2 rounded-field px-2 py-1 text-small aria-selected:bg-hover"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(bot)}
              >
                <Avatar seed={bot.avatarSeed} className="size-5" />
                {bot.name}
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={box}
          data-composer
          autoFocus
          className="max-h-40 min-h-8 flex-1 resize-none bg-transparent px-2.5 py-1 field-sizing-content outline-none"
          aria-label={`Message ${name}`}
          aria-autocomplete="list"
          aria-controls={highlighted ? "mention-list" : undefined}
          aria-activedescendant={highlighted ? `mention-${highlighted.id}` : undefined}
          placeholder="Message the room, @ to mention a bot"
          rows={1}
          value={text}
          onChange={({ target }) => {
            setText(target.value);
            setCaret(target.selectionStart);
            setHighlight(0);
            setMessageId(crypto.randomUUID());
          }}
          onSelect={({ currentTarget }) => setCaret(currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          aria-label="Send"
          className="icon-send"
          disabled={!canSend || !text.trim()}
        >
          <ArrowUp {...iconProps} />
        </button>
      </form>
    </div>
  );
}

export function RoomView({
  room,
  connection,
  onOpenDrawer,
}: {
  room: Room;
  connection: ConnectionState;
  onOpenDrawer: () => void;
}) {
  const { chat, status, finishedTools, commandError } = connection;
  const connected = status === "connected";
  const members = room.members.flatMap((id) => chat.bots.filter((bot) => bot.id === id));
  const others = chat.bots.filter(({ id }) => !room.members.includes(id));
  const messages = chat.messages.filter(({ roomId }) => roomId === room.id);
  const items = buildTranscript(messages, [], [], []);
  const busy = members.filter(({ id }) => isActive(chat.runs.find(({ botId }) => botId === id)));
  const systemLine = busy.length > 0 ? `${busy.map(({ name }) => name).join(", ")} working…` : "";
  const authorName = (botId: string) => chat.bots.find(({ id }) => id === botId)?.name;
  const notices = [status !== "connected" && connectionLines[status], commandError].filter(
    (line) => typeof line === "string",
  );

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label={`Room ${room.name ?? ""}`}>
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-edge px-3">
        <button
          type="button"
          aria-label="Open bot list"
          className="button !px-2 md:hidden"
          onClick={onOpenDrawer}
        >
          <PanelLeft {...iconProps} />
        </button>
        <h2 className="truncate text-name font-medium">{room.name}</h2>
        <span className="flex -space-x-1.5">
          {members.map((bot) => (
            <Avatar key={bot.id} seed={bot.avatarSeed} className="size-6" />
          ))}
        </span>
        <span className="flex-1" />
        <MembersMenu room={room} members={members} others={others} connected={connected} />
      </header>
      {items.length === 0 && !systemLine ? (
        <div className={`${columnClass} flex flex-1 flex-col justify-center gap-1 text-center`}>
          <p className="text-empty">{room.name}</p>
          <p className="text-small text-ink-secondary">Mention a bot with @ to ask it.</p>
        </div>
      ) : (
        <Transcript
          bot={{ name: room.name ?? "" }}
          items={items}
          connected={connected}
          finishedTools={finishedTools}
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
        <div role="status">
          {notices.map((notice) => (
            <p key={notice} className="mb-2 text-small text-ink-secondary">
              {notice}
            </p>
          ))}
        </div>
        <RoomComposer
          key={room.id}
          room={room}
          members={members}
          canSend={connected && members.length > 0}
        />
      </div>
    </section>
  );
}
