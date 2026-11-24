import type { Bot, ChatMessage, Room } from "@beebot/contracts";
import {
  CirclePause,
  Clock,
  Gauge,
  Inbox,
  ListTodo,
  LoaderCircle,
  type LucideIcon,
  Monitor,
  PanelLeft,
  Plus,
  ScrollText,
  ShieldAlert,
  Users,
  X,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { shortTime } from "../labels";
import { type WaitingItem, waitingItems, waitingKind } from "../needsYou";
import { readSidebarCollapsed, saveSidebarCollapsed } from "../preferences";
import { type ConnectionState, isActive, postCommand, sendCommand } from "../serverConnection";
import { Avatar } from "./Avatar";
import { BeeLogo } from "./BeeLogo";
import { SidebarFooter } from "./SidebarFooter";
import { Tooltip } from "./Tooltip";
import { iconProps } from "./ui";

const chipTones = {
  waiting: { chip: "bg-waiting-surface px-2 text-waiting", icon: "text-waiting-status" },
  working: { chip: "text-ink-secondary", icon: "text-success-status motion-safe:animate-spin" },
  paused: { chip: "text-ink-secondary", icon: "text-neutral-status" },
};

function StatusChip({
  Icon,
  label,
  detail,
  tone,
}: {
  Icon: LucideIcon;
  label: string;
  detail?: string;
  tone: keyof typeof chipTones;
}) {
  return (
    <span
      className={`flex h-[22px] max-w-full items-center gap-1 self-start rounded-full ${chipTones[tone].chip}`}
    >
      <Icon {...iconProps} size={12} className={`shrink-0 ${chipTones[tone].icon}`} />
      <span className="shrink-0 text-label font-medium">{label}</span>
      {detail && <span className="truncate text-caption">· {detail}</span>}
    </span>
  );
}

const previewLine = (message: ChatMessage | undefined) =>
  message?.body.replace(/[`*_~]|^[#>\s]+/gm, "").trim() ||
  (message?.attachments.length ? "Sent a file" : "");

// What a bot is doing, as the sidebar shows it: undefined when it's idle.
function botState(bot: Bot, waiting: WaitingItem | undefined, connection: ConnectionState) {
  if (waiting) {
    return { tone: "waiting", Icon: Clock, label: "Waiting on you" } as const;
  }
  if (bot.status === "paused") {
    return { tone: "paused", Icon: CirclePause, label: "Paused" } as const;
  }
  return isActive(connection.chat.runs.find(({ botId }) => botId === bot.id))
    ? ({ tone: "working", Icon: LoaderCircle, label: "Working" } as const)
    : undefined;
}

function BotRow({
  bot,
  connection,
  waiting,
  selected,
  onSelect,
}: {
  bot: Bot;
  connection: ConnectionState;
  waiting: WaitingItem | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const { chat, lastSeen } = connection;
  const messages = chat.messages.filter(({ roomId }) => roomId === bot.roomId);
  const last = messages.at(-1);
  const lastBotMessage = messages.findLast(({ author }) => author === "bot");
  const unread = !selected && lastBotMessage && lastBotMessage.id !== lastSeen[bot.id];
  const state = botState(bot, waiting, connection);
  const queued = chat.tasks.filter(
    ({ ownerBotId, status }) => ownerBotId === bot.id && status === "queued",
  ).length;

  return (
    <button
      type="button"
      aria-current={selected}
      className="flex min-h-11 w-full items-start gap-2 rounded-row px-2 py-1.5 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2 aria-[current=true]:bg-raised"
      onClick={onSelect}
    >
      <Avatar seed={bot.avatarSeed} tight className="size-5" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-1">
          <span className="flex-1 truncate text-body-s font-medium">{bot.name}</span>
          {queued > 0 && (
            <span className="shrink-0 text-caption text-ink-secondary">{queued} queued</span>
          )}
          {last && (
            <span className="shrink-0 text-caption text-ink-secondary tabular-nums">
              {shortTime(last.createdAt)}
            </span>
          )}
          {unread && (
            <span className="size-2 shrink-0 rounded-full bg-brand-icon">
              <span className="sr-only">Unread</span>
            </span>
          )}
          {bot.access === "full" && (
            <span className="shrink-0 text-danger-status">
              <ShieldAlert {...iconProps} size={12} />
              <span className="sr-only">Full access</span>
            </span>
          )}
        </span>
        {state ? (
          <StatusChip {...state} {...(waiting && { detail: waitingKind(waiting).toLowerCase() })} />
        ) : (
          <span className="truncate text-label text-ink-secondary">
            {previewLine(last) || "No messages yet"}
          </span>
        )}
      </span>
    </button>
  );
}

function DeleteBotDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    setDeleting(true);
    const result = await postCommand({ type: "delete-bot", botId: bot.id });
    setDeleting(false);
    if (result.ok) {
      onClose();
    } else {
      setError(result.message);
    }
  }

  return (
    <dialog
      ref={(node) => {
        if (node && !node.open) {
          node.showModal?.();
        }
      }}
      aria-label={`Delete ${bot.name}`}
      className="dialog m-auto w-[min(420px,calc(100vw-32px))] p-6 backdrop:bg-scrim"
      onCancel={onClose}
    >
      <h2 className="mb-4 text-title-s font-semibold">Delete {bot.name} for good?</h2>
      <p className="mb-4 text-body-s text-ink-secondary">
        Its chat, memory, routines, files and computer are removed and can't be brought back. What
        it said in rooms stays, marked as from a deleted bot.
      </p>
      {error && (
        <p role="alert" className="mb-4 text-body-s text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="button button-outline" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button button-danger"
          disabled={deleting}
          onClick={() => void remove()}
        >
          Delete
        </button>
      </div>
    </dialog>
  );
}

function SectionHeader({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div className="mt-2 flex h-7 shrink-0 items-center gap-2 pr-1 pl-2">
      <h2 className="flex-1 text-label font-medium text-ink-secondary">{label}</h2>
      {action}
    </div>
  );
}

function IconAction({
  label,
  Icon,
  className = "button button-icon button-sm",
  disabled,
  onClick,
}: {
  label: string;
  Icon: LucideIcon;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        className={className}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon {...iconProps} />
      </button>
    </Tooltip>
  );
}

const countClass =
  "flex h-5 min-w-5 items-center justify-center rounded-full bg-waiting-surface px-1 text-label font-medium text-waiting tabular-nums";

const emptyClass = "px-2 py-1 text-caption text-ink-secondary";

const rowClass =
  "flex h-8 w-full items-center gap-2 rounded-row px-2 text-left text-body-s transition-colors hover:bg-hover focus-visible:-outline-offset-2 aria-[current=true]:bg-raised aria-[current=true]:font-medium aria-[current=page]:bg-raised aria-[current=page]:font-medium";

function RoomRow({
  room,
  selected,
  onSelect,
}: {
  room: Room;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" aria-current={selected} className={rowClass} onClick={onSelect}>
      <Users {...iconProps} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{room.name}</span>
    </button>
  );
}

function NavItem({
  Icon,
  label,
  current,
  onClick,
}: {
  Icon: LucideIcon;
  label: string;
  current: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" aria-current={current} className={rowClass} onClick={onClick}>
      <Icon {...iconProps} className="shrink-0" />
      {label}
    </button>
  );
}

const statusDots = {
  waiting: "bg-waiting-status",
  working: "bg-success-status",
  paused: "bg-neutral-status",
};

const railButton =
  "button button-icon relative aria-[current=true]:bg-raised aria-[current=true]:text-ink aria-[current=page]:bg-raised aria-[current=page]:text-ink";

export function Sidebar({
  connection,
  selectedId,
  selectedRoomId,
  usageOpen,
  auditOpen,
  wallOpen,
  needsYouOpen,
  open,
  onSelect,
  onSelectRoom,
  onUsage,
  onAudit,
  onWall,
  onNeedsYou,
  onNewBot,
  onNewRoom,
  onClose,
}: {
  connection: ConnectionState;
  selectedId: string | undefined;
  selectedRoomId: string | undefined;
  usageOpen: boolean;
  auditOpen: boolean;
  wallOpen: boolean;
  needsYouOpen: boolean;
  open: boolean;
  onSelect: (botId: string) => void;
  onSelectRoom: (roomId: string) => void;
  onUsage: () => void;
  onAudit: () => void;
  onWall: () => void;
  onNeedsYou: () => void;
  onNewBot: () => void;
  onNewRoom: () => void;
  onClose: () => void;
}) {
  const rooms = connection.chat.rooms.filter(({ kind }) => kind === "group");
  const bots = connection.chat.bots.filter(({ archivedAt }) => !archivedAt);
  const archived = connection.chat.bots.filter(({ archivedAt }) => archivedAt);
  const connected = connection.status === "connected";
  const waiting = waitingItems(connection.chat);
  const waitingFor = (botId: string) => waiting.find((item) => item.botId === botId);
  const needsYouName =
    waiting.length === 0
      ? "Needs you"
      : `Needs you, ${waiting.length} ${waiting.length === 1 ? "item needs" : "items need"} you`;
  const count = waiting.length > 99 ? "99+" : waiting.length;
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [deleting, setDeleting] = useState<Bot>();
  const drawer = useRef<HTMLElement>(null);

  // The drawer sits outside the page's tab order until it opens, so focus has to move into it.
  useEffect(() => {
    if (open) {
      drawer.current?.querySelector("button")?.focus();
    }
  }, [open]);

  function collapse(next: boolean) {
    saveSidebarCollapsed(next);
    setCollapsed(next);
  }

  const navItems = [
    { Icon: Monitor, label: "Computers", current: wallOpen, onClick: onWall },
    { Icon: Gauge, label: "Usage", current: usageOpen, onClick: onUsage },
    { Icon: ScrollText, label: "Audit", current: auditOpen, onClick: onAudit },
  ];

  return (
    <>
      {collapsed && (
        <nav
          aria-label="Bots"
          className="hidden w-14 shrink-0 flex-col items-center gap-1 border-r border-edge-subtle bg-sidebar py-2 md:flex"
        >
          <IconAction
            label="Expand sidebar"
            Icon={PanelLeft}
            className="button button-icon mb-2"
            onClick={() => collapse(false)}
          />
          <Tooltip label="Needs you" side="bottom">
            <button
              type="button"
              aria-label={needsYouName}
              aria-current={needsYouOpen}
              className={railButton}
              onClick={onNeedsYou}
            >
              <Inbox {...iconProps} />
            </button>
          </Tooltip>
          {waiting.length > 0 && (
            <span aria-hidden="true" className={`${countClass} mb-1`}>
              {count}
            </span>
          )}
          <Tooltip label="Board" side="bottom">
            <Link to="/board" aria-label="Board" className={railButton}>
              <ListTodo {...iconProps} />
            </Link>
          </Tooltip>
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
            {bots.map((bot) => {
              const state = botState(bot, waitingFor(bot.id), connection);
              return (
                <Tooltip key={bot.id} label={bot.name} side="bottom">
                  <button
                    type="button"
                    aria-label={state ? `${bot.name}, ${state.label}` : bot.name}
                    aria-current={bot.id === selectedId}
                    className={railButton}
                    onClick={() => onSelect(bot.id)}
                  >
                    <Avatar seed={bot.avatarSeed} tight className="size-5" />
                    {state && (
                      <span
                        className={`absolute right-1 bottom-1 size-2 rounded-full ring-2 ring-sidebar ${statusDots[state.tone]}`}
                      />
                    )}
                  </button>
                </Tooltip>
              );
            })}
          </div>
          {navItems.map(({ Icon, label, current, onClick }) => (
            <Tooltip key={label} label={label} side="bottom">
              <button
                type="button"
                aria-label={label}
                aria-current={current}
                className={railButton}
                onClick={onClick}
              >
                <Icon {...iconProps} />
              </button>
            </Tooltip>
          ))}
        </nav>
      )}
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
        className={`fixed inset-y-0 left-0 z-20 flex w-sidebar shrink-0 flex-col border-r border-edge-subtle bg-sidebar p-2 md:visible md:static md:translate-x-0 ${
          collapsed ? "md:hidden" : ""
        } ${
          // Visibility animates only on close: an opening drawer must be focusable at once.
          open
            ? "translate-x-0 transition-transform"
            : "invisible -translate-x-full transition-[translate,visibility]"
        }`}
      >
        <div className="flex h-10 shrink-0 items-center pb-2 pl-2">
          <h1 className="flex flex-1 items-center gap-1.5 text-[16.5px] font-semibold tracking-[-0.01em]">
            <BeeLogo />
            Bee Bot
          </h1>
          <span className="md:hidden">
            <IconAction
              label="Close bot list"
              Icon={X}
              className="button button-icon"
              onClick={onClose}
            />
          </span>
          <span className="hidden md:inline-flex">
            <IconAction
              label="Collapse sidebar"
              Icon={PanelLeft}
              className="button button-icon"
              onClick={() => collapse(true)}
            />
          </span>
        </div>
        <nav aria-label="Bots" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          <button
            type="button"
            aria-label={needsYouName}
            aria-current={needsYouOpen}
            className={rowClass}
            onClick={onNeedsYou}
          >
            <Inbox {...iconProps} className="shrink-0" />
            <span className="flex-1">Needs you</span>
            {waiting.length > 0 && (
              <span aria-hidden="true" className={countClass}>
                {count}
              </span>
            )}
          </button>
          <Link to="/board" className={rowClass}>
            <ListTodo {...iconProps} className="shrink-0" />
            Board
          </Link>
          <SectionHeader
            label="Bots"
            action={<IconAction label="New bot" Icon={Plus} onClick={onNewBot} />}
          />
          {bots.length === 0 && <p className={emptyClass}>No bots yet</p>}
          <ul className="flex flex-col gap-0.5">
            {bots.map((bot) => (
              <li key={bot.id}>
                <BotRow
                  bot={bot}
                  connection={connection}
                  waiting={waitingFor(bot.id)}
                  selected={bot.id === selectedId}
                  onSelect={() => onSelect(bot.id)}
                />
              </li>
            ))}
          </ul>
          <SectionHeader
            label="Rooms"
            action={
              <IconAction
                label="New room"
                Icon={Plus}
                disabled={bots.length === 0}
                onClick={onNewRoom}
              />
            }
          />
          {rooms.length === 0 && <p className={emptyClass}>No rooms yet</p>}
          <ul className="flex flex-col gap-0.5">
            {rooms.map((room) => (
              <li key={room.id}>
                <RoomRow
                  room={room}
                  selected={room.id === selectedRoomId}
                  onSelect={() => onSelectRoom(room.id)}
                />
              </li>
            ))}
          </ul>
          {archived.length > 0 && (
            <details className="mt-2">
              <summary className="flex h-7 cursor-default items-center pl-2 text-label font-medium text-ink-secondary">
                Archived ({archived.length})
              </summary>
              <ul className="flex flex-col gap-0.5">
                {archived.map((bot) => (
                  <li key={bot.id} className="flex h-8 items-center gap-2 pl-2">
                    <Avatar seed={bot.avatarSeed} tight className="size-5 opacity-60" />
                    <span className="min-w-0 flex-1 truncate text-body-s text-ink-secondary">
                      {bot.name}
                    </span>
                    <button
                      type="button"
                      className="button button-sm !px-2"
                      disabled={!connected}
                      onClick={() => void sendCommand({ type: "restore-bot", botId: bot.id })}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="button button-sm !px-2 text-danger"
                      disabled={!connected}
                      onClick={() => setDeleting(bot)}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="mt-2 flex flex-col gap-0.5">
            {navItems.map((item) => (
              <NavItem key={item.label} {...item} />
            ))}
          </div>
        </nav>
        <SidebarFooter connection={connection} onUsage={onUsage} />
      </aside>
      {deleting && <DeleteBotDialog bot={deleting} onClose={() => setDeleting(undefined)} />}
    </>
  );
}
