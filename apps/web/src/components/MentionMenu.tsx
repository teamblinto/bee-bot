import type { Bot } from "@beebot/contracts";
import { type KeyboardEvent, type RefObject, useState } from "react";
import { flushSync } from "react-dom";

import { insertMention, mentionAt, mentionMatches } from "../mentions";
import { Avatar } from "./Avatar";

// The @ picker for a composer's text box. `onKeyDown` answers whether the key was the picker's.
export function useMentionMenu(
  text: string,
  setText: (text: string) => void,
  bots: Bot[],
  box: RefObject<HTMLTextAreaElement | null>,
) {
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  // The start of a mention the owner closed the picker on, so it stays closed while they type.
  const [dismissed, setDismissed] = useState<number>();
  const mention = mentionAt(text, caret);
  const matches = mention && mention.start !== dismissed ? mentionMatches(bots, mention.query) : [];
  const highlighted = matches[Math.min(highlight, matches.length - 1)];

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
    if (!highlighted || !mention) {
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
    menu: highlighted && (
      <ul
        id="mention-list"
        role="listbox"
        aria-label="Bots to mention"
        className="menu absolute bottom-full left-0 mb-1 w-56 p-1"
      >
        {matches.map((bot) => (
          <li
            key={bot.id}
            id={`mention-${bot.id}`}
            role="option"
            aria-selected={bot === highlighted}
            className="flex cursor-default items-center gap-2 rounded-field px-2 py-1 text-small aria-selected:bg-hover"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => pick(bot)}
          >
            <Avatar seed={bot.avatarSeed} className="size-5" />
            {bot.name}
          </li>
        ))}
      </ul>
    ),
  };
}
