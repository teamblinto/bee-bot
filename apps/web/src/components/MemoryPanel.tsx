import { type Bot, type Command, type MemoryItem, MemoryType } from "@beebot/contracts";
import { Brain, Inbox, Plus } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";

import { memoryNotice, memoryReview, memoryTypeLabels, shortTime, visibleDetail } from "../labels";
import { postCommand } from "../serverConnection";
import {
  badgeClass,
  ConfirmDialog,
  EmptyState,
  errorClass,
  fieldLabelClass,
  RowMenu,
  SidePanel,
} from "./SidePanel";
import { iconProps } from "./ui";

const textClass = "text-body-s wrap-anywhere whitespace-pre-wrap";
const rowClass = "flex flex-col gap-2 border-b border-edge-subtle pb-4";

function MemoryMeta({ item }: { item: MemoryItem }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-caption text-ink-secondary">
      <span className={badgeClass}>{memoryTypeLabels[item.type]}</span>
      {item.source === "user" ? "You" : "Bot"} · {shortTime(item.created)}
    </p>
  );
}

export function MemoryPanel({
  bot,
  memories,
  connected,
  onClose,
}: {
  bot: Bot;
  memories: MemoryItem[];
  connected: boolean;
  onClose: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const pending = memories.filter(({ status }) => status === "pending");
  const active = memories
    .filter(({ status }) => status === "active")
    .toSorted((a, b) => b.created.localeCompare(a.created));
  const [tab, setTab] = useState<"review" | "active">(pending.length > 0 ? "review" : "active");
  const [text, setText] = useState("");
  const [memoryType, setMemoryType] = useState<MemoryType>("user");
  const [adding, setAdding] = useState(false);
  const [correcting, setCorrecting] = useState<string>();
  const [forgetting, setForgetting] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const disabled = busy || !connected;

  function clearForm() {
    setText("");
    setMemoryType("user");
    setAdding(false);
    setCorrecting(undefined);
    setError(undefined);
  }

  // State updates arrive by event, so a success only has to tidy up here.
  async function send(command: Command, onDone: () => void) {
    if (sending.current) {
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(undefined);
    const result = await postCommand(command);
    sending.current = false;
    setBusy(false);
    if (result.ok) {
      onDone();
    } else {
      setError(result.message);
    }
  }

  // The row that held the focus is about to leave, and the next Tab should reach the next row.
  const decide = (memoryId: string, decision: "approve" | "reject") =>
    void send({ type: "decide-memory", memoryId, decision }, () => list.current?.focus());

  const forget = (memoryId: string) =>
    void send({ type: "forget-memory", memoryId }, () => {
      if (memoryId === correcting) {
        clearForm();
      }
      list.current?.focus();
    });

  function correct(item: MemoryItem) {
    setText(item.text);
    setMemoryType(item.type);
    setAdding(false);
    setCorrecting(item.id);
    setError(undefined);
  }

  function startAdding() {
    clearForm();
    setAdding(true);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(
      { type: "add-memory", botId: bot.id, text, memoryType, supersedes: correcting },
      clearForm,
    );
  }

  const form = (title: string) => (
    <form className="flex flex-col gap-2" onSubmit={submit}>
      <label className={fieldLabelClass}>
        {title}
        <textarea
          autoFocus
          className="field resize-none font-normal"
          maxLength={2000}
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 text-caption text-ink-secondary">
        Type
        <select
          className="field h-7 w-auto py-0 text-label text-ink"
          value={memoryType}
          onChange={(event) => setMemoryType(MemoryType.parse(event.target.value))}
        >
          {MemoryType.options.map((option) => (
            <option key={option} value={option}>
              {memoryTypeLabels[option]}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          className="button button-sm button-primary"
          disabled={disabled || !text.trim()}
        >
          Save
        </button>
        <button type="button" className="button button-sm" onClick={clearForm}>
          Cancel
        </button>
      </div>
    </form>
  );

  const forgettingItem = active.find(({ id }) => id === forgetting);

  return (
    <SidePanel
      label={`${bot.name} memory`}
      botName={bot.name}
      title="Memory"
      tabs={[
        { id: "review", label: "Review", count: pending.length },
        { id: "active", label: "Active", count: active.length },
      ]}
      tab={tab}
      onTab={setTab}
      onClose={onClose}
    >
      <div ref={list} tabIndex={-1} className="flex flex-col gap-4 outline-none">
        {tab === "review" ? (
          pending.length === 0 ? (
            <EmptyState icon={Inbox} title="Nothing to review">
              <p className="text-body-s text-ink-secondary">
                When {bot.name} wants to remember something, it waits here for you.
              </p>
            </EmptyState>
          ) : (
            <section className="flex flex-col gap-4" aria-label="Review">
              <p className="text-body-s text-ink-secondary">
                {bot.name} wants to remember these. Nothing is kept until you say so.
              </p>
              {pending.map((item) => {
                const { title, lines } = memoryReview(item, memories);
                return (
                  <article key={item.id} aria-label={title} className={rowClass}>
                    <h3 className="text-body-s font-medium">{title}</h3>
                    {lines.map(({ label, text: line }) => (
                      <div key={label}>
                        <p className="text-caption text-ink-secondary">{label}</p>
                        <p className={textClass}>{visibleDetail(line)}</p>
                      </div>
                    ))}
                    <MemoryMeta item={item} />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="button button-sm button-outline"
                        disabled={disabled}
                        onClick={() => decide(item.id, "approve")}
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        className="button button-sm"
                        disabled={disabled}
                        onClick={() => decide(item.id, "reject")}
                      >
                        Don't keep
                      </button>
                    </div>
                  </article>
                );
              })}
            </section>
          )
        ) : (
          <section className="flex flex-col gap-4" aria-label="Active">
            {adding ? (
              <div className={rowClass}>{form("Add memory")}</div>
            ) : active.length === 0 ? (
              <EmptyState icon={Brain} title={`${bot.name} doesn't remember anything yet`}>
                <p className="max-w-80 text-body-s text-ink-secondary">
                  Things {bot.name} learns show up in Review first. You can also add one yourself.
                </p>
                <button
                  type="button"
                  className="button button-sm button-primary mt-2"
                  disabled={disabled}
                  onClick={startAdding}
                >
                  <Plus {...iconProps} />
                  Add memory
                </button>
              </EmptyState>
            ) : (
              <button
                type="button"
                className="button button-sm self-start"
                disabled={disabled}
                onClick={startAdding}
              >
                <Plus {...iconProps} />
                Add memory
              </button>
            )}
            <ul className="flex flex-col gap-4">
              {active.map((item) =>
                item.id === correcting ? (
                  <li key={item.id} className={rowClass}>
                    {form("Correct memory")}
                    <MemoryMeta item={item} />
                  </li>
                ) : (
                  <li key={item.id} className={rowClass}>
                    <div className="flex items-start gap-2">
                      <p className={`${textClass} min-w-0 flex-1`}>{visibleDetail(item.text)}</p>
                      <RowMenu
                        label={`Memory actions: ${item.text.slice(0, 40)}`}
                        items={[
                          { label: "Correct", disabled, onSelect: () => correct(item) },
                          {
                            label: "Forget",
                            danger: true,
                            disabled,
                            onSelect: () => setForgetting(item.id),
                          },
                        ]}
                      />
                    </div>
                    <MemoryMeta item={item} />
                  </li>
                ),
              )}
            </ul>
          </section>
        )}
        {error && (
          <p role="alert" className={errorClass}>
            {error}
          </p>
        )}
        <p className="text-caption text-ink-secondary">{memoryNotice}</p>
      </div>
      {forgettingItem && (
        <ConfirmDialog
          title="Forget this memory?"
          confirmLabel="Forget"
          onConfirm={() => forget(forgettingItem.id)}
          onClose={() => setForgetting(undefined)}
        >
          {bot.name} won't remember it in new chats. You can't undo this, but you can add it again
          by hand.
        </ConfirmDialog>
      )}
    </SidePanel>
  );
}
