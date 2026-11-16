import type { Bot } from "@beebot/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { Bot as BotIcon, CircleCheck, CircleX, PanelLeft, Plus, X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { AuditPage } from "../components/AuditPage";
import { BeeLogo } from "../components/BeeLogo";
import { BotDialog } from "../components/BotForm";
import { ChatView } from "../components/ChatView";
import { NeedsYouPage } from "../components/NeedsYouPage";
import { Onboarding } from "../components/Onboarding";
import { RoomDialog } from "../components/RoomDialog";
import { RoomView } from "../components/RoomView";
import { Sidebar } from "../components/Sidebar";
import { iconProps } from "../components/ui";
import { UsagePage } from "../components/UsagePage";
import { WallPage } from "../components/WallPage";
import { connectionLines } from "../labels";
import {
  type ConnectionState,
  getConnectionState,
  sendCommand,
  subscribeToConnection,
} from "../serverConnection";

const undoMs = 6000;

const skeletonLine = "h-3 rounded-xs bg-raised";

function Loading({ status }: { status: ConnectionState["status"] }) {
  const problem =
    status === "connecting" || status === "connected" ? undefined : connectionLines[status];
  return (
    <div className="flex h-dvh bg-background text-ink">
      <aside
        aria-hidden="true"
        className="hidden w-sidebar shrink-0 flex-col gap-3 border-r border-edge-subtle bg-sidebar p-2 md:flex"
      >
        <span className="flex h-10 items-center gap-1.5 pb-2 pl-2 text-[16.5px] font-semibold tracking-[-0.01em]">
          <BeeLogo />
          Bee Bot
        </span>
        {!problem &&
          [0, 1, 2, 3].map((row) => (
            <span key={row} className="flex items-center gap-3 px-2">
              <span className="size-6 shrink-0 rounded-full bg-raised" />
              <span className="flex flex-1 flex-col gap-2">
                <span className={`${skeletonLine} w-3/5`} />
                <span className={`${skeletonLine} w-full`} />
              </span>
            </span>
          ))}
      </aside>
      <main aria-busy={!problem} className="flex min-w-0 flex-1 flex-col items-center p-6">
        {problem ? (
          <div className="m-auto flex max-w-[480px] flex-col items-center gap-4 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-sidebar text-danger-status">
              <CircleX {...iconProps} size={24} />
            </span>
            <p role="status" data-status={status} className="text-body-s text-ink">
              {problem}
            </p>
          </div>
        ) : (
          <div className="flex w-full max-w-transcript flex-col gap-6 pt-6">
            <p role="status" data-status={status} className="text-caption text-ink-secondary">
              {connectionLines.connecting}
            </p>
            {[0, 1, 2].map((block) => (
              <span key={block} aria-hidden="true" className="flex flex-col gap-2">
                <span className={`${skeletonLine} w-full`} />
                <span className={`${skeletonLine} w-11/12`} />
                <span className={`${skeletonLine} w-1/2`} />
              </span>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function Home() {
  const connection = useSyncExternalStore(subscribeToConnection, getConnectionState);
  const { chat, loaded, status } = connection;
  const [selectedId, setSelectedId] = useState<string>();
  const [notNow, setNotNow] = useState(false);
  const [dialog, setDialog] = useState<"new" | "room" | Bot>();
  const [roomId, setRoomId] = useState<string>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [page, setPage] = useState<"needs" | "usage" | "audit" | "wall">();
  const [computerFor, setComputerFor] = useState<string>();
  const [archived, setArchived] = useState<Bot>();
  // Per bot and in memory only. Lives here so a failed send can restore into a reopened chat.
  const [composerTexts, setComposerTexts] = useState<Record<string, string>>({});
  const activeBots = chat.bots.filter(({ archivedAt }) => !archivedAt);
  const selected = activeBots.find(({ id }) => id === selectedId) ?? activeBots[0];
  const room = chat.rooms.find(({ id, kind }) => id === roomId && kind === "group");

  useEffect(() => {
    if (!archived) {
      return undefined;
    }
    const timer = setTimeout(() => setArchived(undefined), undoMs);
    return () => clearTimeout(timer);
  }, [archived]);

  function updateComposerText(botId: string, update: (current: string) => string) {
    setComposerTexts((texts) => ({ ...texts, [botId]: update(texts[botId] ?? "") }));
  }

  function openChat(botId: string) {
    setSelectedId(botId);
    setComputerFor(undefined);
    setRoomId(undefined);
    setPage(undefined);
    setDrawerOpen(false);
  }

  function showSavedBot(bot: Bot) {
    setSelectedId(bot.id);
    setDialog(undefined);
  }

  if (!loaded) {
    return <Loading status={status} />;
  }

  if (chat.bots.length === 0 && !notNow) {
    return (
      <Onboarding
        connection={connection}
        onNotNow={() => setNotNow(true)}
        onCreated={(bot) => {
          updateComposerText(bot.id, () => `Hi ${bot.name}. What can you help me with?`);
          setSelectedId(bot.id);
        }}
      />
    );
  }

  return (
    <div className="flex h-dvh bg-background text-ink">
      <Sidebar
        connection={connection}
        selectedId={page || room ? undefined : selected?.id}
        selectedRoomId={page ? undefined : room?.id}
        usageOpen={page === "usage"}
        auditOpen={page === "audit"}
        wallOpen={page === "wall"}
        needsYouOpen={page === "needs"}
        open={drawerOpen}
        onSelect={openChat}
        onSelectRoom={(id) => {
          setRoomId(id);
          setPage(undefined);
          setDrawerOpen(false);
        }}
        onNewRoom={() => {
          setDialog("room");
          setDrawerOpen(false);
        }}
        onUsage={() => {
          setPage("usage");
          setDrawerOpen(false);
        }}
        onAudit={() => {
          setPage("audit");
          setDrawerOpen(false);
        }}
        onWall={() => {
          setPage("wall");
          setDrawerOpen(false);
        }}
        onNeedsYou={() => {
          setPage("needs");
          setDrawerOpen(false);
        }}
        onNewBot={() => {
          setDialog("new");
          setDrawerOpen(false);
        }}
        onClose={() => setDrawerOpen(false)}
      />
      <main className="flex min-w-0 flex-1">
        {page === "needs" ? (
          <NeedsYouPage
            connection={connection}
            onOpenChat={openChat}
            onOpenDrawer={() => setDrawerOpen(true)}
          />
        ) : page === "usage" ? (
          <UsagePage connection={connection} onOpenDrawer={() => setDrawerOpen(true)} />
        ) : page === "audit" ? (
          <AuditPage connection={connection} onOpenDrawer={() => setDrawerOpen(true)} />
        ) : page === "wall" ? (
          <WallPage
            connection={connection}
            onOpenDrawer={() => setDrawerOpen(true)}
            onOpen={(botId) => {
              setSelectedId(botId);
              setComputerFor(botId);
              setRoomId(undefined);
              setPage(undefined);
            }}
          />
        ) : room ? (
          <RoomView
            key={room.id}
            room={room}
            connection={connection}
            onOpenDrawer={() => setDrawerOpen(true)}
          />
        ) : selected ? (
          <ChatView
            key={selected.id}
            bot={selected}
            connection={connection}
            composerText={composerTexts[selected.id] ?? ""}
            onComposerText={(update) => updateComposerText(selected.id, update)}
            openComputer={computerFor === selected.id}
            onEdit={() => setDialog(selected)}
            onOpenDrawer={() => setDrawerOpen(true)}
            onArchived={() => setArchived(selected)}
          />
        ) : (
          <div className="relative flex flex-1 flex-col items-center justify-center p-6">
            <button
              type="button"
              aria-label="Open bot list"
              className="button button-icon absolute top-3 left-3 md:hidden"
              onClick={() => setDrawerOpen(true)}
            >
              <PanelLeft {...iconProps} />
            </button>
            <div className="flex max-w-[480px] flex-col items-center gap-4 p-6 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-sidebar">
                <BotIcon {...iconProps} size={24} />
              </span>
              <div className="flex flex-col gap-2">
                <h2 className="text-heading font-semibold">No bots yet</h2>
                <p className="text-body-s text-ink-secondary">
                  A bot does work for you in its own chat. Create one to get started.
                </p>
              </div>
              <div className="pt-2">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => setDialog("new")}
                >
                  <Plus {...iconProps} />
                  New bot
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
      {archived && (
        <div
          role="status"
          className="menu fixed right-6 bottom-28 z-30 flex w-[min(360px,calc(100vw-32px))] items-center gap-2 py-2 pr-2 pl-3 text-body-s max-md:right-4"
        >
          <CircleCheck {...iconProps} className="shrink-0 text-success-status" />
          <span className="min-w-0 flex-1">{archived.name} archived.</span>
          <button
            type="button"
            className="button button-sm"
            onClick={() => {
              void sendCommand({ type: "restore-bot", botId: archived.id });
              setSelectedId(archived.id);
              setArchived(undefined);
            }}
          >
            Undo
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            className="button button-icon button-sm"
            onClick={() => setArchived(undefined)}
          >
            <X {...iconProps} />
          </button>
        </div>
      )}
      {dialog === "room" && (
        <RoomDialog
          bots={activeBots}
          onSaved={(saved) => {
            setRoomId(saved.id);
            setPage(undefined);
            setDialog(undefined);
          }}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog && dialog !== "room" && (
        <BotDialog
          bot={dialog === "new" ? undefined : dialog}
          onSaved={showSavedBot}
          onClose={() => setDialog(undefined)}
        />
      )}
    </div>
  );
}

export const Route = createFileRoute("/")({ component: Home });
