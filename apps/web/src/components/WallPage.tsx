import type { Bot } from "@beebot/contracts";
import { Monitor, PanelLeft } from "lucide-react";
import { useEffect } from "react";

import { toolRowLabel } from "../labels";
import { type ConnectionState, hasBoxScreen, waitingOnOwner, watchWall } from "../serverConnection";
import { ActivityOverlay } from "./ActivityOverlay";
import { iconProps } from "./ui";

function tileStatus(bot: Bot, { chat }: ConnectionState) {
  const run = chat.runs.find(({ botId }) => botId === bot.id);
  if (bot.pauseReason === "browser_session" || waitingOnOwner(chat, bot.id)) {
    return "Waiting for you";
  }
  if (run?.status === "Running") {
    return "Working";
  }
  if (run?.status === "Queued") {
    return "Queued";
  }
  return chat.boxes.some(({ botId, state }) => botId === bot.id && state === "running")
    ? "Idle"
    : "Stopped";
}

export function WallTile({
  bot,
  connection,
  onOpen,
}: {
  bot: Bot;
  connection: ConnectionState;
  onOpen: () => void;
}) {
  const status = tileStatus(bot, connection);
  const run = connection.chat.runs.find(({ botId }) => botId === bot.id);
  const tool = run && connection.liveTools[run.id]?.findLast((t) => t.status === "running");
  const thumbnail = connection.thumbnails[bot.id];
  const controller = connection.held.includes(bot.id)
    ? "You have control"
    : `${bot.name} has control`;
  return (
    <li>
      <button
        type="button"
        aria-label={`Open ${bot.name}'s computer`}
        className="flex w-full flex-col gap-2 rounded-md p-2 text-left transition-colors hover:bg-hover"
        onClick={onOpen}
      >
        <span className="relative block aspect-[16/10] overflow-hidden rounded-md border border-edge bg-raised">
          {thumbnail ? (
            <img
              alt=""
              src={`data:image/jpeg;base64,${thumbnail}`}
              className={`size-full object-cover ${status === "Stopped" ? "opacity-50" : ""}`}
            />
          ) : (
            <span className="flex size-full items-center justify-center text-ink-faint">
              <Monitor {...iconProps} />
            </span>
          )}
          <ActivityOverlay activity={connection.activity[bot.id]} />
        </span>
        <span className="flex items-baseline gap-2">
          <span className="truncate text-name font-medium">{bot.name}</span>
          <span className="flex-1" />
          <span className="shrink-0 text-label text-ink-secondary">{status}</span>
        </span>
        <span className="truncate text-small text-ink-secondary">
          {status === "Stopped" ? "Computer off" : controller}
        </span>
        {tool && <span className="truncate text-small text-ink">{toolRowLabel(tool)}</span>}
      </button>
    </li>
  );
}

export function WallPage({
  connection,
  onOpenDrawer,
  onOpen,
}: {
  connection: ConnectionState;
  onOpenDrawer: () => void;
  onOpen: (botId: string) => void;
}) {
  const bots = connection.chat.bots.filter(
    (bot) => !bot.archivedAt && hasBoxScreen(bot, connection.boxAvailability),
  );

  useEffect(() => watchWall(), []);

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Computers">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-edge px-3">
        <button
          type="button"
          aria-label="Open bot list"
          className="button !px-2 md:hidden"
          onClick={onOpenDrawer}
        >
          <PanelLeft {...iconProps} />
        </button>
        <h2 className="text-name font-medium">Computers</h2>
      </header>
      <div className="scroller min-h-0 flex-1 overflow-y-auto">
        {bots.length === 0 ? (
          <p className="px-4 py-6 text-small text-ink-secondary">
            {connection.boxAvailability?.available
              ? "No bot has its own computer or browser yet. Choose one in a bot's settings."
              : "Computers run in boxes, which aren't set up. Set them up on the Usage page."}
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2 p-3">
            {bots.map((bot) => (
              <WallTile
                key={bot.id}
                bot={bot}
                connection={connection}
                onOpen={() => onOpen(bot.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
