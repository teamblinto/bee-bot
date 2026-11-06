import { Bot, defaultBotModel, EngineAccountId } from "@beebot/contracts";
import { Dices } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { codexRulesWarning, projectPathValue } from "../labels";
import { getConnectionState, postCommand, subscribeToConnection } from "../serverConnection";
import { Avatar } from "./Avatar";
import { ModelPicker } from "./ModelPicker";
import { iconProps } from "./ui";

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

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
  const [projectPath, setProjectPath] = useState(bot?.projectPath ?? "");
  const [engine, setEngine] = useState<keyof typeof EngineAccountId.enum>("claude");
  const catalog = useSyncExternalStore(subscribeToConnection, () => getConnectionState().models);
  const [avatarSeed, setAvatarSeed] = useState(() => bot?.avatarSeed ?? randomSeed());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const saving = useRef(false);
  const accountId = bot?.engineAccountId ?? engine;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || !name.trim()) {
      return;
    }
    saving.current = true;
    setBusy(true);
    setError(undefined);
    const fields = {
      name,
      personality,
      model,
      avatarSeed,
      projectPath: projectPathValue(projectPath),
    };
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
      <div className="flex items-center gap-3">
        {/* Keyed so each new face replays the pop. */}
        <Avatar key={avatarSeed} seed={avatarSeed} className="avatar-pop size-20" />
        <button
          type="button"
          aria-label="Shuffle avatar"
          className="button button-outline"
          onClick={() => setAvatarSeed(randomSeed())}
        >
          <Dices {...iconProps} />
          Shuffle
        </button>
      </div>
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
      <div className={labelClass}>
        Model
        <ModelPicker
          accountId={accountId}
          model={model}
          catalog={catalog}
          // A session belongs to one vendor.
          locked={bot !== undefined}
          field
          onPick={(accountId, picked) => {
            setModel(picked);
            setEngine(EngineAccountId.parse(accountId));
          }}
        />
        {accountId === "codex" && <p className="text-small">{codexRulesWarning}</p>}
      </div>
      <label className={labelClass}>
        Project folder (optional)
        <input
          className="field text-ink"
          aria-describedby="project-folder-help"
          maxLength={1024}
          spellCheck={false}
          value={projectPath}
          onChange={(event) => setProjectPath(event.target.value)}
        />
      </label>
      <p id="project-folder-help" className="text-small text-ink-secondary">
        Bots can read and change files here. Changing the folder starts a new session, resets access
        to Supervised and clears Always allow.
      </p>
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
