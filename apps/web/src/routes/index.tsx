import type { Bot } from "@beebot/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { PanelLeft } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { AuditPage } from "../components/AuditPage";
import { BotDialog } from "../components/BotForm";
import { ChatView } from "../components/ChatView";
import { Onboarding } from "../components/Onboarding";
import { RoomDialog } from "../components/RoomDialog";
import { RoomView } from "../components/RoomView";
import { Sidebar } from "../components/Sidebar";
import { iconProps } from "../components/ui";
import { UsagePage } from "../components/UsagePage";
import { WallPage } from "../components/WallPage";
import { connectionLines } from "../labels";
import { getConnectionState, subscribeToConnection } from "../serverConnection";

function Home() {
  const connection = useSyncExternalStore(subscribeToConnection, getConnectionState);
  const { chat, loaded, status } = connection;
  const [selectedId, setSelectedId] = useState<string>();
  const [notNow, setNotNow] = useState(false);
  const [dialog, setDialog] = useState<"new" | "room" | Bot>();
  const [roomId, setRoomId] = useState<string>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [page, setPage] = useState<"usage" | "audit" | "wall">();
  // Per bot and in memory only. Lives here so a failed send can restore into a reopened chat.
  const [composerTexts, setComposerTexts] = useState<Record<string, string>>({});
  const selected = chat.bots.find(({ id }) => id === selectedId) ?? chat.bots[0];
  const room = chat.rooms.find(({ id, kind }) => id === roomId && kind === "group");

  function updateComposerText(botId: string, update: (current: string) => string) {
    setComposerTexts((texts) => ({ ...texts, [botId]: update(texts[botId] ?? "") }));
  }

  function showSavedBot(bot: Bot) {
    setSelectedId(bot.id);
    setDialog(undefined);
  }

  if (!loaded) {
    return (
      <main className="flex h-dvh items-center justify-center p-6">
        <p role="status" data-status={status} className="text-small text-ink-secondary">
          {status === "connected" ? connectionLines.connecting : connectionLines[status]}
        </p>
      </main>
    );
  }

  if (
    !chat.noticeAcknowledgedAt ||
    !chat.automatedAccessAcknowledgedAt ||
    (chat.bots.length === 0 && !notNow)
  ) {
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
        open={drawerOpen}
        onSelect={(botId) => {
          setSelectedId(botId);
          setRoomId(undefined);
          setPage(undefined);
          setDrawerOpen(false);
        }}
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
        onNewBot={() => {
          setDialog("new");
          setDrawerOpen(false);
        }}
        onClose={() => setDrawerOpen(false)}
      />
      <main className="flex min-w-0 flex-1">
        {page === "usage" ? (
          <UsagePage connection={connection} onOpenDrawer={() => setDrawerOpen(true)} />
        ) : page === "audit" ? (
          <AuditPage connection={connection} onOpenDrawer={() => setDrawerOpen(true)} />
        ) : page === "wall" ? (
          <WallPage connection={connection} onOpenDrawer={() => setDrawerOpen(true)} />
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
            onEdit={() => setDialog(selected)}
            onOpenDrawer={() => setDrawerOpen(true)}
          />
        ) : (
          <div className="relative flex flex-1 flex-col items-center justify-center gap-4 p-6">
            <button
              type="button"
              aria-label="Open bot list"
              className="button absolute top-2 left-3 !px-2 md:hidden"
              onClick={() => setDrawerOpen(true)}
            >
              <PanelLeft {...iconProps} />
            </button>
            <p className="text-empty">No bots yet</p>
            <button
              type="button"
              className="button button-primary"
              onClick={() => setDialog("new")}
            >
              New bot
            </button>
          </div>
        )}
      </main>
      {dialog === "room" && (
        <RoomDialog
          bots={chat.bots}
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
