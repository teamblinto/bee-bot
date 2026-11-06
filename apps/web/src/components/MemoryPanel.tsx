import { type Bot, type Command, type MemoryItem, MemoryType } from "@beebot/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { memoryLine, memoryNotice, memoryReview, memoryTypeLabels, visibleDetail } from "../labels";
import { postCommand } from "../serverConnection";

const labelClass = "flex flex-col gap-1 text-label text-ink-secondary";
const headingClass = "text-label text-ink-secondary";
const textClass = "text-small wrap-anywhere whitespace-pre-wrap";
const metaClass = "text-label text-ink-faint";

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
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const [text, setText] = useState("");
  const [memoryType, setMemoryType] = useState<MemoryType>("user");
  const [correcting, setCorrecting] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!dialog.current?.open) {
      dialog.current?.showModal();
    }
  }, []);

  const pending = memories.filter(({ status }) => status === "pending");
  const active = memories
    .filter(({ status }) => status === "active")
    .toSorted((a, b) => b.created.localeCompare(a.created));
  const disabled = busy || !connected;

  function clearForm() {
    setText("");
    setMemoryType("user");
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
    setCorrecting(item.id);
    setError(undefined);
    field.current?.focus();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(
      { type: "add-memory", botId: bot.id, text, memoryType, supersedes: correcting },
      () => {
        clearForm();
        field.current?.focus();
      },
    );
  }

  return (
    <dialog
      ref={dialog}
      aria-label={`${bot.name} memory`}
      className="m-auto max-h-[80dvh] w-[min(560px,calc(100vw-32px))] flex-col gap-3 rounded-card bg-overlay p-5 text-ink shadow-menu backdrop:bg-scrim open:flex"
      onClose={onClose}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title font-semibold">Memory</h2>
        <button type="button" className="button" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      <p className="text-small text-ink-secondary">{memoryNotice}</p>
      <div
        ref={list}
        tabIndex={-1}
        className="scroller flex min-h-0 flex-col gap-4 overflow-y-auto outline-none"
      >
        {pending.length > 0 && (
          <section className="flex flex-col gap-2" aria-label="Review">
            <h3 className={headingClass}>Review ({pending.length})</h3>
            {pending.map((item) => {
              const { title, lines } = memoryReview(item, memories);
              return (
                <article
                  key={item.id}
                  aria-label={title}
                  className="flex flex-col gap-2 rounded-card bg-card p-4"
                >
                  <h4 className="text-name font-medium">{title}</h4>
                  {lines.map(({ label, text: line }) => (
                    <div key={label}>
                      <p className={metaClass}>{label}</p>
                      <p className={textClass}>{visibleDetail(line)}</p>
                    </div>
                  ))}
                  <p className={metaClass}>{memoryLine(item)}</p>
                  <div className="flex flex-wrap justify-end gap-1">
                    <button
                      type="button"
                      className="button"
                      disabled={disabled}
                      onClick={() => decide(item.id, "reject")}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={disabled}
                      onClick={() => decide(item.id, "approve")}
                    >
                      Approve
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        )}
        <section className="flex flex-col gap-2" aria-label="Active">
          <h3 className={headingClass}>Active</h3>
          {active.length === 0 && (
            <p className="text-small text-ink-secondary">Nothing saved yet.</p>
          )}
          <ul className="flex flex-col gap-3">
            {active.map((item) => (
              <li key={item.id} className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className={textClass}>{visibleDetail(item.text)}</p>
                  <p className={metaClass}>{memoryLine(item)}</p>
                </div>
                <button
                  type="button"
                  className="button shrink-0"
                  disabled={disabled}
                  onClick={() => correct(item)}
                >
                  Correct
                </button>
                <button
                  type="button"
                  className="button shrink-0"
                  disabled={disabled}
                  onClick={() => forget(item.id)}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {error && (
        <p role="alert" className="text-small text-ink-secondary">
          {error}
        </p>
      )}
      <form className="flex shrink-0 flex-col gap-2" onSubmit={submit}>
        <label className={labelClass}>
          {correcting ? "Correct this memory" : "Add a memory"}
          <textarea
            ref={field}
            className="field resize-none text-ink"
            maxLength={2000}
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <div className="flex items-end gap-2">
          <label className={`${labelClass} flex-1`}>
            Type
            <select
              className="field text-ink"
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
          {correcting && (
            <button type="button" className="button" onClick={clearForm}>
              Cancel
            </button>
          )}
          <button
            type="submit"
            className="button button-primary"
            disabled={disabled || !text.trim()}
          >
            {correcting ? "Save" : "Add"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
