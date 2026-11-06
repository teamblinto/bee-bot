import type { Bot } from "@beebot/contracts";
import { ArrowUp, Square } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import { postCommand, requestNotifications, sendCommand } from "../serverConnection";
import { iconProps } from "./ui";

export function Composer({
  bot,
  canSend,
  canStop,
  connected,
  value,
  onChange,
}: {
  bot: Bot;
  canSend: boolean;
  canStop: boolean;
  connected: boolean;
  value: string;
  onChange: (update: (current: string) => string) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  // Kept across a failed send, so resending the same text can't duplicate it.
  const [messageId, setMessageId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string>();

  // Enter never reaches the button, so its disabled state can't be the gate.
  async function send() {
    const body = value;
    if (sending.current || !canSend || !body.trim()) {
      return;
    }
    sending.current = true;
    requestNotifications();
    setError(undefined);
    onChange(() => "");
    box.current?.focus();
    const result = await postCommand({
      type: "send-message",
      messageId,
      roomId: bot.roomId,
      body,
    });
    sending.current = false;
    if (result.ok) {
      setMessageId(crypto.randomUUID());
    } else {
      onChange((current) => current || body);
      setMessageId(messageId);
      setError(`Not sent. ${result.message}`);
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (event.key === "Enter" && !event.shiftKey && !composing) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="pb-4">
      {error && (
        <p role="alert" className="mb-2 text-small text-ink-secondary">
          {error}
        </p>
      )}
      <form
        className="flex items-end gap-2 rounded-composer bg-card p-1.5 outline-honey has-[textarea:focus-visible]:outline-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={box}
          data-composer
          // The composer is the one place focus belongs when a chat opens.
          autoFocus
          className="max-h-40 min-h-8 flex-1 resize-none self-center bg-transparent px-2.5 py-1 field-sizing-content outline-none"
          aria-label={`Message ${bot.name}`}
          placeholder={`Message ${bot.name}`}
          rows={1}
          value={value}
          onFocus={({ currentTarget }) =>
            currentTarget.setSelectionRange(currentTarget.value.length, currentTarget.value.length)
          }
          onChange={({ target }) => {
            onChange(() => target.value);
            setMessageId(crypto.randomUUID());
          }}
          onKeyDown={onKeyDown}
        />
        {canStop ? (
          <button
            type="button"
            aria-label="Stop"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-background hover:bg-ink-hover disabled:bg-raised disabled:text-ink-faint"
            disabled={!connected}
            onClick={() => void sendCommand({ type: "stop-bot", botId: bot.id })}
          >
            <Square {...iconProps} fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-background hover:bg-ink-hover disabled:bg-raised disabled:text-ink-faint"
            disabled={!canSend || !value.trim()}
          >
            <ArrowUp {...iconProps} />
          </button>
        )}
      </form>
    </div>
  );
}
