import type { Bot, BotAccess, Effort, ModelCatalog } from "@beebot/contracts";
import {
  Bot as BotIcon,
  Check,
  ChevronDown,
  Lock,
  PencilLine,
  PencilRuler,
  ShieldOff,
} from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useId, useState } from "react";

import { codexRulesWarning } from "../labels";
import { effortLabels, EffortGlyph, resolveEffortGlyph } from "./EffortGlyph";
import { findModel, ModelPicker } from "./ModelPicker";
import { Tooltip } from "./Tooltip";
import { iconProps } from "./ui";

export const accessOptions = {
  supervised: {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    Icon: Lock,
  },
  "auto-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    Icon: PencilLine,
  },
  full: {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    // An open lock reads like a closed one at small sizes; a crossed shield does not.
    Icon: ShieldOff,
  },
} as const;

const accessLevels = ["supervised", "auto-edits", "full"] as const;

export type EngineChange = {
  model?: string;
  effort?: Effort | null;
  mode?: Bot["mode"];
  access?: BotAccess;
};

const closeMenu = (item: HTMLElement) => item.closest<HTMLElement>("[popover]")?.hidePopover?.();

function moveFocus(event: KeyboardEvent<HTMLElement>, keys: { next: string; previous: string }) {
  if (event.key !== keys.next && event.key !== keys.previous) {
    return;
  }
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const step = event.key === keys.next ? 1 : -1;
  event.preventDefault();
  items[(at + step + items.length) % items.length]?.focus();
}

function Menu({
  label,
  tooltip,
  disabled,
  trigger,
  children,
}: {
  label: string;
  tooltip: string;
  disabled: boolean;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const anchor = `--menu-${id.replace(/[^\w-]/g, "")}`;
  return (
    <>
      <Tooltip label={tooltip}>
        <button
          type="button"
          popoverTarget={id}
          aria-haspopup="menu"
          aria-label={label}
          disabled={disabled}
          className="composer-control"
          style={{ anchorName: anchor } as CSSProperties}
        >
          {trigger}
        </button>
      </Tooltip>
      <div
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        data-placement="top"
        className="popup menu"
        style={{ positionAnchor: anchor } as CSSProperties}
        onToggle={({ newState, currentTarget }) => {
          if (newState === "open") {
            currentTarget.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
          }
        }}
      >
        {children}
      </div>
    </>
  );
}

function ReasoningMenu({
  levels,
  effort,
  disabled,
  onChange,
}: {
  levels: readonly Effort[];
  effort: Effort | null;
  disabled: boolean;
  onChange: (effort: Effort | null) => void;
}) {
  const glyph = resolveEffortGlyph(levels, effort);
  const current = effort ? effortLabels[effort] : "Default";
  const options = [null, ...levels];
  return (
    <Menu
      label={`Reasoning: ${current}`}
      tooltip={`Reasoning: ${current}`}
      disabled={disabled}
      trigger={
        <>
          {glyph && <EffortGlyph {...glyph} />}
          <span className="@max-[380px]:sr-only">{current}</span>
          <ChevronDown {...iconProps} size={14} className="opacity-60" />
        </>
      }
    >
      <div
        role="group"
        aria-label="Reasoning"
        className="flex w-40 flex-col gap-0.5 p-1"
        onKeyDown={(event) => moveFocus(event, { next: "ArrowDown", previous: "ArrowUp" })}
      >
        {options.map((level) => (
          <button
            key={level ?? "default"}
            type="button"
            role="menuitemradio"
            aria-checked={level === effort}
            className="flex h-8 items-center gap-2 rounded-field px-2 text-left text-small transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:-outline-offset-2"
            onClick={({ currentTarget }) => {
              if (level !== effort) {
                onChange(level);
              }
              closeMenu(currentTarget);
            }}
          >
            <span className="flex-1">{level ? effortLabels[level] : "Default"}</span>
            {level === effort && <Check {...iconProps} size={14} />}
          </button>
        ))}
      </div>
    </Menu>
  );
}

function AccessMenu({
  access,
  accountId,
  disabled,
  onChange,
}: {
  access: BotAccess;
  accountId: string;
  disabled: boolean;
  onChange: (access: BotAccess) => void;
}) {
  // Hover or keyboard focus previews a level's name and description before a pick.
  const [preview, setPreview] = useState<BotAccess>();
  const descriptionId = useId();
  const { label, description, Icon } = accessOptions[access];
  const shown = accessOptions[preview ?? access];
  const warning = accountId === "codex" ? codexRulesWarning : undefined;
  const warningId = `${descriptionId}-rules`;
  return (
    <Menu
      label={`Permissions: ${label}`}
      tooltip={`Permissions: ${label}. ${description}${warning ? ` ${warning}` : ""}`}
      disabled={disabled}
      trigger={
        <>
          <Icon {...iconProps} className={access === "full" ? "text-danger" : "opacity-70"} />
          <span className="@max-[460px]:sr-only">{label}</span>
        </>
      }
    >
      <div className="grid w-72 gap-1.5 px-2 py-1.5">
        <div className="text-label font-medium text-ink-secondary">Permissions</div>
        <div
          role="group"
          aria-label="Permissions"
          className="flex rounded-row bg-raised/60 p-0.5"
          onKeyDown={(event) => moveFocus(event, { next: "ArrowRight", previous: "ArrowLeft" })}
        >
          {accessLevels.map((level) => {
            const option = accessOptions[level];
            return (
              <button
                key={level}
                type="button"
                role="menuitemradio"
                aria-checked={level === access}
                aria-label={option.label}
                aria-describedby={`${descriptionId}-${level}${warning ? ` ${warningId}` : ""}`}
                className="flex h-6 flex-1 items-center justify-center rounded-field text-ink-secondary outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 aria-checked:bg-card aria-checked:text-ink aria-checked:shadow-composer"
                onPointerEnter={() => setPreview(level)}
                onPointerLeave={() => setPreview(undefined)}
                onFocus={() => setPreview(level)}
                onBlur={() => setPreview(undefined)}
                onClick={({ currentTarget }) => {
                  if (level !== access) {
                    onChange(level);
                  }
                  closeMenu(currentTarget);
                }}
              >
                <option.Icon {...iconProps} size={14} />
              </button>
            );
          })}
        </div>
        {accessLevels.map((level) => (
          <span key={level} id={`${descriptionId}-${level}`} className="sr-only">
            {accessOptions[level].description}
          </span>
        ))}
        <div aria-hidden className="grid gap-0.5">
          <span
            className={`text-small ${preview && preview !== access ? "text-ink-secondary" : ""}`}
          >
            {shown.label}
          </span>
          {/* Two lines reserved so the menu doesn't shift during a preview. */}
          <span className="min-h-8 text-label text-ink-secondary">{shown.description}</span>
        </div>
        {warning && (
          <p id={warningId} className="text-label text-ink-secondary">
            {warning}
          </p>
        )}
      </div>
    </Menu>
  );
}

export function FullAccessDialog({
  name,
  onConfirm,
  onCancel,
}: {
  name: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <dialog
      ref={(node) => {
        if (node && !node.open) {
          node.showModal?.();
        }
      }}
      aria-label="Allow full access"
      className="dialog m-auto w-[min(420px,calc(100vw-32px))] p-5 backdrop:bg-scrim"
      onCancel={onCancel}
    >
      <h2 className="mb-2 text-title font-semibold">Give {name} full access?</h2>
      <p className="mb-2 text-small text-ink-secondary">
        {name} will run commands and edit files without asking you, while you're attending the run.
      </p>
      <p className="mb-4 text-small text-ink-secondary">
        Bash can't be path-checked, and it runs on this computer with your permissions. Forbidden
        paths stay refused for the file tools.
      </p>
      <div className="flex justify-end gap-1">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button button-primary" onClick={onConfirm}>
          Allow full access
        </button>
      </div>
    </dialog>
  );
}

const modeTooltips = {
  plan: "Plan mode. Click to return to normal build mode",
  build: "Default mode. Click to enter plan mode",
};

export function ComposerControls({
  bot,
  catalog,
  connected,
  onChange,
}: {
  bot: Bot;
  catalog: ModelCatalog | undefined;
  connected: boolean;
  onChange: (change: EngineChange) => void;
}) {
  const levels = findModel(catalog, bot.engineAccountId, bot.model)?.efforts ?? [];
  const plan = bot.mode === "plan";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      <ModelPicker
        accountId={bot.engineAccountId}
        model={bot.model}
        catalog={catalog}
        locked
        disabled={!connected}
        onPick={(_, model) => {
          if (model !== bot.model) {
            onChange({ model });
          }
        }}
      />
      {levels.length > 0 && (
        <ReasoningMenu
          levels={levels}
          effort={bot.effort}
          disabled={!connected}
          onChange={(effort) => onChange({ effort })}
        />
      )}
      <Tooltip label={modeTooltips[bot.mode]}>
        <button
          type="button"
          aria-pressed={plan}
          aria-label={modeTooltips[bot.mode]}
          disabled={!connected}
          className="composer-control"
          onClick={() => onChange({ mode: plan ? "build" : "plan" })}
        >
          {plan ? (
            <PencilRuler {...iconProps} />
          ) : (
            <BotIcon {...iconProps} className="opacity-70" />
          )}
          <span className="@max-[380px]:sr-only">{plan ? "Plan" : "Build"}</span>
        </button>
      </Tooltip>
      <AccessMenu
        access={bot.access}
        accountId={bot.engineAccountId}
        disabled={!connected}
        onChange={(access) => onChange({ access })}
      />
    </div>
  );
}
