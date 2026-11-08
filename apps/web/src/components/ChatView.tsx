import type { Bot } from "@beebot/contracts";
import { Ellipsis, Folder, PanelLeft, ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";

import { connectionLines, folderName, pauseLine, runLine } from "../labels";
import {
  type ConnectionState,
  isActive,
  markSeen,
  openCards,
  sendCommand,
} from "../serverConnection";
import { buildTranscript } from "../transcript";
import { Avatar } from "./Avatar";
import { Composer } from "./Composer";
import { MemoryPanel } from "./MemoryPanel";
import { RoutinesPanel } from "./RoutinesPanel";
import { TerminalPanel } from "./TerminalPanel";
import { Transcript } from "./Transcript";
import { columnClass, iconProps } from "./ui";

const menuItemClass =
  "w-full rounded-field px-2.5 py-1.5 text-left text-small transition-colors hover:bg-hover disabled:text-ink-faint";

function BotMenu({
  bot,
  connected,
  pendingMemories,
  onEdit,
  onMemory,
  onRoutines,
  onLogin,
}: {
  bot: Bot;
  connected: boolean;
  pendingMemories: number;
  onEdit: () => void;
  onMemory: () => void;
  onRoutines: () => void;
  onLogin: () => void;
}) {
  const hide = { popoverTarget: "bot-menu", popoverTargetAction: "hide" } as const;
  return (
    <>
      <button
        type="button"
        aria-label={
          pendingMemories > 0 ? `Bot menu, ${pendingMemories} to review in memory` : "Bot menu"
        }
        popoverTarget="bot-menu"
        className="button !px-2 [anchor-name:--bot-menu]"
      >
        <Ellipsis {...iconProps} />
        {pendingMemories > 0 && <span className="size-2 shrink-0 rounded-full bg-honey" />}
      </button>
      <div
        id="bot-menu"
        popover="auto"
        className="menu m-0 mt-1 w-40 p-1 [position-anchor:--bot-menu] [position-area:bottom_span-left]"
      >
        <button type="button" {...hide} className={menuItemClass} onClick={onMemory}>
          Memory{pendingMemories > 0 && ` (${pendingMemories})`}
        </button>
        <button type="button" {...hide} className={menuItemClass} onClick={onRoutines}>
          Routines
        </button>
        {bot.boundary === "box" && bot.engineAccountId !== "fake" && (
          <button
            type="button"
            {...hide}
            className={menuItemClass}
            disabled={!connected}
            onClick={onLogin}
          >
            Log in
          </button>
        )}
        <button type="button" {...hide} className={menuItemClass} onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          {...hide}
          className={menuItemClass}
          disabled={!connected}
          onClick={() =>
            void sendCommand({
              type: "set-bot-paused",
              botId: bot.id,
              paused: bot.status === "ready",
            })
          }
        >
          {bot.status === "ready" ? "Pause" : "Resume"}
        </button>
        <button
          type="button"
          {...hide}
          className={`${menuItemClass} text-danger`}
          disabled={!connected}
          onClick={() => void sendCommand({ type: "stop-all" })}
        >
          Stop all
        </button>
      </div>
    </>
  );
}

export function ChatView({
  bot,
  connection,
  composerText,
  onComposerText,
  onEdit,
  onOpenDrawer,
}: {
  bot: Bot;
  connection: ConnectionState;
  composerText: string;
  onComposerText: (update: (current: string) => string) => void;
  onEdit: () => void;
  onOpenDrawer: () => void;
}) {
  const { chat, drafts, liveTools, thinking, finishedTools } = connection;
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

  useEffect(() => {
    if (lastBotMessageId && lastBotMessageId !== seenId) {
      markSeen(bot.id, lastBotMessageId);
    }
  }, [bot.id, lastBotMessageId, seenId]);

  const empty = items.length === 0 && !active && !systemLine;
  const notices = [
    status !== "connected" && connectionLines[status],
    bot.pauseReason && pauseLine(bot.pauseReason, bot.engineAccountId, account?.lane),
    commandError,
  ].filter((line) => typeof line === "string");

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label={`Chat with ${bot.name}`}>
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-edge px-3">
        <button
          type="button"
          aria-label="Open bot list"
          className="button !px-2 md:hidden"
          onClick={onOpenDrawer}
        >
          <PanelLeft {...iconProps} />
        </button>
        <Avatar seed={bot.avatarSeed} className="size-7" />
        <h2 className="truncate text-name font-medium">{bot.name}</h2>
        <span className="shrink-0 rounded-full border border-edge px-2 py-px text-micro text-ink-faint">
          Attended only
        </span>
        {bot.projectPath && (
          <span
            title={bot.projectPath}
            className="flex min-w-0 items-center gap-1 rounded-full border border-edge px-2 py-px text-micro text-ink-faint"
          >
            <Folder {...iconProps} size={12} className="shrink-0" />
            <span className="truncate">{folderName(bot.projectPath)}</span>
          </span>
        )}
        {bot.access === "full" && (
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-danger/40 bg-danger-surface px-2 py-px text-micro text-danger">
            <ShieldOff {...iconProps} size={12} />
            Full access
          </span>
        )}
        {bot.engineAccountId === "fake" && (
          <span className="shrink-0 rounded-full border border-edge px-2 py-px text-micro text-ink-faint">
            Test engine
          </span>
        )}
        <span className="flex-1" />
        <BotMenu
          bot={bot}
          connected={connected}
          pendingMemories={memories.filter(({ status }) => status === "pending").length}
          onEdit={onEdit}
          onMemory={() => setMemoryOpen(true)}
          onRoutines={() => setRoutinesOpen(true)}
          onLogin={() => setLoginOpen(true)}
        />
      </header>
      {empty ? (
        <div className={`${columnClass} flex flex-1 flex-col justify-center gap-1 text-center`}>
          <p className="text-empty">{bot.name}</p>
          {bot.summary && (
            <p className="line-clamp-3 text-small text-ink-secondary">{bot.summary}</p>
          )}
        </div>
      ) : (
        <Transcript
          bot={bot}
          items={items}
          connected={connected}
          finishedTools={finishedTools}
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
            <p key={notice} className="mb-2 text-small text-ink-secondary">
              {notice}
            </p>
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
        />
      </div>
      {memoryOpen && (
        <MemoryPanel
          bot={bot}
          memories={memories}
          connected={connected}
          onClose={() => setMemoryOpen(false)}
        />
      )}
      {loginOpen && <TerminalPanel bot={bot} onClose={() => setLoginOpen(false)} />}
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
