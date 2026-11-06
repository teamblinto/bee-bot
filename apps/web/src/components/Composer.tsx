import type { Bot, BotAccess, ModelCatalog } from "@beebot/contracts";
import { ArrowUp, Square } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import { postCommand, requestNotifications, sendCommand } from "../serverConnection";
import { ComposerControls, type EngineChange, FullAccessDialog } from "./ComposerControls";
import { iconProps } from "./ui";

export function Composer({
  bot,
  catalog,
  runId,
  canSend,
  canStop,
  connected,
  value,
  onChange,
}: {
  bot: Bot;
  catalog: ModelCatalog | undefined;
  // The run in progress, if any.
  runId: string | undefined;
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
  const [confirmingFull, setConfirmingFull] = useState(false);
  const [changedDuring, setChangedDuring] = useState<string>();
  const nextTurnOnly = runId !== undefined && changedDuring === runId;

  function changeEngine(change: EngineChange) {
    if (change.access === undefined) {
      setChangedDuring(runId);
    }
    void sendCommand({ type: "set-bot-engine", botId: bot.id, ...change });
  }

  function changeAccess(access: BotAccess) {
    if (access === "full") {
      setConfirmingFull(true);
    } else {
      changeEngine({ access });
    }
  }

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
      {nextTurnOnly && (
        <p role="status" className="mb-2 text-small text-ink-secondary">
          Model, reasoning and mode apply to the next turn.
        </p>
      )}
      <form
        className="@container flex flex-col gap-1 rounded-composer border border-edge bg-card/80 p-1.5 shadow-composer backdrop-blur-md backdrop-saturate-[1.14] transition-[border-color] has-[textarea:focus-visible]:border-edge-strong"
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
          className="max-h-40 min-h-8 resize-none bg-transparent px-2.5 py-1 field-sizing-content outline-none"
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
        <div className="flex items-center gap-2">
          <ComposerControls
            bot={bot}
            catalog={catalog}
            connected={connected}
            onChange={(change) =>
              change.access === undefined ? changeEngine(change) : changeAccess(change.access)
            }
          />
          {canStop ? (
            <button
              type="button"
              aria-label="Stop"
              className="icon-send"
              disabled={!connected}
              onClick={() => void sendCommand({ type: "stop-bot", botId: bot.id })}
            >
              <Square {...iconProps} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              className="icon-send"
              disabled={!canSend || !value.trim()}
            >
              <ArrowUp {...iconProps} />
            </button>
          )}
        </div>
      </form>
      {confirmingFull && (
        <FullAccessDialog
          name={bot.name}
          onCancel={() => setConfirmingFull(false)}
          onConfirm={() => {
            setConfirmingFull(false);
            changeEngine({ access: "full" });
          }}
        />
      )}
    </div>
  );
}
