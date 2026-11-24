import type { Bot, Command } from "@beebot/contracts";
import { Inbox, PanelLeft } from "lucide-react";
import { type ReactNode, useState } from "react";

import { approvalTitle, dailyLimitLine, memoryReview, shortTime } from "../labels";
import { memoriesToReview, type WaitingItem, waitingItems, waitingKind } from "../needsYou";
import { type ConnectionState, postCommand } from "../serverConnection";
import { ApprovalCard, ContinuationCard } from "./ApprovalCard";
import { Avatar } from "./Avatar";
import { RoutineCard } from "./RoutineCard";
import { iconProps } from "./ui";

function Item({
  bot,
  kind,
  at,
  onOpenChat,
  children,
}: {
  bot: Bot;
  kind: string;
  at: string;
  onOpenChat: () => void;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3 border-b border-edge-subtle p-4">
      <Avatar seed={bot.avatarSeed} className="size-8" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="flex items-center gap-1">
          <span className="text-body-s font-medium">{bot.name}</span>
          <span className="flex-1 text-caption text-ink-secondary">· {kind}</span>
          <span className="shrink-0 text-caption text-ink-secondary tabular-nums">
            {shortTime(at)}
          </span>
        </p>
        {children}
        <div>
          <button type="button" className="button button-sm button-outline" onClick={onOpenChat}>
            Open chat
          </button>
        </div>
      </div>
    </li>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col">
      <h3 className="flex items-center gap-2 pb-2 text-title-s font-semibold">
        {title}
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-raised px-1 text-label font-medium text-ink-secondary">
          {count}
        </span>
      </h3>
      <ul>{children}</ul>
    </section>
  );
}

function BudgetCard({ bot, connected }: { bot: Bot; connected: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const { dailyTokenCap, dailyUsdCap } = bot;

  async function raise(command: Command) {
    setBusy(true);
    setError(undefined);
    const result = await postCommand(command);
    // On success this card closes when the bot's pause clears.
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
    }
  }

  const disabled = busy || !connected;
  return (
    <article className="surface flex max-w-[560px] flex-col gap-2 p-4">
      <h3 className="text-body-s font-medium">{bot.name} reached its daily limit</h3>
      <p className="text-body-s text-ink-secondary">{dailyLimitLine(bot)} a day</p>
      {error && <p className="text-caption text-ink-secondary">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button
          type="button"
          className="button button-sm button-outline"
          disabled={disabled}
          onClick={() =>
            void raise({
              type: "raise-bot-cap",
              botId: bot.id,
              dailyTokenCap: null,
              dailyUsdCap: null,
            })
          }
        >
          Remove limit
        </button>
        <button
          type="button"
          className="button button-sm button-primary"
          disabled={disabled}
          onClick={() =>
            void raise({
              type: "raise-bot-cap",
              botId: bot.id,
              dailyTokenCap: dailyTokenCap === null ? null : Math.min(dailyTokenCap * 2, 1e9),
              dailyUsdCap: dailyUsdCap === null ? null : Math.min(dailyUsdCap * 2, 10_000),
            })
          }
        >
          Double and resume
        </button>
      </div>
    </article>
  );
}

function WaitingCard({
  item,
  bot,
  connection,
}: {
  item: WaitingItem;
  bot: Bot;
  connection: ConnectionState;
}) {
  const connected = connection.status === "connected";
  if (item.kind === "continuation") {
    return (
      <ContinuationCard name={bot.name} continuation={item.continuation} connected={connected} />
    );
  }
  if (item.kind === "budget") {
    return <BudgetCard bot={bot} connected={connected} />;
  }
  if (item.kind === "routine") {
    return <RoutineCard routine={item.routine} firing={item.firing} connected={connected} />;
  }
  const pending = connection.pending.find(({ id }) => id === item.approval.id);
  // The card's detail lives only in server memory and arrives on its own; until then, name it.
  return pending ? (
    <ApprovalCard
      name={bot.name}
      approval={item.approval}
      pending={pending}
      connected={connected}
    />
  ) : (
    <p className="text-body-s">{approvalTitle(bot.name, item.approval.tool)}</p>
  );
}

export function NeedsYouPage({
  connection,
  onOpenChat,
  onOpenDrawer,
}: {
  connection: ConnectionState;
  onOpenChat: (botId: string) => void;
  onOpenDrawer: () => void;
}) {
  const { chat } = connection;
  const waiting = waitingItems(chat);
  const memories = memoriesToReview(chat);
  const botOf = (botId: string) => chat.bots.find(({ id }) => id === botId);

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Needs you">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge-subtle px-3 md:px-6">
        <button
          type="button"
          aria-label="Open bot list"
          className="button button-icon md:hidden"
          onClick={onOpenDrawer}
        >
          <PanelLeft {...iconProps} />
        </button>
        <h2 className="text-title-s font-semibold">Needs you</h2>
      </header>
      <div className="scroller min-h-0 flex-1 overflow-y-auto">
        {waiting.length === 0 && memories.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-6">
            <div className="flex max-w-[480px] flex-col items-center gap-4 p-6 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-sidebar">
                <Inbox {...iconProps} size={24} />
              </span>
              <div className="flex flex-col gap-2">
                <h3 className="text-heading font-semibold">Nothing needs you</h3>
                <p className="text-body-s text-ink-secondary">
                  When a bot is waiting on you, it shows up here.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-transcript flex-col gap-8 px-4 pt-6 pb-10">
            {waiting.length > 0 && (
              <Section title="Waiting on you" count={waiting.length}>
                {waiting.map((item) => {
                  const bot = botOf(item.botId);
                  return (
                    bot && (
                      <Item
                        key={item.id}
                        bot={bot}
                        kind={waitingKind(item)}
                        at={item.createdAt}
                        onOpenChat={() => onOpenChat(bot.id)}
                      >
                        <WaitingCard item={item} bot={bot} connection={connection} />
                      </Item>
                    )
                  );
                })}
              </Section>
            )}
            {memories.length > 0 && (
              <Section title="To review" count={memories.length}>
                {memories.map((memory) => {
                  const bot = botOf(memory.botId);
                  const review = memoryReview(
                    memory,
                    chat.memories.filter(({ botId }) => botId === memory.botId),
                  );
                  return (
                    bot && (
                      <Item
                        key={memory.id}
                        bot={bot}
                        kind="Memory"
                        at={memory.created}
                        onOpenChat={() => onOpenChat(bot.id)}
                      >
                        <p className="text-body-s">
                          {review.title}
                          {review.lines[0] && (
                            <span className="line-clamp-2 text-ink-secondary">
                              {review.lines[0].text}
                            </span>
                          )}
                        </p>
                      </Item>
                    )
                  );
                })}
              </Section>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
