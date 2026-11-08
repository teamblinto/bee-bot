import {
  Bot,
  type BoxAvailability,
  BotProfile,
  browserGrant,
  defaultBotModel,
  EngineAccountId,
  EngineLane,
} from "@beebot/contracts";
import { Dices } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { codexRulesWarning, laneLabels, projectPathValue } from "../labels";
import { getConnectionState, postCommand, subscribeToConnection } from "../serverConnection";
import { Avatar } from "./Avatar";
import { ModelPicker } from "./ModelPicker";
import { AutomatedAccessNotice } from "./VaultPanel";
import { iconProps } from "./ui";

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

// Rule of Two: each profile holds two of untrusted input, private data and side effects.
const profileLabels: Record<BotProfile, { name: string; help: string }> = {
  operator: {
    name: "Operator",
    help: "Works on your files and data and acts on them. Reading untrusted content, such as web pages, waits for you.",
  },
  reader: {
    name: "Reader",
    help: "Reads untrusted content and your private data, but only reports back to you. Acting or sending waits for you.",
  },
  researcher: {
    name: "Researcher",
    help: "Reads the web and acts, but holds none of your private data. Reaching your data waits for you.",
  },
};

const labelClass = "flex flex-col gap-1 text-label text-ink-secondary";

function boxUnavailableReason(boxes: BoxAvailability | undefined) {
  if (!boxes) {
    return "This server can't run boxes.";
  }
  if (boxes.available) {
    return undefined;
  }
  return boxes.settingUp
    ? "Boxes are being set up. Try again when that's done."
    : "Boxes aren't set up. Set them up on the Usage page.";
}

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
  const accounts = useSyncExternalStore(
    subscribeToConnection,
    () => getConnectionState().chat.accounts,
  );
  const [laneChoice, setLaneChoice] = useState<EngineLane>();
  const [profile, setProfile] = useState<BotProfile>(bot?.profile ?? "operator");
  const [browser, setBrowser] = useState(bot?.manifest.includes(browserGrant) ?? false);
  const [inBox, setInBox] = useState(bot?.boundary === "box");
  const boxes = useSyncExternalStore(
    subscribeToConnection,
    () => getConnectionState().boxAvailability,
  );
  const apiKeys = useSyncExternalStore(
    subscribeToConnection,
    () => getConnectionState().chat.vault.apiKeys,
  );
  const [avatarSeed, setAvatarSeed] = useState(() => bot?.avatarSeed ?? randomSeed());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const saving = useRef(false);
  const accountId = bot?.engineAccountId ?? engine;
  const savedLane = accounts.find(({ id }) => id === accountId)?.lane;
  const lane = laneChoice ?? savedLane ?? "subscription";
  const laneAccount = accountId === "claude" || accountId === "codex" ? accountId : undefined;
  const lanes = laneAccount && laneLabels[laneAccount];
  const boxProblem = boxUnavailableReason(boxes);

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
    const laneResult =
      laneAccount && laneChoice && laneChoice !== savedLane
        ? await postCommand({
            type: "set-account-lane",
            engineAccountId: laneAccount,
            lane: laneChoice,
          })
        : undefined;
    const result =
      laneResult && !laneResult.ok
        ? laneResult
        : await postCommand(
            bot
              ? { type: "update-bot", botId: bot.id, ...fields }
              : { type: "create-bot", ...fields, engineAccountId: engine },
          );
    const created = result.ok ? Bot.safeParse(result.body).data : undefined;
    const profileResult =
      created && created.profile !== profile
        ? await postCommand({ type: "set-bot-profile", botId: created.id, profile })
        : undefined;
    const manifestResult =
      created && created.manifest.includes(browserGrant) !== browser
        ? await postCommand({
            type: "set-bot-manifest",
            botId: created.id,
            manifest: browser
              ? [...created.manifest, browserGrant]
              : created.manifest.filter((grant) => grant !== browserGrant),
          })
        : undefined;
    const boundary = inBox ? "box" : "host";
    const boundaryResult =
      created && created.boundary !== boundary
        ? await postCommand({ type: "set-bot-boundary", botId: created.id, boundary })
        : undefined;
    saving.current = false;
    setBusy(false);
    const last = boundaryResult ?? manifestResult ?? profileResult ?? result;
    const saved = last.ok ? Bot.safeParse(last.body).data : undefined;
    if (saved) {
      onSaved(saved);
    } else {
      setError(last.ok ? "That didn't work. Try again." : last.message);
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
            setLaneChoice(undefined);
            setEngine(EngineAccountId.parse(accountId));
          }}
        />
        {accountId === "codex" && <p className="text-small">{codexRulesWarning}</p>}
      </div>
      {lanes && (
        <label className={labelClass}>
          Login
          <select
            className="field text-ink"
            aria-describedby="lane-help"
            value={lane}
            onChange={(event) => setLaneChoice(EngineLane.parse(event.target.value))}
          >
            {EngineLane.options.map((option) => (
              <option key={option} value={option}>
                {lanes[option]}
              </option>
            ))}
          </select>
        </label>
      )}
      {lanes && (
        <p id="lane-help" className="text-small text-ink-secondary">
          Applies to every bot on this engine. Log the CLI in this way yourself; Bee Bot never sees
          the key and pauses bots if the login doesn't match.
        </p>
      )}
      <label className={labelClass}>
        Profile
        <select
          className="field text-ink"
          aria-describedby="profile-help"
          value={profile}
          onChange={(event) => setProfile(BotProfile.parse(event.target.value))}
        >
          {BotProfile.options.map((option) => (
            <option key={option} value={option}>
              {profileLabels[option].name}
            </option>
          ))}
        </select>
      </label>
      <p id="profile-help" className="text-small text-ink-secondary">
        {profileLabels[profile].help} With nobody watching, it is refused.
      </p>
      <label className="flex items-center gap-2 text-label text-ink-secondary">
        <input
          type="checkbox"
          aria-describedby="browser-help"
          checked={browser}
          onChange={(event) => setBrowser(event.target.checked)}
        />
        Browser
      </label>
      <p id="browser-help" className="text-small text-ink-secondary">
        Lets the bot open web pages in its own browser. Every page counts as untrusted content.
      </p>
      <label className="flex items-center gap-2 text-label text-ink-secondary">
        <input
          type="checkbox"
          aria-describedby="box-help"
          checked={inBox}
          // A bot in a box can always leave it.
          disabled={!inBox && boxProblem !== undefined}
          onChange={(event) => setInBox(event.target.checked)}
        />
        Run in a box
      </label>
      <div id="box-help" className="flex flex-col gap-2 text-small text-ink-secondary">
        <p>
          {!inBox && boxProblem
            ? boxProblem
            : "The bot works in its own container, away from your files, so it can run on its own: on a schedule or while you're away."}
        </p>
        {inBox && (
          <>
            <p>
              {laneAccount && apiKeys.includes(laneAccount)
                ? "On its own, it uses your saved API key."
                : "No API key is saved for this engine, so on its own it uses your subscription. You can save a key on the Usage page."}
            </p>
            <AutomatedAccessNotice />
          </>
        )}
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
