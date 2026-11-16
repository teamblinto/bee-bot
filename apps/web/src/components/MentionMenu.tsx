import type { Bot } from "@beebot/contracts";
import { type KeyboardEvent, type ReactNode, type RefObject, useState } from "react";
import { flushSync } from "react-dom";

import { insertMention, mentionAt, mentionMatches } from "../mentions";
import { Avatar } from "./Avatar";

// The @ picker for a composer's text box. `onKeyDown` answers whether the key was the picker's.
export function useMentionMenu(
  text: string,
  setText: (text: string) => void,
  bots: Bot[],
  box: RefObject<HTMLTextAreaElement | null>,
  // `room` heads the list "In this room" and says when nobody matches.
  { room = false, renderStatus }: { room?: boolean; renderStatus?: (bot: Bot) => ReactNode } = {},
) {
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  // The start of a mention the owner closed the picker on, so it stays closed while they type.
  const [dismissed, setDismissed] = useState<number>();
  const mention = mentionAt(text, caret);
  const open = mention && mention.start !== dismissed ? mention : undefined;
  const matches = open ? mentionMatches(bots, open.query) : [];
  const highlighted = matches[Math.min(highlight, matches.length - 1)];
  const noMatch = room && open && open.query !== "" && !highlighted ? open.query : undefined;

  function pick(bot: Bot) {
    if (!mention) {
      return;
    }
    const next = insertMention(text, caret, mention.start, bot.name);
    flushSync(() => {
      setText(next.text);
      setCaret(next.caret);
      setHighlight(0);
    });
    box.current?.focus();
    box.current?.setSelectionRange(next.caret, next.caret);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!mention) {
      return false;
    }
    if (noMatch !== undefined && event.key === "Escape") {
      event.preventDefault();
      setDismissed(mention.start);
      return true;
    }
    if (!highlighted) {
      return false;
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) {
      setHighlight((matches.indexOf(highlighted) + step + matches.length) % matches.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      pick(highlighted);
    } else if (event.key === "Escape") {
      setDismissed(mention.start);
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }

  return {
    onKeyDown,
    // After every edit and caret move.
    onCaret: (target: HTMLTextAreaElement, typed: boolean) => {
      setCaret(target.selectionStart);
      if (typed) {
        setHighlight(0);
      }
    },
    textBoxProps: {
      "aria-autocomplete": "list" as const,
      "aria-controls": highlighted ? "mention-list" : undefined,
      "aria-activedescendant": highlighted ? `mention-${highlighted.id}` : undefined,
    },
    menu: (highlighted || noMatch !== undefined) && (
      <div className="menu absolute bottom-full left-0 mb-1 w-[min(296px,100%)] p-1">
        {room && <p className="px-2 pt-2 pb-1 text-caption text-ink-secondary">In this room</p>}
        {highlighted ? (
          <ul id="mention-list" role="listbox" aria-label="Bots to mention">
            {matches.map((bot) => (
              <li
                key={bot.id}
                id={`mention-${bot.id}`}
                role="option"
                aria-selected={bot === highlighted}
                className="flex h-9 cursor-default items-center gap-2 rounded-row px-2 py-1 aria-selected:bg-hover"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(bot)}
              >
                <Avatar seed={bot.avatarSeed} className="size-5" />
                <span className="min-w-0 flex-1 truncate text-body-s font-medium">{bot.name}</span>
                {renderStatus?.(bot)}
              </li>
            ))}
          </ul>
        ) : (
          <p role="status" className="px-2 pb-2 text-caption text-ink-secondary">
            No bot called "{noMatch}" in this room
          </p>
        )}
      </div>
    ),
  };
}
