import type { Bot } from "@beebot/contracts";
import {
  AppWindow,
  Circle,
  CirclePause,
  Clock,
  LoaderCircle,
  Monitor,
  PanelLeft,
} from "lucide-react";
import { useEffect } from "react";

import { toolRowLabel } from "../labels";
import { type ConnectionState, hasBoxScreen, waitingOnOwner, watchWall } from "../serverConnection";
import { ActivityOverlay } from "./ActivityOverlay";
import { Avatar } from "./Avatar";
import { iconProps } from "./ui";

function tileStatus(bot: Bot, { chat }: ConnectionState) {
  const run = chat.runs.find(({ botId }) => botId === bot.id);
  if (bot.pauseReason === "browser_session" || waitingOnOwner(chat, bot.id)) {
    return "Waiting on you";
  }
  if (run?.status === "Running") {
    return "Working";
  }
  if (run?.status === "Queued") {
    return "Queued";
  }
  return chat.boxes.some(({ botId, state }) => botId === bot.id && state === "running")
    ? "Idle"
    : "Paused";
}

function StatusIcon({ status }: { status: ReturnType<typeof tileStatus> }) {
  const props = { ...iconProps, size: 12, className: "shrink-0" };
  switch (status) {
    case "Waiting on you":
      return <Clock {...props} />;
    case "Working":
      return <LoaderCircle {...props} className="shrink-0 text-success-status" />;
    case "Paused":
      return <CirclePause {...props} />;
    default:
      return <Circle {...props} className="shrink-0 text-neutral-status" />;
  }
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
  const waiting = status === "Waiting on you";
  const run = connection.chat.runs.find(({ botId }) => botId === bot.id);
  const tool = run && connection.liveTools[run.id]?.findLast((t) => t.status === "running");
  const thumbnail = connection.thumbnails[bot.id];
  return (
    <li>
      <button
        type="button"
        aria-label={`Open ${bot.name}'s computer`}
        className={`flex w-full flex-col gap-3 rounded-card bg-card p-3 text-left transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus ${waiting ? "border border-waiting-edge" : "border border-edge-subtle"}`}
        onClick={onOpen}
      >
        <span className="relative block aspect-[248/155] overflow-hidden rounded-field border border-edge-subtle bg-sidebar">
          {thumbnail ? (
            <img
              alt=""
              src={`data:image/jpeg;base64,${thumbnail}`}
              className={`size-full object-cover ${status === "Paused" ? "opacity-50" : ""}`}
            />
          ) : (
            <span className="flex size-full items-center justify-center text-icon-muted">
              <Monitor {...iconProps} size={24} />
            </span>
          )}
          <ActivityOverlay activity={connection.activity[bot.id]} />
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <Avatar seed={bot.avatarSeed} className="size-8 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-body-s text-ink">{bot.name}</span>
            <span
              className={`flex min-w-0 items-center gap-1 self-start ${waiting ? "rounded-full bg-waiting-surface px-2 text-waiting" : "text-ink-secondary"}`}
            >
              <StatusIcon status={status} />
              <span className="truncate text-label">{status}</span>
              {tool && (
                <span className="truncate text-caption">
                  · {toolRowLabel(tool, connection.chat.connectors)}
                </span>
              )}
            </span>
            <span className="truncate text-caption text-ink-secondary">
              {connection.held.includes(bot.id) ? "You have control" : `${bot.name} has control`}
            </span>
          </span>
        </span>
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
  const available = connection.boxAvailability?.available;

  useEffect(() => watchWall(), []);

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Computers">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-edge-subtle px-6 max-md:px-3">
        <button
          type="button"
          aria-label="Open bot list"
          className="button button-icon md:hidden"
          onClick={onOpenDrawer}
        >
          <PanelLeft {...iconProps} />
        </button>
        <h2 className="text-title-s font-semibold text-ink">Computers</h2>
        {bots.length > 0 && (
          <span className="truncate text-caption text-ink-secondary">
            {bots.length === 1 ? "1 computer" : `${bots.length} computers`}
          </span>
        )}
      </header>
      <div className="scroller min-h-0 flex-1 overflow-y-auto">
        {bots.length === 0 ? (
          <div className="mx-auto flex max-w-[480px] flex-col items-center gap-2 px-6 pt-30 text-center">
            <span className="mb-2 flex size-10 items-center justify-center rounded-full bg-raised text-ink-secondary">
              <AppWindow {...iconProps} />
            </span>
            <h3 className="text-title-s font-semibold text-ink">
              {available ? "No bot uses a computer yet" : "Computers aren't set up yet"}
            </h3>
            <p className="text-body-s text-ink-secondary">
              {available
                ? "No bot has its own computer or browser yet. Choose one in a bot's settings."
                : "Computers run in boxes, which aren't set up. Set them up on the Usage page."}
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,min(272px,100%))] gap-4 px-5 py-6">
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
