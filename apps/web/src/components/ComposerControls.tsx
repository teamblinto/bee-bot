import type { Bot, BotAccess, Effort, ModelCatalog } from "@beebot/contracts";
import {
  Check,
  ChevronDown,
  FilePen,
  Hammer,
  ListChecks,
  type LucideIcon,
  ShieldAlert,
  ShieldCheck,
  Signal,
} from "lucide-react";
import { type CSSProperties, type KeyboardEvent, type ReactNode, useId, useState } from "react";

import { codexRulesWarning } from "../labels";
import { effortLabels, EffortGlyph, resolveEffortGlyph } from "./EffortGlyph";
import { findModel, ModelPicker, pillClass } from "./ModelPicker";
import { Tooltip } from "./Tooltip";
import { iconProps } from "./ui";

export const accessOptions = {
  supervised: {
    label: "Supervised",
    description: "Asks before commands and file edits.",
    Icon: ShieldCheck,
  },
  "auto-edits": {
    label: "Auto-accept edits",
    description: "Edits files without asking. Asks before commands.",
    Icon: FilePen,
  },
  full: {
    label: "Full access",
    description: "Runs any command without asking.",
    Icon: ShieldAlert,
  },
} as const;

const accessLevels = ["supervised", "auto-edits", "full"] as const;

const effortDescriptions: Record<Effort | "default", string> = {
  default: "Balanced.",
  low: "Faster answers, less thinking.",
  medium: "A little more thinking than Low.",
  high: "Thinks longer on hard tasks.",
  xhigh: "Thinks even longer.",
  max: "Thinks as long as it needs.",
};

const modeOptions = {
  build: { label: "Build", description: "Makes changes and runs commands.", Icon: Hammer },
  plan: {
    label: "Plan",
    description: "Proposes a plan first. Changes nothing until you say so.",
    Icon: ListChecks,
  },
} as const;

export type EngineChange = {
  model?: string;
  effort?: Effort | null;
  mode?: Bot["mode"];
  access?: BotAccess;
};

const closeMenu = (item: HTMLElement) => item.closest<HTMLElement>("[popover]")?.hidePopover?.();

function moveFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  event.preventDefault();
  items[(at + step + items.length) % items.length]?.focus();
}

function Menu({
  label,
  tooltip,
  disabled,
  danger = false,
  Icon,
  text,
  textClass,
  section,
  children,
}: {
  label: string;
  tooltip: string;
  disabled: boolean;
  danger?: boolean;
  Icon: ReactNode;
  text: string;
  textClass: string;
  section: string;
  children: ReactNode;
}) {
  const id = useId();
  const anchor = `--menu-${id.replace(/[^\w-]/g, "")}`;
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip label={tooltip}>
        <button
          type="button"
          popoverTarget={id}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={label}
          disabled={disabled}
          className={`${pillClass} ${danger ? "bg-danger-surface text-danger" : ""}`}
          style={{ anchorName: anchor } as CSSProperties}
        >
          {Icon}
          <span className={textClass}>{text}</span>
          <ChevronDown
            aria-hidden
            size={12}
            className={`shrink-0 transition-transform group-aria-expanded:rotate-180 ${danger ? "" : "text-ink-secondary"}`}
          />
        </button>
      </Tooltip>
      <div
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        data-placement="top"
        className="popup menu w-72 p-1"
        style={{ positionAnchor: anchor } as CSSProperties}
        onToggle={({ newState, currentTarget }) => {
          setOpen(newState === "open");
          if (newState === "open") {
            currentTarget.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
          }
        }}
      >
        <div className="px-2 pt-2 pb-1 text-caption text-ink-secondary">{section}</div>
        {children}
      </div>
    </>
  );
}

function MenuItem({
  label,
  description,
  describedBy,
  Icon,
  checked,
  onSelect,
}: {
  label: string;
  description: string;
  describedBy?: string | undefined;
  Icon?: LucideIcon;
  checked: boolean;
  onSelect: () => void;
}) {
  const descriptionId = useId();
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy ? `${descriptionId} ${describedBy}` : descriptionId}
      className="flex min-h-8 w-full items-center gap-2 rounded-row px-2 py-1 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:-outline-offset-2"
      onClick={({ currentTarget }) => {
        if (!checked) {
          onSelect();
        }
        closeMenu(currentTarget);
      }}
    >
      {Icon && <Icon {...iconProps} className="shrink-0 text-ink-secondary" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-s text-ink">{label}</span>
        <span id={descriptionId} className="text-caption text-ink-secondary">
          {description}
        </span>
      </span>
      {checked && <Check {...iconProps} className="shrink-0 text-brand-icon" />}
    </button>
  );
}

function EffortMenu({
  name,
  levels,
  effort,
  disabled,
  onChange,
}: {
  name: string;
  levels: readonly Effort[];
  effort: Effort | null;
  disabled: boolean;
  onChange: (effort: Effort | null) => void;
}) {
  const glyph = resolveEffortGlyph(levels, effort);
  const current = effort ? effortLabels[effort] : "Default";
  return (
    <Menu
      label={`Effort: ${current}`}
      tooltip={`Effort: ${current}`}
      disabled={disabled}
      Icon={
        glyph ? (
          <EffortGlyph {...glyph} />
        ) : (
          <Signal {...iconProps} className="shrink-0 text-ink-secondary" />
        )
      }
      text={`Effort: ${current}`}
      textClass="@max-[540px]:sr-only"
      section={`How long ${name} thinks before answering`}
    >
      <div role="group" aria-label="Effort" onKeyDown={moveFocus}>
        {[null, ...levels].map((level) => (
          <MenuItem
            key={level ?? "default"}
            label={level ? effortLabels[level] : "Default"}
            description={effortDescriptions[level ?? "default"]}
            checked={level === effort}
            onSelect={() => onChange(level)}
          />
        ))}
      </div>
    </Menu>
  );
}

function ModeMenu({
  mode,
  disabled,
  onChange,
}: {
  mode: Bot["mode"];
  disabled: boolean;
  onChange: (mode: Bot["mode"]) => void;
}) {
  const { label, Icon } = modeOptions[mode];
  return (
    <Menu
      label={`Mode: ${label}`}
      tooltip={`Mode: ${label}`}
      disabled={disabled}
      Icon={<Icon {...iconProps} className="shrink-0 text-ink-secondary" />}
      text={label}
      textClass="@max-[540px]:sr-only"
      section="Build makes changes · Plan only proposes them"
    >
      <div role="group" aria-label="Mode" onKeyDown={moveFocus}>
        {(["build", "plan"] as const).map((option) => (
          <MenuItem
            key={option}
            {...modeOptions[option]}
            checked={option === mode}
            onSelect={() => onChange(option)}
          />
        ))}
      </div>
    </Menu>
  );
}

function AccessMenu({
  name,
  access,
  accountId,
  disabled,
  onChange,
}: {
  name: string;
  access: BotAccess;
  accountId: string;
  disabled: boolean;
  onChange: (access: BotAccess) => void;
}) {
  const warningId = useId();
  const { label, description, Icon } = accessOptions[access];
  const warning = accountId === "codex" ? codexRulesWarning : undefined;
  const full = access === "full";
  return (
    <Menu
      label={`Permissions: ${label}`}
      tooltip={`Permissions: ${label}. ${description}${warning ? ` ${warning}` : ""}`}
      disabled={disabled}
      danger={full}
      Icon={<Icon {...iconProps} className={`shrink-0 ${full ? "" : "text-ink-secondary"}`} />}
      text={label}
      textClass="@max-[600px]:sr-only"
      section={`What ${name} can do without asking`}
    >
      <div role="group" aria-label="Permissions" onKeyDown={moveFocus}>
        {accessLevels.map((level) => (
          <MenuItem
            key={level}
            {...accessOptions[level]}
            describedBy={warning ? warningId : undefined}
            checked={level === access}
            onSelect={() => onChange(level)}
          />
        ))}
      </div>
      {warning && (
        <p id={warningId} className="px-2 pt-1 pb-2 text-caption text-ink-secondary">
          {warning}
        </p>
      )}
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
      <h2 className="mb-2 text-title-s font-semibold">Give {name} full access?</h2>
      <p className="mb-2 text-label text-ink-secondary">
        {name} will run commands and edit files without asking you, while you're attending the run.
      </p>
      <p className="mb-4 text-label text-ink-secondary">
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
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
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
        <EffortMenu
          name={bot.name}
          levels={levels}
          effort={bot.effort}
          disabled={!connected}
          onChange={(effort) => onChange({ effort })}
        />
      )}
      <ModeMenu mode={bot.mode} disabled={!connected} onChange={(mode) => onChange({ mode })} />
      <AccessMenu
        name={bot.name}
        access={bot.access}
        accountId={bot.engineAccountId}
        disabled={!connected}
        onChange={(access) => onChange({ access })}
      />
    </div>
  );
}
