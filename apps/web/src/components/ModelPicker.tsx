import type { EngineModel, ModelCatalog } from "@beebot/contracts";
import { Check, ChevronDown, Cpu, FlaskConical, Search, Star } from "lucide-react";
import {
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  type SVGProps,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { favoriteKey, toggleFavorite, useModelFavorites } from "../modelFavorites";
import { ClaudeLogo, OpenAILogo } from "./Logos";
import { rankModelSearch } from "./modelPickerSearch";
import { Tooltip } from "./Tooltip";

type Provider = {
  id: string;
  label: string;
  Logo: ComponentType<SVGProps<SVGSVGElement>>;
  // Stays in the rail, and keyboard reachable, to say why it can't be used.
  disabledReason?: string;
};

const claude: Provider = { id: "claude", label: "Claude", Logo: ClaudeLogo };
const testEngine: Provider = { id: "fake", label: "Test engine", Logo: FlaskConical };
const codex: Provider = { id: "codex", label: "Codex", Logo: OpenAILogo };

const lockedReason = (label: string) =>
  `${label} is unavailable here. A bot keeps the provider it was created with.`;

const providerOf = (accountId: string) =>
  [testEngine, codex].find(({ id }) => id === accountId) ?? claude;

export const providerLabel = (accountId: string) => providerOf(accountId).label;

function providersFor(catalog: ModelCatalog | undefined) {
  return [
    claude,
    ...(import.meta.env.DEV && catalog?.fake ? [testEngine] : []),
    catalog?.codex?.length
      ? codex
      : { ...codex, disabledReason: "Codex isn't available on this computer" },
  ];
}

export const findModel = (
  catalog: ModelCatalog | undefined,
  accountId: string,
  model: string,
): EngineModel | undefined => catalog?.[accountId]?.find(({ id }) => id === model);

export const isUnavailable = (
  catalog: ModelCatalog | undefined,
  accountId: string,
  model: string,
) => catalog !== undefined && !findModel(catalog, accountId, model);

type Row = EngineModel & { accountId: string; unavailable: boolean };

const showMoreKey = "show-more";
// Pinned versions. The short aliases always follow the newest one.
const isOlderModel = ({ id }: EngineModel) => id.startsWith("claude-");

const tabClass =
  "flex h-9 shrink-0 items-center gap-2 rounded-xs px-3 text-body-s font-medium text-ink-secondary transition-colors hover:text-ink focus-visible:-outline-offset-2 aria-pressed:text-ink aria-pressed:shadow-[inset_0_-2px_0_var(--color-brand-fill)] aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:text-ink-secondary";

// The composer's labelled setting: icon, label, chevron, opening a menu above.
export const pillClass =
  "composer-control group gap-1 rounded-full font-medium text-ink disabled:text-ink-disabled aria-expanded:bg-hover";

function Tabs({
  tab,
  providers,
  lockedTo,
  onSelect,
  onFocusSearch,
}: {
  tab: string;
  providers: Provider[];
  lockedTo: string | undefined;
  onSelect: (tab: string) => void;
  onFocusSearch: () => void;
}) {
  const reasonFor = ({ id, label, disabledReason }: Provider) =>
    disabledReason ?? (lockedTo && id !== lockedTo ? lockedReason(label) : undefined);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...event.currentTarget.querySelectorAll("button")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      onFocusSearch();
    } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      buttons.at(event.key === "Home" ? 0 : -1)?.focus();
    }
  }

  return (
    <div
      role="toolbar"
      aria-label="Providers"
      data-model-picker-tabs
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-edge-subtle [scrollbar-width:none]"
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        aria-pressed={tab === "favorites"}
        tabIndex={tab === "favorites" ? 0 : -1}
        aria-label="Favorites"
        className={tabClass}
        onClick={() => onSelect("favorites")}
      >
        <Star aria-hidden size={16} />
        Favorites
      </button>
      {providers.map((provider) => {
        const { id, label } = provider;
        const reason = reasonFor(provider);
        return (
          <Tooltip key={id} label={reason ?? label} className="flex">
            <button
              type="button"
              aria-label={reason ?? label}
              aria-pressed={tab === id}
              aria-disabled={reason !== undefined}
              tabIndex={tab === id ? 0 : -1}
              className={tabClass}
              onClick={() => {
                if (!reason) {
                  onSelect(id);
                }
              }}
            >
              {label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ModelRow({
  row,
  id,
  active,
  selected,
  favorite,
  onPick,
  onHover,
}: {
  row: Row;
  id: string;
  active: boolean;
  selected: boolean;
  favorite: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  const { label, accountId, unavailable } = row;
  const { Logo } = providerOf(accountId);
  const starLabel = `${favorite ? "Remove" : "Add"} ${label} ${favorite ? "from" : "to"} favorites`;
  return (
    <div
      role="none"
      data-active={active}
      className="flex min-h-8 items-center gap-2 rounded-row py-1 pr-1 pl-2 data-[active=true]:bg-hover"
      onMouseMove={onHover}
    >
      <div
        id={id}
        role="option"
        aria-selected={selected}
        aria-disabled={unavailable}
        tabIndex={-1}
        className="flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 aria-disabled:cursor-not-allowed"
        onClick={onPick}
      >
        <Logo aria-hidden width={16} height={16} className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body-s text-ink">
            {label}
            <span className="sr-only">, {providerLabel(accountId)}</span>
          </span>
          {unavailable && <span className="text-caption text-ink-secondary">Unavailable</span>}
        </span>
        {selected && <Check aria-hidden size={16} className="shrink-0 text-brand-icon" />}
      </div>
      <Tooltip label={starLabel}>
        <button
          type="button"
          aria-label={starLabel}
          aria-pressed={favorite}
          className="flex size-6 shrink-0 items-center justify-center rounded-field text-ink-secondary transition-colors hover:bg-hover hover:text-ink aria-pressed:bg-brand-surface aria-pressed:text-brand-icon"
          onClick={() => toggleFavorite(favoriteKey(accountId, row.id))}
        >
          <Star aria-hidden size={16} />
        </button>
      </Tooltip>
    </div>
  );
}

function UnavailableBadge() {
  return (
    <span className="inline-flex h-[22px] shrink-0 items-center rounded-xs bg-raised px-2 text-label font-medium text-ink">
      Unavailable
    </span>
  );
}

export function ModelPickerContent({
  accountId,
  model,
  catalog,
  locked,
  searchRef,
  onPick,
  onClose,
}: {
  accountId: string;
  model: string;
  catalog: ModelCatalog | undefined;
  locked: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  onPick: (accountId: string, model: string) => void;
  onClose: () => void;
}) {
  const favorites = useModelFavorites();
  const providers = providersFor(catalog);
  const lockedTo = locked ? accountId : undefined;
  const selectedKey = favoriteKey(accountId, model);
  const [tab, setTab] = useState(() => (favorites.includes(selectedKey) ? "favorites" : accountId));
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState<string>();
  const [showOlder, setShowOlder] = useState(false);
  const listId = useId();

  const known: Row[] = providers.flatMap(({ id, disabledReason }) =>
    disabledReason || (lockedTo && id !== lockedTo)
      ? []
      : (catalog?.[id] ?? []).map((entry) => ({ ...entry, accountId: id, unavailable: false })),
  );
  // A model that left the catalog is shown as it is, so nothing looks silently swapped.
  const saved: Row = { id: model, label: model, efforts: [], accountId, unavailable: true };
  const rows = isUnavailable(catalog, accountId, model) ? [saved, ...known] : known;
  const keyOf = (row: Row) => favoriteKey(row.accountId, row.id);
  const isFavorite = (row: Row) => favorites.includes(keyOf(row));

  function shownRows() {
    if (query.trim()) {
      return rankModelSearch(rows, query, (row) => ({
        accountId: row.accountId,
        providerLabel: providerLabel(row.accountId),
        name: row.label,
        id: row.id,
        isFavorite: isFavorite(row),
      }));
    }
    return tab === "favorites"
      ? rows.filter(isFavorite)
      : rows
          .filter((row) => row.accountId === tab)
          .toSorted((a, b) => Number(isFavorite(b)) - Number(isFavorite(a)));
  }
  const matching = shownRows();
  const collapsible = !query.trim() && tab !== "favorites" && matching.some(isOlderModel);
  const shown =
    collapsible && !showOlder
      ? matching.filter(
          (row) => !isOlderModel(row) || isFavorite(row) || keyOf(row) === selectedKey,
        )
      : matching;
  const keys = [...shown.map(keyOf), ...(collapsible ? [showMoreKey] : [])];
  const fallback = !query.trim() && keys.includes(selectedKey) ? selectedKey : keys[0];
  const active = highlight !== undefined && keys.includes(highlight) ? highlight : fallback;
  const optionId = (key: string) => `${listId}-${key.replace(/[^\w-]/g, "_")}`;

  function pick(row: Row | undefined) {
    if (row && !row.unavailable) {
      onPick(row.accountId, row.id);
      onClose();
    }
  }

  function moveHighlight(step: number) {
    if (keys.length === 0) {
      return;
    }
    const at = active === undefined ? -1 : keys.indexOf(active);
    const next = keys[(at + step + keys.length) % keys.length] ?? keys[0];
    setHighlight(next);
    if (next) {
      document.getElementById(optionId(next))?.scrollIntoView?.({ block: "nearest" });
    }
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      // The picker sits inside a form: Enter here must never send or save it.
      event.preventDefault();
      if (active === showMoreKey) {
        setShowOlder(!showOlder);
      } else {
        pick(shown.find((row) => keyOf(row) === active));
      }
    }
  }

  const empty = !query.trim() && tab === "favorites" ? "No favorites yet" : "No models found";

  return (
    <div
      data-model-picker
      className="flex h-[312px] max-h-[calc(100vh-32px)] w-[min(360px,calc(100vw-32px))] flex-col gap-2 overflow-hidden p-2"
    >
      <label className="flex h-8 shrink-0 items-center gap-2 rounded-field border border-edge-strong px-2 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-1 has-[input:focus-visible]:outline-focus">
        <Search aria-hidden size={16} className="shrink-0 text-ink-secondary" />
        <input
          ref={searchRef}
          type="text"
          role="combobox"
          aria-label="Search models"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active && keys.length > 0 ? optionId(active) : undefined}
          placeholder="Search models"
          className="w-full bg-transparent text-body-s outline-none placeholder:text-ink-faint"
          value={query}
          onChange={({ target }) => {
            setQuery(target.value);
            setHighlight(undefined);
          }}
          onKeyDown={onSearchKey}
        />
      </label>
      <Tabs
        tab={tab}
        providers={providers}
        lockedTo={lockedTo}
        onFocusSearch={() => searchRef.current?.focus()}
        onSelect={(next) => {
          setTab(next);
          setQuery("");
          setHighlight(undefined);
          searchRef.current?.focus();
        }}
      />
      <div
        id={listId}
        role="listbox"
        aria-label="Models"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {shown.map((row) => {
          const key = keyOf(row);
          return (
            <ModelRow
              key={key}
              row={row}
              id={optionId(key)}
              active={key === active}
              selected={key === selectedKey}
              favorite={isFavorite(row)}
              onPick={() => pick(row)}
              onHover={() => setHighlight(key)}
            />
          );
        })}
        {collapsible && (
          <div
            id={optionId(showMoreKey)}
            role="option"
            aria-selected={false}
            aria-expanded={showOlder}
            tabIndex={-1}
            data-active={active === showMoreKey}
            className="flex min-h-8 cursor-pointer items-center rounded-row px-2 text-body-s text-ink-secondary hover:text-ink data-[active=true]:bg-hover"
            onClick={() => setShowOlder(!showOlder)}
            onMouseMove={() => setHighlight(showMoreKey)}
          >
            {showOlder ? "Show less" : "Show more"}
          </div>
        )}
        {shown.length === 0 && (
          <p className="px-2 py-1.5 text-body-s text-ink-secondary">{empty}</p>
        )}
      </div>
    </div>
  );
}

// Holds the page still behind the open picker. Scrolling stays inside the picker itself.
function lockBackgroundWheel(signal: AbortSignal) {
  document.addEventListener(
    "wheel",
    (event) => {
      const inside = event.target instanceof Element && event.target.closest("[data-model-picker]");
      if (!inside) {
        event.preventDefault();
      }
    },
    { capture: true, passive: false, signal },
  );
}

export function ModelPicker({
  accountId,
  model,
  catalog,
  locked,
  disabled = false,
  field = false,
  onPick,
}: {
  accountId: string;
  model: string;
  catalog: ModelCatalog | undefined;
  locked: boolean;
  disabled?: boolean;
  // Sits in a form, as a full-width field, instead of in the composer's footer.
  field?: boolean;
  onPick: (accountId: string, model: string) => void;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const wheelLock = useRef<AbortController>(undefined);
  const [opened, setOpened] = useState(0);
  const [open, setOpen] = useState(false);
  const id = useId();
  const anchor = `--picker-${id.replace(/[^\w-]/g, "")}`;
  const unavailable = isUnavailable(catalog, accountId, model);
  const label = findModel(catalog, accountId, model)?.label ?? model;
  const { Logo } = providerOf(accountId);

  useEffect(() => () => wheelLock.current?.abort(), []);

  function onToggle(open: boolean) {
    wheelLock.current?.abort();
    setOpen(open);
    if (open) {
      wheelLock.current = new AbortController();
      lockBackgroundWheel(wheelLock.current.signal);
      search.current?.focus();
    } else {
      setOpened((count) => count + 1);
    }
  }

  return (
    <>
      <Tooltip
        label={unavailable ? `${label} (Unavailable)` : label}
        {...(field && { className: "block" })}
      >
        <button
          type="button"
          popoverTarget={id}
          disabled={disabled}
          aria-label={`Model: ${label}${unavailable ? " (Unavailable)" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-model-picker-trigger
          className={field ? "field flex items-center gap-2 text-left text-ink" : pillClass}
          style={{ anchorName: anchor } as CSSProperties}
        >
          {field ? (
            <Logo aria-hidden width={16} height={16} className="shrink-0" />
          ) : (
            <Cpu aria-hidden size={16} className="shrink-0 text-ink-secondary" />
          )}
          <span className="min-w-0 truncate">{label}</span>
          {unavailable && <UnavailableBadge />}
          {field ? (
            <ChevronDown aria-hidden size={16} className="ml-auto shrink-0 opacity-60" />
          ) : (
            <ChevronDown
              aria-hidden
              size={12}
              className="shrink-0 text-ink-secondary transition-transform group-aria-expanded:rotate-180"
            />
          )}
        </button>
      </Tooltip>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="dialog"
        aria-label="Choose a model"
        data-placement={field ? "bottom" : "top"}
        className="popup menu overflow-hidden"
        style={{ positionAnchor: anchor } as CSSProperties}
        onToggle={(event) => onToggle(event.newState === "open")}
      >
        {/* Remounted on close, so each opening starts from the saved choice with an empty search. */}
        <ModelPickerContent
          key={`${accountId}:${model}:${opened}`}
          accountId={accountId}
          model={model}
          catalog={catalog}
          locked={locked}
          searchRef={search}
          onPick={onPick}
          onClose={() => popup.current?.hidePopover()}
        />
      </div>
    </>
  );
}
