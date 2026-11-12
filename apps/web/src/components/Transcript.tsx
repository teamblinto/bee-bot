import type { Bot } from "@beebot/contracts";
import { ArrowDown } from "lucide-react";
import { type UIEvent, type WheelEvent, useEffect, useRef, useState } from "react";

import { answeredLine, liveStatusLine, workedLine } from "../labels";
import type { LiveTool } from "../serverConnection";
import { deriveMinimapItems } from "../timelineMinimap";
import { isOpenItem, isOutcomeMessage, itemKey, type TranscriptItem } from "../transcript";
import { ApprovalCard, ContinuationCard } from "./ApprovalCard";
import { MessageAttachments } from "./Attachments";
import { Markdown } from "./Markdown";
import { RoutineCard } from "./RoutineCard";
import { TimelineMinimap } from "./TimelineMinimap";
import { columnClass, iconProps } from "./ui";
import { ThinkingRow, WorkGroup, WorkingLabel } from "./WorkLog";

const jumpOffsetPx = 24;

// The list only ever grows, so a position is a stable key.
const namedTools = (names: string[]) =>
  names.map((name, position): LiveTool => ({
    id: String(position),
    name,
    detail: null,
    status: "done",
  }));

function Item({
  item,
  bot,
  connected,
  finishedTools,
  authorName,
}: {
  item: TranscriptItem;
  bot: Pick<Bot, "name">;
  connected: boolean;
  finishedTools: Record<string, LiveTool[]>;
  authorName: ((botId: string) => string | undefined) | undefined;
}) {
  if (item.kind === "approval") {
    const { approval, pending } = item;
    return pending ? (
      <ApprovalCard name={bot.name} approval={approval} pending={pending} connected={connected} />
    ) : (
      <p className="text-small text-ink-secondary">{answeredLine(approval)}</p>
    );
  }
  if (item.kind === "continuation") {
    return (
      <ContinuationCard name={bot.name} continuation={item.continuation} connected={connected} />
    );
  }
  if (item.kind === "routine") {
    return <RoutineCard routine={item.routine} firing={item.firing} connected={connected} />;
  }
  const { message } = item;
  // Bee's record of the outcome, not words the owner typed.
  if (isOutcomeMessage(message)) {
    return (
      <p className="text-small wrap-anywhere whitespace-pre-wrap text-ink-secondary">
        {message.body}
      </p>
    );
  }
  if (message.author === "human") {
    return (
      <div className="ml-auto flex max-w-[80%] flex-col items-end gap-1">
        {message.body && (
          <p className="w-fit rounded-bubble bg-message px-3.5 py-2 wrap-anywhere whitespace-pre-wrap">
            {message.body}
          </p>
        )}
        {message.attachments.length > 0 && <MessageAttachments attachments={message.attachments} />}
      </div>
    );
  }
  // Only rooms name authors. A bot that was deleted left its messages behind with no bot.
  const author =
    authorName &&
    ((message.botId === null ? undefined : authorName(message.botId)) ?? "Deleted bot");
  return (
    <div className="flex flex-col gap-2">
      {author && <p className="text-label font-medium text-ink-secondary">{author}</p>}
      {message.tools.length > 0 && (
        <WorkGroup
          label={workedLine(message.workedMs, message.tools.length)}
          tools={finishedTools[message.id] ?? namedTools(message.tools)}
        />
      )}
      <Markdown text={message.body} />
    </div>
  );
}

export function Transcript({
  bot,
  items,
  connected,
  finishedTools,
  draft,
  liveTools,
  workingSince,
  endedWork,
  thought,
  systemLine,
  onContinue,
  authorName,
}: {
  bot: Pick<Bot, "name">;
  items: TranscriptItem[];
  connected: boolean;
  finishedTools: Record<string, LiveTool[]>;
  draft: string | undefined;
  liveTools: LiveTool[];
  // Set while the turn runs.
  workingSince: string | null | undefined;
  // How long a turn ran that ended without a reply, whose tools still have a place here.
  endedWork: number | null | undefined;
  // Undefined when nothing is thinking. Often empty while something is.
  thought: string | undefined;
  systemLine: string;
  onContinue: (() => void) | undefined;
  // Labels each bot message with who wrote it, for rooms with more than one bot.
  authorName?: (botId: string) => string | undefined;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // After a jump the view stays put, even when the target sits at the very end, until the owner
  // scrolls or sends.
  const jumped = useRef(false);
  const sent = useRef(0);
  const last = useRef({ top: 0, height: 0, view: 0 });
  const [away, setAway] = useState(false);
  const settledItems = items.filter((item) => !isOpenItem(item));
  const pendingItems = items.filter(isOpenItem);

  function follow(on: boolean) {
    following.current = on;
    setAway(!on);
  }

  // Output grows without any scroll event, so size changes are what keep the view at the end.
  useEffect(() => {
    const box = scroller.current;
    const inner = content.current;
    if (!box || !inner) {
      return undefined;
    }
    const sentCount = () => inner.querySelectorAll('[data-sender="human"]').length;
    sent.current = sentCount();
    const observer = new ResizeObserver(() => {
      const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 2;
      const newlySent = sentCount() > sent.current;
      // Sending always returns to the end, and at the end there's nothing left to jump to.
      if (newlySent || (atEnd && !jumped.current)) {
        jumped.current = false;
        following.current = true;
        setAway(false);
      }
      sent.current = sentCount();
      if (following.current) {
        box.scrollTop = box.scrollHeight;
      }
    });
    observer.observe(box);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  function onScroll({ currentTarget: box }: UIEvent<HTMLDivElement>) {
    const { top, height, view } = last.current;
    const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 2;
    // Shrinking content or a taller window also lowers scrollTop; neither is the user moving up.
    if (box.scrollTop < top && box.scrollHeight >= height && box.clientHeight === view) {
      follow(false);
    } else if (box.scrollTop > top && atEnd && !jumped.current) {
      follow(true);
    }
    last.current = { top: box.scrollTop, height: box.scrollHeight, view: box.clientHeight };
  }

  function onWheel({ deltaY, currentTarget: box }: WheelEvent<HTMLDivElement>) {
    jumped.current = false;
    if (deltaY < 0 && box.scrollHeight > box.clientHeight) {
      follow(false);
    }
  }

  function jumpToLatest() {
    jumped.current = false;
    follow(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }

  function jumpToMessage(id: string) {
    const box = scroller.current;
    const row = content.current?.querySelector(`[data-message-id="${id}"]`);
    if (!box || !row) {
      return;
    }
    jumped.current = true;
    follow(false);
    const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({
      top: box.scrollTop + offset - jumpOffsetPx,
      behavior: smooth ? "smooth" : "auto",
    });
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        className="scroller h-full overflow-y-auto"
        onScroll={onScroll}
        onWheel={onWheel}
        onPointerDown={() => {
          jumped.current = false;
        }}
      >
        <div ref={content} role="log" aria-label="Messages" className={`${columnClass} py-6`}>
          <ol>
            {settledItems.map((item, index) => {
              const previous = settledItems[index - 1];
              const gap = !previous ? "" : previous.sender === item.sender ? "mt-1" : "mt-6";
              return (
                <li
                  key={itemKey(item)}
                  data-sender={item.sender}
                  data-message-id={item.kind === "message" ? item.message.id : undefined}
                  className={gap}
                >
                  <Item
                    item={item}
                    bot={bot}
                    connected={connected}
                    finishedTools={finishedTools}
                    authorName={authorName}
                  />
                </li>
              );
            })}
          </ol>
          {/* The finished reply is announced as a message; each delta shouldn't be. */}
          <div aria-live="off" className="mt-6 flex flex-col gap-2 empty:hidden">
            {thought !== undefined && <ThinkingRow text={thought} />}
            {workingSince && (
              <WorkGroup live label={<WorkingLabel startedAt={workingSince} />} tools={liveTools} />
            )}
            {!workingSince && endedWork !== undefined && liveTools.length > 0 && (
              <WorkGroup label={workedLine(endedWork, liveTools.length)} tools={liveTools} />
            )}
            {pendingItems.map((item) => (
              <Item
                key={itemKey(item)}
                item={item}
                bot={bot}
                connected={connected}
                finishedTools={finishedTools}
                authorName={authorName}
              />
            ))}
            {draft && <Markdown text={draft} streaming />}
            {/* Last on purpose: `runs` only has the latest run, and it ended after all of this. */}
            {systemLine && (
              <p className="flex items-center gap-2 text-small text-ink-secondary">
                {systemLine}
                {onContinue && (
                  <button
                    type="button"
                    className="button button-outline"
                    disabled={!connected}
                    onClick={onContinue}
                  >
                    Continue
                  </button>
                )}
              </p>
            )}
          </div>
        </div>
      </div>
      <TimelineMinimap
        items={deriveMinimapItems(settledItems)}
        scroller={scroller}
        content={content}
        onJump={jumpToMessage}
      />
      <p role="status" className="sr-only">
        {liveStatusLine(thought !== undefined, workingSince ? liveTools : [], Boolean(draft))}
      </p>
      {away && (
        <button
          type="button"
          className="button button-outline absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full! shadow-menu"
          onClick={jumpToLatest}
        >
          <ArrowDown {...iconProps} />
          Jump to latest
        </button>
      )}
    </div>
  );
}
