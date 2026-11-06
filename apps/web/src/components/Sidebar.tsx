import type { Bot } from "@beebot/contracts";
import { Plus } from "lucide-react";
import { useEffect, useRef } from "react";

import { connectionLines, engineFix, shortTime } from "../labels";
import { type ConnectionState, isActive } from "../serverConnection";
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
  const waiting = chat.approvals.some(
    ({ botId, status }) => botId === bot.id && status === "pending",
  );
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
      className="flex w-full items-center gap-2.5 rounded-row p-2 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2 aria-[current=true]:bg-raised"
      onClick={onSelect}
    >
      <Avatar bot={bot} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-name font-medium">{bot.name}</span>
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

export function Sidebar({
  connection,
  selectedId,
  open,
  onSelect,
  onNewBot,
  onClose,
}: {
  connection: ConnectionState;
  selectedId: string | undefined;
  open: boolean;
  onSelect: (botId: string) => void;
  onNewBot: () => void;
  onClose: () => void;
}) {
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
        className={`fixed inset-y-0 left-0 z-20 flex w-[280px] shrink-0 flex-col bg-sidebar p-2 md:visible md:static md:translate-x-0 ${
          // Visibility animates only on close: an opening drawer must be focusable at once.
          open
            ? "translate-x-0 transition-transform"
            : "invisible -translate-x-full transition-[translate,visibility]"
        }`}
      >
        <div className="flex h-8 items-center justify-between pl-2">
          <h1 className="text-name font-semibold">Bee Bot</h1>
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
        </nav>
        <p
          role="status"
          data-status={connection.status}
          className="px-2 pt-2 pb-1 text-label text-ink-faint"
        >
          {statusLine(connection)}
        </p>
      </aside>
    </>
  );
}
