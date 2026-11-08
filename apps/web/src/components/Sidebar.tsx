import type { Bot, Room } from "@beebot/contracts";
import { Gauge, Hexagon, Plus, ScrollText, ShieldOff, Users } from "lucide-react";
import { useEffect, useRef } from "react";

import { connectionLines, engineFix, shortTime } from "../labels";
import { type ConnectionState, isActive, openCards } from "../serverConnection";
import { Avatar } from "./Avatar";
import { iconProps } from "./ui";

function statusLine({ status, engine }: ConnectionState) {
  if (status !== "connected") {
    return connectionLines[status];
  }
  if (!engine) {
    return "Connected";
  }
  return engineFix(engine)?.label ?? "Claude ready";
}

function BotRow({
  bot,
  connection,
  selected,
  onSelect,
}: {
  bot: Bot;
  connection: ConnectionState;
  selected: boolean;
  onSelect: () => void;
}) {
  const { chat, lastSeen } = connection;
  const messages = chat.messages.filter(({ roomId }) => roomId === bot.roomId);
  const last = messages.at(-1);
  const lastBotMessage = messages.findLast(({ author }) => author === "bot");
  const waiting =
    chat.approvals.some(({ botId, status }) => botId === bot.id && status === "pending") ||
    openCards(chat, bot.id).length > 0;
  const unread = !selected && lastBotMessage && lastBotMessage.id !== lastSeen[bot.id];
  const working = isActive(chat.runs.find(({ botId }) => botId === bot.id));

  let line = last?.body.replace(/[`*_~]|^[#>\s]+/gm, "").trim() || "No messages yet";
  if (waiting) {
    line = "Waiting on you";
  } else if (bot.status === "paused") {
    line = "Paused";
  } else if (working) {
    line = "Working…";
  }

  return (
    <button
      type="button"
      aria-current={selected}
      className="flex w-full items-center gap-2.5 rounded-row px-2 py-1.5 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2 aria-[current=true]:bg-raised"
      onClick={onSelect}
    >
      <Avatar seed={bot.avatarSeed} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-name font-medium">{bot.name}</span>
          {bot.access === "full" && (
            <span className="self-center text-danger">
              <ShieldOff {...iconProps} size={12} />
              <span className="sr-only">Full access</span>
            </span>
          )}
          <span className="flex-1" />
          {last && (
            <span className="shrink-0 text-label text-ink-faint tabular-nums">
              {shortTime(last.createdAt)}
            </span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className="truncate text-small text-ink-secondary">{line}</span>
          <span className="flex-1" />
          {(waiting || unread) && (
            <span className="size-2 shrink-0 rounded-full bg-honey">
              <span className="sr-only">{waiting ? "Needs you" : "Unread"}</span>
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

const rowClass =
  "flex w-full items-center gap-2.5 rounded-row px-2 py-1.5 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2 aria-[current=true]:bg-raised";

function RoomRow({
  room,
  connection,
  selected,
  onSelect,
}: {
  room: Room;
  connection: ConnectionState;
  selected: boolean;
  onSelect: () => void;
}) {
  const last = connection.chat.messages.findLast(({ roomId }) => roomId === room.id);
  const line = last?.body.replace(/[`*_~]|^[#>\s]+/gm, "").trim() || `${room.members.length} bots`;
  return (
    <button type="button" aria-current={selected} className={rowClass} onClick={onSelect}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary">
        <Users {...iconProps} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-name font-medium">{room.name}</span>
        <span className="block truncate text-small text-ink-secondary">{line}</span>
      </span>
    </button>
  );
}

export function Sidebar({
  connection,
  selectedId,
  selectedRoomId,
  usageOpen,
  auditOpen,
  open,
  onSelect,
  onSelectRoom,
  onUsage,
  onAudit,
  onNewBot,
  onNewRoom,
  onClose,
}: {
  connection: ConnectionState;
  selectedId: string | undefined;
  selectedRoomId: string | undefined;
  usageOpen: boolean;
  auditOpen: boolean;
  open: boolean;
  onSelect: (botId: string) => void;
  onSelectRoom: (roomId: string) => void;
  onUsage: () => void;
  onAudit: () => void;
  onNewBot: () => void;
  onNewRoom: () => void;
  onClose: () => void;
}) {
  const rooms = connection.chat.rooms.filter(({ kind }) => kind === "group");
  const drawer = useRef<HTMLElement>(null);

  // The drawer sits outside the page's tab order until it opens, so focus has to move into it.
  useEffect(() => {
    if (open) {
      drawer.current?.querySelector("button")?.focus();
    }
  }, [open]);

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close bot list"
          className="fixed inset-0 z-10 bg-scrim md:hidden"
          onClick={onClose}
        />
      )}
      <aside
        ref={drawer}
        onKeyDown={({ key }) => {
          if (key === "Escape") {
            onClose();
            document.querySelector<HTMLElement>("[data-composer]")?.focus();
          }
        }}
        className={`fixed inset-y-0 left-0 z-20 flex w-[264px] shrink-0 flex-col border-r border-edge bg-sidebar px-2 md:visible md:static md:translate-x-0 ${
          // Visibility animates only on close: an opening drawer must be focusable at once.
          open
            ? "translate-x-0 transition-transform"
            : "invisible -translate-x-full transition-[translate,visibility]"
        }`}
      >
        <div className="flex h-[52px] shrink-0 items-center justify-between pl-2">
          <h1 className="flex items-center gap-2 text-name font-semibold">
            <Hexagon {...iconProps} className="text-honey" fill="currentColor" />
            Bee Bot
          </h1>
          <button type="button" aria-label="New bot" className="button !px-2" onClick={onNewBot}>
            <Plus {...iconProps} />
          </button>
        </div>
        <nav aria-label="Bots" className="min-h-0 flex-1 overflow-y-auto">
          <ul className="flex flex-col gap-0.5">
            {connection.chat.bots.map((bot) => (
              <li key={bot.id}>
                <BotRow
                  bot={bot}
                  connection={connection}
                  selected={bot.id === selectedId}
                  onSelect={() => onSelect(bot.id)}
                />
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between pl-2">
            <h2 className="text-label text-ink-faint">Rooms</h2>
            <button
              type="button"
              aria-label="New room"
              className="button !px-2"
              disabled={connection.chat.bots.length === 0}
              onClick={onNewRoom}
            >
              <Plus {...iconProps} />
            </button>
          </div>
          <ul className="flex flex-col gap-0.5">
            {rooms.map((room) => (
              <li key={room.id}>
                <RoomRow
                  room={room}
                  connection={connection}
                  selected={room.id === selectedRoomId}
                  onSelect={() => onSelectRoom(room.id)}
                />
              </li>
            ))}
          </ul>
        </nav>
        <button
          type="button"
          aria-current={usageOpen}
          className="mb-1 flex w-full items-center gap-2 rounded-row px-2 py-1.5 text-left text-small text-ink-secondary transition-colors hover:bg-hover focus-visible:-outline-offset-2 aria-[current=true]:bg-raised aria-[current=true]:text-ink"
          onClick={onUsage}
        >
          <Gauge {...iconProps} />
          Usage
        </button>
        <button
          type="button"
          aria-current={auditOpen}
          className="mb-1 flex w-full items-center gap-2 rounded-row px-2 py-1.5 text-left text-small text-ink-secondary transition-colors hover:bg-hover focus-visible:-outline-offset-2 aria-[current=true]:bg-raised aria-[current=true]:text-ink"
          onClick={onAudit}
        >
          <ScrollText {...iconProps} />
          Audit
        </button>
        <p
          role="status"
          data-status={connection.status}
          className="border-t border-edge px-2 py-2.5 text-label text-ink-faint"
        >
          {statusLine(connection)}
        </p>
      </aside>
    </>
  );
}
