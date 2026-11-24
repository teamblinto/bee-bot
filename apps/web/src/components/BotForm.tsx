import {
  Bot,
  type BoxAvailability,
  type BotControl,
  defaultBotModel,
  EngineAccountId,
  EngineLane,
} from "@beebot/contracts";
import { ChevronRight, Info, Shuffle, X } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { codexRulesWarning, dailyLimitLine, laneLabels, projectPathValue } from "../labels";
import {
  getConnectionState,
  postCommand,
  stopShortcut,
  subscribeToConnection,
} from "../serverConnection";
import { Avatar, shuffledSeed } from "./Avatar";
import { controlOptions, controlOrder } from "./controlOptions";
import { findModel, ModelPicker } from "./ModelPicker";
import { AutomatedAccessNotice } from "./VaultPanel";
import { iconProps } from "./ui";

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

const fieldClass = "flex flex-col gap-2";
const checkClass = "mt-0.5 size-4 shrink-0 accent-brand-fill";

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

function Banner({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-card border border-edge-subtle bg-sidebar py-3 pr-2 pl-3">
      <Info {...iconProps} className="mt-0.5 shrink-0 text-ink-secondary" />
      <div className="flex flex-col">
        <p className="font-medium text-ink">{title}</p>
        <p className="text-ink">{children}</p>
      </div>
    </div>
  );
}

// A row of More options: the setting and its current value, opening onto its controls.
function Option({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <details className="group border-b border-edge-subtle">
      <summary className="flex h-14 cursor-pointer list-none items-center gap-2 rounded-row px-1 text-ink transition-colors hover:bg-hover [&::-webkit-details-marker]:hidden">
        <span className="flex-1">{label}</span>
        <span className="min-w-0 truncate text-ink-secondary">{value}</span>
        <ChevronRight
          {...iconProps}
          className="shrink-0 transition-transform group-open:rotate-90"
        />
      </summary>
      <div className="flex flex-col gap-3 px-1 pt-1 pb-4">{children}</div>
    </details>
  );
}

function AcknowledgeRisk() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function acknowledge() {
    setBusy(true);
    setError(undefined);
    const result = await postCommand({ type: "acknowledge-automated-access" });
    // On success this unmounts when the acknowledged event arrives.
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div>
        <button
          type="button"
          className="button button-sm button-outline"
          disabled={busy}
          onClick={() => void acknowledge()}
        >
          I understand the risk
        </button>
      </div>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function BotForm({
  bot,
  submitLabel,
  onSaved,
  panel = false,
  children,
}: {
  bot: Bot | undefined;
  submitLabel: string;
  onSaved: (bot: Bot) => void;
  // Fills a side panel: the fields scroll and the actions stay pinned below them.
  panel?: boolean;
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
  const [inBox, setInBox] = useState(bot?.boundary === "box");
  const [anySite, setAnySite] = useState(bot?.egressAnySite ?? true);
  const [egressHosts, setEgressHosts] = useState(bot?.egressHosts ?? []);
  const [unattendedLane, setUnattendedLane] = useState<EngineLane>(
    bot?.unattendedLane ?? "api_key",
  );
  const [tokenCap, setTokenCap] = useState(String(bot?.dailyTokenCap ?? ""));
  const [usdCap, setUsdCap] = useState(String(bot?.dailyUsdCap ?? ""));
  const automatedAccessRead = useSyncExternalStore(
    subscribeToConnection,
    () => getConnectionState().chat.automatedAccessAcknowledgedAt !== null,
  );
  const boxes = useSyncExternalStore(
    subscribeToConnection,
    () => getConnectionState().boxAvailability,
  );
  const hostControl = useSyncExternalStore(
    subscribeToConnection,
    () => getConnectionState().hostControl,
  );
  const [control, setControl] = useState<BotControl>(bot?.control ?? "computer");
  const [hostConsent, setHostConsent] = useState(false);
  // Consent is asked each time a bot is moved onto this computer, not again for one already on it.
  const needsConsent = control === "host" && bot?.control !== "host" && !hostConsent;
  const ownScreen = control === "browser" || control === "computer";
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
  const folder = projectPathValue(projectPath);
  const folderChanged = bot !== undefined && folder !== bot.projectPath;
  const botName = name.trim() || "this bot";
  const dailyTokenCap = tokenCap.trim() ? Number(tokenCap) : null;
  const dailyUsdCap = usdCap.trim() ? Number(usdCap) : null;
  const capsChanged =
    bot !== undefined && (dailyTokenCap !== bot.dailyTokenCap || dailyUsdCap !== bot.dailyUsdCap);
  const unsaved =
    bot !== undefined &&
    (name !== bot.name ||
      personality !== bot.personality ||
      model !== bot.model ||
      folderChanged ||
      avatarSeed !== bot.avatarSeed ||
      control !== bot.control ||
      inBox !== (bot.boundary === "box") ||
      anySite !== bot.egressAnySite ||
      egressHosts.join() !== bot.egressHosts.join() ||
      unattendedLane !== bot.unattendedLane ||
      capsChanged ||
      (laneChoice !== undefined && laneChoice !== savedLane));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || !name.trim() || needsConsent) {
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
      projectPath: folder,
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
    const controlResult =
      created && created.control !== control
        ? await postCommand({
            type: "set-bot-control",
            botId: created.id,
            control,
            ...(control === "host" && hostConsent && { hostConsent: true }),
          })
        : undefined;
    const boundary = inBox ? "box" : "host";
    const boundaryResult =
      created && created.boundary !== boundary
        ? await postCommand({ type: "set-bot-boundary", botId: created.id, boundary })
        : undefined;
    const boxed = boundaryResult?.ok ? Bot.safeParse(boundaryResult.body).data : created;
    const egressResult =
      boxed &&
      (ownScreen || inBox) &&
      (boxed.egressAnySite !== anySite ||
        boxed.egressHosts.length !== egressHosts.length ||
        boxed.egressHosts.some((host, index) => host !== egressHosts[index]))
        ? await postCommand({
            type: "set-bot-egress-hosts",
            botId: boxed.id,
            anySite,
            hosts: egressHosts,
          })
        : undefined;
    const unattendedResult =
      boxed && inBox && boxed.unattendedLane !== unattendedLane
        ? await postCommand({
            type: "set-bot-unattended-lane",
            botId: boxed.id,
            lane: unattendedLane,
          })
        : undefined;
    const capResult =
      boxed && capsChanged
        ? await postCommand({ type: "raise-bot-cap", botId: boxed.id, dailyTokenCap, dailyUsdCap })
        : undefined;
    saving.current = false;
    setBusy(false);
    const results = [
      result,
      controlResult,
      boundaryResult,
      egressResult,
      unattendedResult,
      capResult,
    ];
    // The first refusal, so a later step that went through can't hide it.
    const last =
      results.find((step) => step?.ok === false) ??
      results.findLast((step) => step !== undefined) ??
      result;
    const saved = last.ok ? Bot.safeParse(last.body).data : undefined;
    if (saved) {
      onSaved(saved);
    } else {
      setError(last.ok ? "That didn't work. Try again." : last.message);
    }
  }

  return (
    <form
      className={panel ? "flex min-h-0 flex-1 flex-col" : "flex flex-col gap-4"}
      onSubmit={(event) => void submit(event)}
    >
      <div
        className={`flex flex-col gap-4 ${panel ? "min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-6" : ""}`}
      >
        <div className="flex items-center gap-4">
          {/* Keyed so each new face replays the pop. */}
          <Avatar key={avatarSeed} seed={avatarSeed} className="avatar-pop size-16" />
          <button
            type="button"
            aria-label="Shuffle avatar"
            className="button button-icon button-outline"
            onClick={() => setAvatarSeed(shuffledSeed(avatarSeed))}
          >
            <Shuffle {...iconProps} />
          </button>
          <span className="text-caption text-ink-secondary">Shuffle picks a new look.</span>
        </div>
        <label className={fieldClass}>
          <span className="field-label">Name</span>
          <input
            className="field text-ink placeholder:text-ink-faint"
            // Opens with the form, which only ever appears on request.
            autoFocus
            maxLength={80}
            placeholder="For example, Ada"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="flex flex-col gap-1">
          <label className={fieldClass}>
            <span className="field-label">Personality</span>
            <textarea
              className="field min-h-22 resize-none text-ink"
              aria-describedby="personality-help"
              maxLength={4000}
              rows={3}
              value={personality}
              onChange={(event) => setPersonality(event.target.value)}
            />
          </label>
          <p id="personality-help" className="field-help">
            How the bot works and talks. You can change it later.
          </p>
        </div>
        <section className="flex flex-col">
          <h3 className="mb-2 text-title-s font-semibold">More options</h3>
          <Option label="Model" value={findModel(catalog, accountId, model)?.label ?? model}>
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
          </Option>
          {lanes && (
            <Option label="Login" value={lanes[lane]}>
              <div className="flex flex-col gap-1">
                <select
                  className="field text-ink"
                  aria-label="Login"
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
                <p id="lane-help" className="field-help">
                  Applies to every bot on this engine. Log the CLI in this way yourself; Bee Bot
                  never sees the key and pauses bots if the login doesn't match.
                </p>
              </div>
            </Option>
          )}
          <Option label="Where it works" value={controlOptions[control].name}>
            {boxProblem && (
              <Banner title="Private desktop and Browser need boxes">{boxProblem}</Banner>
            )}
            <fieldset className="flex flex-col gap-4">
              <legend className="sr-only">Where it works</legend>
              {controlOrder.map((option) => {
                // A bot already on this computer can always stay or leave.
                const unavailable =
                  option === "host" && bot?.control !== "host" && hostControl?.available !== true;
                const { name: optionName, help, Icon } = controlOptions[option];
                return (
                  <label
                    key={option}
                    className="flex cursor-pointer items-start gap-3 rounded-card border border-edge px-3 py-3.5 transition-colors has-checked:border-focus has-checked:bg-brand-surface has-disabled:cursor-not-allowed has-disabled:border-edge-subtle has-disabled:bg-disabled"
                  >
                    <input
                      type="radio"
                      name="control"
                      className={checkClass}
                      value={option}
                      checked={control === option}
                      disabled={unavailable}
                      onChange={() => setControl(option)}
                    />
                    <Icon
                      aria-hidden
                      size={20}
                      strokeWidth={iconProps.strokeWidth}
                      className={`shrink-0 ${unavailable ? "text-ink-disabled" : "text-ink"}`}
                    />
                    <span className="flex min-w-0 flex-col items-start">
                      <span className={unavailable ? "text-ink-disabled" : "text-ink"}>
                        {optionName}
                      </span>
                      <span
                        className={`text-caption ${unavailable ? "text-ink-disabled" : "text-ink-secondary"}`}
                      >
                        {unavailable
                          ? (hostControl?.problem ?? "Bots can't use this computer from here.")
                          : help}
                      </span>
                      {option === "computer" && (
                        <span className="mt-1 rounded-xs bg-brand-surface px-2 text-label leading-[22px] font-medium text-brand">
                          Recommended
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
              {ownScreen && !boxProblem && (
                <p className="field-help">
                  Every page counts as untrusted content. You can watch and take over.
                </p>
              )}
              {control === "host" && bot?.control !== "host" && (
                <label className="flex items-start gap-2 text-ink">
                  <input
                    type="checkbox"
                    className={checkClass}
                    checked={hostConsent}
                    onChange={(event) => setHostConsent(event.target.checked)}
                  />
                  <span className="flex flex-col">
                    <span>
                      I understand {botName} will see screenshots of my screen, which go to its
                      model provider, and will click and type in my apps. Where it can, it works
                      behind my windows with a pointer of its own; otherwise it briefly uses my
                      mouse and keyboard. It can reach my apps and the accounts I'm signed in to. It
                      works only while I watch, and Take control
                      {stopShortcut && ` (${stopShortcut})`} stops it.
                    </span>
                    <span className="text-caption text-ink-secondary">
                      {submitLabel} stays off until you agree.
                    </span>
                  </span>
                </label>
              )}
            </fieldset>
          </Option>
          <Option label="Run in a box" value={inBox ? "On" : "Off"}>
            <label className="flex items-start gap-4">
              <span className="flex flex-1 flex-col">
                <span className="text-ink">Run in a box</span>
                <span id="box-help" className="text-caption text-ink-secondary">
                  {!inBox && boxProblem
                    ? boxProblem
                    : `${name.trim() || "The bot"} works in its own container, away from your files, so it can run on its own: on a schedule or while you're away.`}
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-describedby="box-help"
                className="relative mt-0.5 h-[18px] w-8 shrink-0 cursor-pointer appearance-none rounded-full bg-edge-strong transition-colors before:absolute before:top-0.5 before:left-0.5 before:size-3.5 before:rounded-full before:bg-card before:transition-transform checked:bg-brand-fill checked:before:translate-x-3.5 disabled:cursor-not-allowed disabled:bg-disabled"
                checked={inBox}
                // A bot in a box can always leave it.
                disabled={!inBox && boxProblem !== undefined}
                onChange={(event) => setInBox(event.target.checked)}
              />
            </label>
            {inBox && (
              <div className="flex flex-col gap-3 text-caption text-ink-secondary">
                {laneAccount && apiKeys.includes(laneAccount) ? (
                  <label className={fieldClass}>
                    <span className="field-label text-ink">On its own, it uses</span>
                    <select
                      className="field text-ink"
                      value={unattendedLane}
                      onChange={(event) => setUnattendedLane(EngineLane.parse(event.target.value))}
                    >
                      <option value="api_key">Your saved API key</option>
                      <option value="subscription" disabled={!automatedAccessRead}>
                        Your subscription, at your own risk
                      </option>
                    </select>
                  </label>
                ) : (
                  <p>
                    No API key is saved for this engine, so on its own it uses your subscription.
                    You can save a key on the Usage page.
                  </p>
                )}
                <AutomatedAccessNotice />
                {!automatedAccessRead && <AcknowledgeRisk />}
              </div>
            )}
          </Option>
          {(ownScreen || inBox) && (
            <Option
              label="Sites it can reach"
              value={
                anySite
                  ? "Any site"
                  : `${egressHosts.length} ${egressHosts.length === 1 ? "site" : "sites"}`
              }
            >
              <fieldset className="flex flex-col gap-3">
                <legend className="sr-only">Sites it can reach</legend>
                <label className="flex items-center gap-2 text-ink">
                  <input
                    type="radio"
                    name="sites"
                    value="any"
                    className="size-4 accent-brand-fill"
                    checked={anySite}
                    onChange={() => setAnySite(true)}
                  />
                  Any site
                </label>
                <label className="flex items-center gap-2 text-ink">
                  <input
                    type="radio"
                    name="sites"
                    value="listed"
                    className="size-4 accent-brand-fill"
                    checked={!anySite}
                    onChange={() => setAnySite(false)}
                  />
                  Only these sites
                </label>
              </fieldset>
              {anySite ? (
                <p className="field-help">
                  Its browser and box reach any public site. Your computer and local network stay
                  out of reach.
                </p>
              ) : (
                <>
                  <HostList hosts={egressHosts} onChange={setEgressHosts} />
                  <p className="field-help">
                    Its browser and box reach only these sites, besides its engine. Each name is
                    exact: www.wikipedia.org doesn't cover en.wikipedia.org.
                  </p>
                </>
              )}
            </Option>
          )}
          {bot && (
            <Option
              label="Daily limit"
              value={dailyLimitLine({ dailyTokenCap, dailyUsdCap }) || "None"}
            >
              {accountId === "claude" && (
                <label className={fieldClass}>
                  <span className="field-label">Tokens a day</span>
                  <input
                    type="number"
                    className="field text-ink placeholder:text-ink-faint"
                    min={1000}
                    max={1e9}
                    step={1}
                    placeholder="No limit"
                    value={tokenCap}
                    onChange={(event) => setTokenCap(event.target.value)}
                  />
                </label>
              )}
              <label className={fieldClass}>
                <span className="field-label">Dollars a day (API key)</span>
                <input
                  type="number"
                  className="field text-ink placeholder:text-ink-faint"
                  min={0.01}
                  max={10_000}
                  step={0.01}
                  placeholder="No limit"
                  value={usdCap}
                  onChange={(event) => setUsdCap(event.target.value)}
                />
              </label>
              <p className="field-help">
                It pauses for the rest of the day once it reaches a limit. Leave blank for no limit.
              </p>
            </Option>
          )}
          <Option label="Folder" value={folder ?? "None"}>
            <div className="flex flex-col gap-1">
              <input
                className="field text-ink placeholder:text-ink-faint"
                aria-label="Project folder (optional)"
                aria-describedby="project-folder-help"
                maxLength={1024}
                spellCheck={false}
                placeholder="Optional"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
              />
              <p id="project-folder-help" className="field-help">
                Bots can read and change files here.
              </p>
            </div>
            {folderChanged && (
              <Banner title={`${botName} starts fresh in the new folder`}>
                Access goes back to Supervised and Always allow is cleared.
              </Banner>
            )}
          </Option>
        </section>
        {accountId === "codex" && <p className="field-help">{codexRulesWarning}</p>}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </div>
      <div
        className={`flex items-center justify-end gap-2 ${panel ? "shrink-0 border-t border-edge-subtle p-4" : ""}`}
      >
        {unsaved && (
          <span className="mr-auto text-caption text-ink-secondary">Unsaved changes</span>
        )}
        {children}
        <button
          type="submit"
          className="button button-primary"
          disabled={busy || !name.trim() || needsConsent}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export function HostList({
  hosts,
  onChange,
}: {
  hosts: string[];
  onChange: (hosts: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const host = draft.trim().toLowerCase();
    if (host && !hosts.includes(host)) {
      onChange([...hosts, host].sort());
    }
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-1">
      {hosts.length > 0 && (
        <ul className="flex flex-col gap-1">
          {hosts.map((host) => (
            <li key={host} className="flex items-center justify-between gap-2 text-ink">
              <span className="min-w-0 truncate">{host}</span>
              <button
                type="button"
                aria-label={`Remove ${host}`}
                className="button button-icon"
                onClick={() => onChange(hosts.filter((other) => other !== host))}
              >
                <X {...iconProps} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <input
          aria-label="Site to allow"
          className="field min-w-0 flex-1 text-ink placeholder:text-ink-faint"
          placeholder="pypi.org"
          spellCheck={false}
          maxLength={253}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="button button-outline"
          disabled={!draft.trim()}
          onClick={add}
        >
          Add
        </button>
      </div>
    </div>
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
      className="fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-panel-wide max-w-full flex-col border-l border-edge-subtle bg-background text-ink shadow-panel backdrop:bg-transparent backdrop:[backdrop-filter:none] open:flex"
      onClose={onClose}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-4">
        <div className="flex min-w-0 flex-1 flex-col">
          {bot && <span className="truncate text-caption text-ink-secondary">{bot.name}</span>}
          <h2 className="text-title-s font-semibold">{bot ? "Edit bot" : "New bot"}</h2>
        </div>
        <button
          type="button"
          aria-label="Close"
          className="button button-icon"
          onClick={() => dialog.current?.close()}
        >
          <X {...iconProps} />
        </button>
      </header>
      <BotForm bot={bot} submitLabel={bot ? "Save" : "Create bot"} onSaved={onSaved} panel>
        <button
          type="button"
          className="button button-outline"
          onClick={() => dialog.current?.close()}
        >
          Cancel
        </button>
      </BotForm>
    </dialog>
  );
}
