import type { Bot, BotAccess, ModelCatalog } from "@beebot/contracts";
import { ArrowUp, Square } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";

import { mentionedIds } from "../mentions";
import { postCommand, requestNotifications, sendCommand } from "../serverConnection";
import { AttachButton, UploadChips, useAttachments } from "./Attachments";
import { ComposerControls, type EngineChange, FullAccessDialog } from "./ComposerControls";
import { useMentionMenu } from "./MentionMenu";
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
  others,
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
  // The bots the owner can mention here. Mentioning one doesn't wake it.
  others: Bot[];
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  // Kept across a failed send, so resending the same text can't duplicate it.
  const [messageId, setMessageId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string>();
  const [confirmingFull, setConfirmingFull] = useState(false);
  const [changedDuring, setChangedDuring] = useState<string>();
  const nextTurnOnly = runId !== undefined && changedDuring === runId;
  const files = useAttachments(bot.roomId);
  const ready = (value.trim() !== "" || files.ids.length > 0) && !files.uploading;
  const mentions = useMentionMenu(value, (text) => onChange(() => text), others, box);

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
    const mentioned = mentionedIds(body, others);
    if (sending.current || !canSend || !ready) {
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
      ...(files.ids.length > 0 && { attachmentIds: files.ids }),
      ...(mentioned.length > 0 && { mentions: mentioned }),
    });
    sending.current = false;
    if (result.ok) {
      files.clear();
      setMessageId(crypto.randomUUID());
    } else {
      onChange((current) => current || body);
      setMessageId(messageId);
      setError(`Not sent. ${result.message}`);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const composing = event.nativeEvent.isComposing || event.keyCode === 229;
    if (composing || mentions.onKeyDown(event)) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <div className="pt-2 pb-6">
      {error && (
        <p role="alert" className="mb-2 text-label text-ink-secondary">
          {error}
        </p>
      )}
      {nextTurnOnly && (
        <p role="status" className="mb-2 text-label text-ink-secondary">
          Model, effort and mode apply to the next turn.
        </p>
      )}
      <form
        className="@container relative flex flex-col gap-2 rounded-composer border border-edge-strong bg-card p-3 shadow-menu transition-shadow has-[textarea:focus-visible]:ring-2 has-[textarea:focus-visible]:ring-focus"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        onDrop={files.onDrop}
        onDragOver={files.onDragOver}
      >
        <UploadChips uploads={files.uploads} onRemove={files.remove} />
        {mentions.menu}
        <textarea
          ref={box}
          data-composer
          // The composer is the one place focus belongs when a chat opens.
          autoFocus
          className="max-h-40 min-h-7 resize-none bg-transparent px-1 pt-1 text-body field-sizing-content outline-none placeholder:text-ink-faint"
          aria-label={`Message ${bot.name}`}
          {...mentions.textBoxProps}
          placeholder={
            others.length > 0 ? `Message ${bot.name}, @ to mention a bot` : `Message ${bot.name}`
          }
          rows={1}
          value={value}
          onFocus={({ currentTarget }) =>
            currentTarget.setSelectionRange(currentTarget.value.length, currentTarget.value.length)
          }
          onChange={({ target }) => {
            onChange(() => target.value);
            mentions.onCaret(target, true);
            setMessageId(crypto.randomUUID());
          }}
          onSelect={({ currentTarget }) => mentions.onCaret(currentTarget, false)}
          onKeyDown={onKeyDown}
          onPaste={files.onPaste}
        />
        <div className="flex items-center gap-1">
          <AttachButton disabled={!canSend} onFiles={files.add} />
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
              <Square {...iconProps} />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              className="icon-send"
              disabled={!canSend || !ready}
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
