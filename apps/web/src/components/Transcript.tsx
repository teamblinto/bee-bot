import type { Bot } from "@beebot/contracts";
import { ArrowDown, ChevronRight } from "lucide-react";
import { type UIEvent, type WheelEvent, useEffect, useRef, useState } from "react";

import { answeredLine, doneLine, toolLabel } from "../labels";
import type { TranscriptItem } from "../transcript";
import { ApprovalCard } from "./ApprovalCard";
import { Markdown } from "./Markdown";
import { columnClass, iconProps } from "./ui";

function ToolLine({ label, tools }: { label: string; tools: string[] }) {
  // The list only ever grows, so a position is a stable key.
  const rows = tools.map((name, position) => ({ name, position }));
  return (
    <details className="group text-small text-ink-secondary">
      <summary className="flex w-fit cursor-default list-none items-center gap-1 rounded-field [&::-webkit-details-marker]:hidden">
        {label}
        <ChevronRight {...iconProps} className="transition-transform group-open:rotate-90" />
      </summary>
      <ul className="mt-1 ml-1 border-l border-edge pl-3">
        {rows.map(({ name, position }) => (
          <li key={position}>{toolLabel(name)}</li>
        ))}
      </ul>
    </details>
  );
}

function Item({ item, bot, connected }: { item: TranscriptItem; bot: Bot; connected: boolean }) {
  if (item.kind === "approval") {
    const { approval, pending } = item;
    return pending ? (
      <ApprovalCard name={bot.name} approval={approval} pending={pending} connected={connected} />
    ) : (
      <p className="text-small text-ink-secondary">{answeredLine(approval)}</p>
    );
  }
  const { message } = item;
  if (message.author === "human") {
    return (
      <p className="ml-auto w-fit max-w-[80%] rounded-bubble bg-message px-3.5 py-2 wrap-anywhere whitespace-pre-wrap">
        {message.body}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {message.tools.length > 0 && (
        <ToolLine label={doneLine(message.tools.length)} tools={message.tools} />
      )}
      <Markdown text={message.body} />
    </div>
  );
}

export function Transcript({
  bot,
  items,
  connected,
  draft,
  liveTools,
  thinking,
  systemLine,
  onContinue,
}: {
  bot: Bot;
  items: TranscriptItem[];
  connected: boolean;
  draft: string | undefined;
  liveTools: string[];
  thinking: boolean;
  systemLine: string;
  onContinue: (() => void) | undefined;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const sent = useRef(0);
  const last = useRef({ top: 0, height: 0, view: 0 });
  const [away, setAway] = useState(false);

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
      // Sending always returns to the end, and at the end there's nothing left to jump to.
      if (sentCount() > sent.current || atEnd) {
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
    } else if (box.scrollTop > top && atEnd) {
      follow(true);
    }
    last.current = { top: box.scrollTop, height: box.scrollHeight, view: box.clientHeight };
  }

  function onWheel({ deltaY, currentTarget: box }: WheelEvent<HTMLDivElement>) {
    if (deltaY < 0 && box.scrollHeight > box.clientHeight) {
      follow(false);
    }
  }

  function jumpToLatest() {
    follow(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        className="scroller h-full overflow-y-auto"
        onScroll={onScroll}
        onWheel={onWheel}
      >
        <div ref={content} role="log" aria-label="Messages" className={`${columnClass} py-6`}>
          <ol>
            {items.map((item, index) => {
              const key = item.kind === "message" ? item.message.id : item.approval.id;
              const previous = items[index - 1];
              const gap = !previous ? "" : previous.sender === item.sender ? "mt-1" : "mt-6";
              return (
                <li key={key} data-sender={item.sender} className={gap}>
                  <Item item={item} bot={bot} connected={connected} />
                </li>
              );
            })}
          </ol>
          <div className="mt-6 flex flex-col gap-2 empty:hidden">
            {liveTools.length > 0 && <ToolLine label="Working…" tools={liveTools} />}
            {/* The finished reply is announced as a message; each delta shouldn't be. */}
            {draft && (
              <div aria-live="off">
                <Markdown text={draft} />
              </div>
            )}
            {thinking && <p className="shimmer w-fit text-small">Thinking</p>}
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
