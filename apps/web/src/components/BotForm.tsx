import { Bot, BotModel, defaultBotModel } from "@beebot/contracts";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { postCommand } from "../serverConnection";

const modelLabels: Record<BotModel, string> = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };

const labelClass = "flex flex-col gap-1 text-label text-ink-secondary";

export function BotForm({
  bot,
  submitLabel,
  onSaved,
  children,
}: {
  bot: Bot | undefined;
  submitLabel: string;
  onSaved: (bot: Bot) => void;
  // The form's secondary action, placed before the submit button.
  children: ReactNode;
}) {
  const [name, setName] = useState(bot?.name ?? "");
  const [personality, setPersonality] = useState(bot?.personality ?? "");
  const [model, setModel] = useState(bot?.model ?? defaultBotModel);
  const [engine, setEngine] = useState<"claude" | "fake">("claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const saving = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || !name.trim()) {
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(undefined);
    const fields = { name, personality, model };
    const result = await postCommand(
      bot
        ? { type: "update-bot", botId: bot.id, ...fields }
        : { type: "create-bot", ...fields, engineAccountId: engine },
    );
    saving.current = false;
    setBusy(false);
    const saved = result.ok ? Bot.safeParse(result.body).data : undefined;
    if (saved) {
      onSaved(saved);
    } else {
      setError(result.ok ? "That didn't work. Try again." : result.message);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
      <label className={labelClass}>
        Name
        <input
          className="field text-ink"
          // Opens with the form, which only ever appears on request.
          autoFocus
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className={labelClass}>
        Personality
        <textarea
          className="field resize-none text-ink"
          maxLength={4000}
          rows={3}
          value={personality}
          onChange={(event) => setPersonality(event.target.value)}
        />
      </label>
      <label className={labelClass}>
        Model
        <select
          className="field text-ink"
          value={model}
          onChange={(event) => setModel(BotModel.parse(event.target.value))}
        >
          {BotModel.options.map((option) => (
            <option key={option} value={option}>
              {modelLabels[option]}
            </option>
          ))}
        </select>
      </label>
      {import.meta.env.DEV && !bot && (
        <label className={labelClass}>
          Engine
          <select
            className="field text-ink"
            value={engine}
            onChange={(event) => setEngine(event.target.value === "fake" ? "fake" : "claude")}
          >
            <option value="claude">Claude</option>
            <option value="fake">Test engine</option>
          </select>
        </label>
      )}
      {error && (
        <p role="alert" className="text-small text-ink-secondary">
          {error}
        </p>
      )}
      <div className="mt-1 flex items-center justify-end gap-1">
        {children}
        <button type="submit" className="button button-primary" disabled={busy || !name.trim()}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function BotDialog({
  bot,
  onSaved,
  onClose,
}: {
  bot: Bot | undefined;
  onSaved: (bot: Bot) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!dialog.current?.open) {
      dialog.current?.showModal();
    }
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-label={bot ? `Edit ${bot.name}` : "New bot"}
      className="dialog m-auto w-[min(440px,calc(100vw-32px))] p-5 backdrop:bg-scrim"
      onClose={onClose}
    >
      <h2 className="mb-4 text-title font-semibold">{bot ? "Edit bot" : "New bot"}</h2>
      <BotForm bot={bot} submitLabel={bot ? "Save" : "Create bot"} onSaved={onSaved}>
        <button type="button" className="button" onClick={() => dialog.current?.close()}>
          Cancel
        </button>
      </BotForm>
    </dialog>
  );
}
