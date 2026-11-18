import type { Bot } from "@beebot/contracts";
import {
  Archive,
  Bot as BotIcon,
  Box,
  Brain,
  CalendarClock,
  Ellipsis,
  Folder,
  Info,
  LogIn,
  type LucideIcon,
  Monitor,
  PanelLeft,
  Pause,
  Pencil,
  Play,
  Plug,
  ShieldAlert,
  Sparkles,
  Square,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { connectionLines, folderName, pauseLine, runLine } from "../labels";
import {
  type ConnectionState,
  isActive,
  markSeen,
  openCards,
  postCommand,
  sendCommand,
} from "../serverConnection";
import { buildTranscript } from "../transcript";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { MemoryPanel } from "./MemoryPanel";
import { RoutinesPanel } from "./RoutinesPanel";
import { SkillsPanel } from "./SkillsPanel";
import { BotConnectorsPanel } from "./BotConnectorsPanel";
import { TerminalPanel } from "./TerminalPanel";
import { Transcript } from "./Transcript";
import { columnClass, iconProps } from "./ui";
import { useWorkspace, Workspace } from "./Workspace";

const menuItemClass =
  "flex h-8 w-full items-center gap-2 rounded-row px-2 text-left text-body-s transition-colors hover:bg-hover disabled:text-ink-disabled";
const badgeClass =
  "flex h-[22px] shrink-0 items-center gap-1 rounded-xs px-2 text-label font-medium";

function MenuItem({
  icon: Icon,
  danger = false,
  disabled,
  onClick,
  children,
}: {
  icon: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      popoverTarget="bot-menu"
      popoverTargetAction="hide"
      className={`${menuItemClass} ${danger ? "text-danger" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon {...iconProps} className={`shrink-0 ${danger ? "" : "text-ink-secondary"}`} />
      {children}
    </button>
  );
}

const setPaused = (bot: Bot, paused: boolean) =>
  void sendCommand({ type: "set-bot-paused", botId: bot.id, paused });

function BotMenu({
  bot,
  connected,
  pendingMemories,
  onEdit,
  onMemory,
  onRoutines,
  onSkills,
  onConnectors,
  onLogin,
  onArchive,
}: {
  bot: Bot;
  connected: boolean;
  pendingMemories: number;
  onEdit: () => void;
  onMemory: () => void;
  onRoutines: () => void;
  onSkills: () => void;
  onConnectors: () => void;
  onLogin: () => void;
  onArchive: () => void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label={
          pendingMemories > 0 ? `Bot menu, ${pendingMemories} to review in memory` : "Bot menu"
        }
        popoverTarget="bot-menu"
        className="button button-icon relative [anchor-name:--bot-menu]"
      >
        <Ellipsis {...iconProps} />
        {pendingMemories > 0 && (
          <span className="absolute top-1 right-1 size-2 rounded-full bg-brand-fill" />
        )}
      </button>
      <div
        id="bot-menu"
        popover="auto"
        className="menu m-0 mt-1 w-60 p-1 [position-anchor:--bot-menu] [position-area:bottom_span-left]"
      >
        <MenuItem icon={Brain} onClick={onMemory}>
          <span className="flex-1">Memory</span>
          {pendingMemories > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-raised px-1.5 text-label font-medium text-ink-secondary">
              {pendingMemories}
            </span>
          )}
        </MenuItem>
        <MenuItem icon={CalendarClock} onClick={onRoutines}>
          Routines
        </MenuItem>
        <MenuItem icon={Sparkles} onClick={onSkills}>
          Skills
        </MenuItem>
        <MenuItem icon={Plug} onClick={onConnectors}>
          Connectors
        </MenuItem>
        {bot.boundary === "box" && bot.engineAccountId !== "fake" && (
          <MenuItem icon={LogIn} disabled={!connected} onClick={onLogin}>
            Log in
          </MenuItem>
        )}
        <MenuItem icon={Pencil} onClick={onEdit}>
          Edit bot
        </MenuItem>
        <MenuItem
          icon={bot.status === "ready" ? Pause : Play}
          disabled={!connected}
          onClick={() => setPaused(bot, bot.status === "ready")}
        >
          {bot.status === "ready" ? `Pause ${bot.name}` : `Resume ${bot.name}`}
        </MenuItem>
        <MenuItem icon={Archive} disabled={!connected} onClick={onArchive}>
          Archive
        </MenuItem>
        <hr className="my-1 border-edge-subtle" />
        <MenuItem
          icon={Square}
          danger
          disabled={!connected}
          onClick={() => void sendCommand({ type: "stop-all" })}
        >
          Stop all
        </MenuItem>
      </div>
    </>
  );
}

export function ChatView({
  bot,
  connection,
  composerText,
  onComposerText,
  openComputer,
  onEdit,
  onOpenDrawer,
  onArchived,
}: {
  bot: Bot;
  connection: ConnectionState;
  composerText: string;
  onComposerText: (update: (current: string) => string) => void;
  openComputer: boolean;
  onEdit: () => void;
  onOpenDrawer: () => void;
  onArchived: () => void;
}) {
  const { chat, drafts, liveTools, thinking } = connection;
  const { pending, status, commandError, lastSeen, models } = connection;
  const connected = status === "connected";
  const messages = chat.messages.filter(({ roomId }) => roomId === bot.roomId);
  const approvals = chat.approvals.filter(({ botId }) => botId === bot.id);
  const run = chat.runs.find(({ botId }) => botId === bot.id);
  const account = chat.accounts.find(({ id }) => id === bot.engineAccountId);
  const continuations = chat.continuations.filter(({ botId }) => botId === bot.id);
  const items = buildTranscript(
    messages,
    approvals,
    pending,
    openCards(chat, bot.id),
    continuations,
  );
  const active = isActive(run);
  const limited = run?.reason === "limited";
  const draft = run && drafts[run.id];
  const tools = (run && liveTools[run.id]) ?? [];
  const thinkingState = run && thinking[run.id];
  const waiting = approvals.some(({ status }) => status === "pending");
  const toolRunning = tools.some(({ status }) => status === "running");
  const showThinking =
    active && !limited && !waiting && (thinkingState?.active || (!draft && !toolRunning));
  const systemLine = runLine(run, account);
  const canContinue = run?.status === "Interrupted" || run?.status === "Cancelled";
  const lastBotMessageId = messages.findLast(({ author }) => author === "bot")?.id;
  const seenId = lastSeen[bot.id];
  const memories = chat.memories.filter(({ botId }) => botId === bot.id);
  const routines = chat.routines.filter(({ botId }) => botId === bot.id);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string>();
  const workspace = useWorkspace(bot, run, tools, connection.activity[bot.id], openComputer);

  useEffect(() => {
    if (lastBotMessageId && lastBotMessageId !== seenId) {
      markSeen(bot.id, lastBotMessageId);
    }
  }, [bot.id, lastBotMessageId, seenId]);

  const empty = items.length === 0 && !active && !systemLine;
  const pauseNotice =
    bot.pauseReason && pauseLine(bot.pauseReason, bot.engineAccountId, account?.lane);
  const notices = [
    status !== "connected" && connectionLines[status],
    pauseNotice,
    commandError,
    archiveError,
  ].filter((line) => typeof line === "string");

  return (
    <section className="relative flex min-w-0 flex-1" aria-label={`Chat with ${bot.name}`}>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge-subtle pr-4 pl-2 md:pl-6">
          <button
            type="button"
            aria-label="Open bot list"
            className="button button-icon md:hidden"
            onClick={onOpenDrawer}
          >
            <PanelLeft {...iconProps} />
          </button>
          <Avatar seed={bot.avatarSeed} className="size-6 rounded-full" />
          <h2 className="truncate text-title-s font-semibold">{bot.name}</h2>
          <span className={`${badgeClass} bg-raised text-ink`}>
            {bot.boundary === "box" && <Box {...iconProps} size={12} />}
            {bot.boundary === "box" ? "In a box" : "Attended only"}
          </span>
          {bot.projectPath && (
            <span
              title={bot.projectPath}
              className={`${badgeClass} min-w-0 shrink bg-raised text-ink`}
            >
              <Folder {...iconProps} size={12} className="shrink-0" />
              <span className="truncate">{folderName(bot.projectPath)}</span>
            </span>
          )}
          {bot.access === "full" && (
            <span className={`${badgeClass} bg-danger-surface text-danger`}>
              <ShieldAlert {...iconProps} size={12} />
              Full access
            </span>
          )}
          {bot.engineAccountId === "fake" && (
            <span className={`${badgeClass} bg-brand-surface text-brand`}>Test engine</span>
          )}
          <span className="flex-1" />
          {workspace.liveTab && !workspace.open && (
            <button
              type="button"
              className="button button-sm button-outline shrink-0 rounded-full!"
              onClick={() => workspace.show(workspace.liveTab)}
            >
              <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-brand-fill" />
              Watch
            </button>
          )}
          <button
            type="button"
            aria-label="Computer"
            aria-pressed={workspace.open}
            className="button button-icon aria-pressed:bg-hover"
            onClick={() => (workspace.open ? workspace.close() : workspace.show())}
          >
            <Monitor {...iconProps} />
          </button>
          <BotMenu
            bot={bot}
            connected={connected}
            pendingMemories={memories.filter(({ status }) => status === "pending").length}
            onEdit={onEdit}
            onMemory={() => setMemoryOpen(true)}
            onRoutines={() => setRoutinesOpen(true)}
            onSkills={() => setSkillsOpen(true)}
            onConnectors={() => setConnectorsOpen(true)}
            onLogin={() => setLoginOpen(true)}
            onArchive={() =>
              void postCommand({ type: "archive-bot", botId: bot.id }).then((result) =>
                result.ok ? onArchived() : setArchiveError(result.message),
              )
            }
          />
        </header>
        {empty ? (
          <div
            className={`${columnClass} flex flex-1 flex-col items-center justify-center text-center`}
          >
            <span className="mb-4 flex size-12 items-center justify-center rounded-full bg-sidebar text-ink-secondary">
              <BotIcon {...iconProps} size={20} />
            </span>
            <p className="text-heading font-semibold">Ask {bot.name} for something</p>
            <p className="mt-2 line-clamp-3 max-w-[420px] text-ink-secondary">
              {bot.summary || "Describe the task the way you'd brief a teammate."}
            </p>
          </div>
        ) : (
          <Transcript
            bot={bot}
            items={items}
            connected={connected}
            draft={draft}
            liveTools={tools}
            workingSince={run?.status === "Running" ? run.startedAt : undefined}
            endedWork={
              run?.startedAt && run.endedAt
                ? Date.parse(run.endedAt) - Date.parse(run.startedAt)
                : undefined
            }
            thought={showThinking ? (thinkingState?.text ?? "") : undefined}
            systemLine={systemLine}
            onContinue={
              canContinue
                ? () => void sendCommand({ type: "continue-run", runId: run.id })
                : undefined
            }
          />
        )}
        <div className={columnClass}>
          <div role="status">
            {notices.map((notice) => (
              <div
                key={notice}
                className="mb-2 flex items-center gap-2 rounded-card border border-edge-subtle bg-sidebar py-2 pr-2 pl-3"
              >
                <Info {...iconProps} className="shrink-0 text-ink-secondary" />
                <p className="flex-1 py-1">{notice}</p>
                {notice === pauseNotice && (
                  <button
                    type="button"
                    className="button button-sm button-outline shrink-0"
                    disabled={!connected}
                    onClick={() => setPaused(bot, false)}
                  >
                    Resume
                  </button>
                )}
              </div>
            ))}
          </div>
          <Composer
            key={bot.id}
            bot={bot}
            catalog={models}
            runId={active ? run?.id : undefined}
            canSend={connected && bot.status === "ready"}
            canStop={active || Boolean(limited && account?.blockedUntil)}
            connected={connected}
            value={composerText}
            onChange={onComposerText}
            others={chat.bots.filter(({ id, archivedAt }) => id !== bot.id && !archivedAt)}
          />
        </div>
      </div>
      {workspace.open && (
        <Workspace
          bot={bot}
          boxes={connection.boxAvailability}
          hostControl={connection.hostControl}
          working={active}
          activity={connection.activity[bot.id]}
          tab={workspace.tab}
          liveTab={workspace.liveTab}
          onTab={workspace.choose}
          onClose={workspace.close}
        />
      )}
      {memoryOpen && (
        <MemoryPanel
          bot={bot}
          memories={memories}
          connected={connected}
          onClose={() => setMemoryOpen(false)}
        />
      )}
      {loginOpen && <TerminalPanel bot={bot} onClose={() => setLoginOpen(false)} />}
      {skillsOpen && (
        <SkillsPanel
          bot={bot}
          skills={chat.skills}
          connected={connected}
          onClose={() => setSkillsOpen(false)}
        />
      )}
      {connectorsOpen && (
        <BotConnectorsPanel
          bot={bot}
          connectors={chat.connectors}
          connected={connected}
          onClose={() => setConnectorsOpen(false)}
        />
      )}

      {routinesOpen && (
        <RoutinesPanel
          bot={bot}
          routines={routines}
          firings={chat.firings}
          connected={connected}
          onClose={() => setRoutinesOpen(false)}
        />
      )}
    </section>
  );
}
