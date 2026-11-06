import type { EngineModel, ModelCatalog } from "@beebot/contracts";
import { Check, ChevronDown, FlaskConical, Search, Star } from "lucide-react";
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

const railButtonClass =
  "relative flex aspect-square w-full items-center justify-center rounded-field transition-colors hover:bg-raised focus-visible:bg-raised focus-visible:-outline-offset-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent";

// Rail geometry, so the selection marker can move with `transform` alone.
const railPadding = 4;
const railButton = 36;
const railGap = 4;
const railDivider = 1;
const markerHeight = 20;
const markerOffset = (index: number) => {
  const firstProvider = railPadding + railButton + railGap + railDivider + railGap;
  const top = index === 0 ? railPadding : firstProvider + (index - 1) * (railButton + railGap);
  return top + railButton / 2 - markerHeight / 2;
};

function Rail({
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
  const tabs = ["favorites", ...providers.map(({ id }) => id)];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = [...event.currentTarget.querySelectorAll("button")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowRight") {
      event.preventDefault();
      onFocusSearch();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
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
      aria-orientation="vertical"
      data-model-picker-rail
      className="relative flex w-11 shrink-0 flex-col gap-1 overflow-y-auto bg-raised/30 p-1 [scrollbar-width:none]"
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute top-0 right-1 z-10 h-5 w-[3px] rounded-full bg-honey-fill transition-transform duration-200"
        style={{ transform: `translateY(${markerOffset(tabs.indexOf(tab))}px)` }}
      />
      <Tooltip label="Favorites" side="left" className="block w-full">
        <button
          type="button"
          aria-label="Favorites"
          aria-pressed={tab === "favorites"}
          tabIndex={tab === "favorites" ? 0 : -1}
          className={railButtonClass}
          onClick={() => onSelect("favorites")}
        >
          <Star size={20} fill="currentColor" aria-hidden />
        </button>
      </Tooltip>
      <div aria-hidden className="border-b border-edge" />
      {providers.map((provider) => {
        const { id, label, Logo } = provider;
        const reason = reasonFor(provider);
        return (
          <Tooltip key={id} label={reason ?? label} side="left" className="block w-full">
            <button
              type="button"
              aria-label={reason ?? label}
              aria-pressed={tab === id}
              aria-disabled={reason !== undefined}
              tabIndex={tab === id ? 0 : -1}
              className={railButtonClass}
              onClick={() => {
                if (!reason) {
                  onSelect(id);
                }
              }}
            >
              <Logo aria-hidden width={20} height={20} />
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
  starOnHover,
  onPick,
  onHover,
}: {
  row: Row;
  id: string;
  active: boolean;
  selected: boolean;
  favorite: boolean;
  starOnHover: boolean;
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
      className="group flex min-h-8 items-center gap-1 rounded-row px-2 data-[active=true]:bg-raised"
      onMouseMove={onHover}
    >
      <div
        id={id}
        role="option"
        aria-selected={selected}
        aria-disabled={unavailable}
        tabIndex={-1}
        className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 text-name aria-disabled:cursor-not-allowed"
        onClick={onPick}
      >
        <Logo aria-hidden width={16} height={16} className="shrink-0" />
        <span className="min-w-0 truncate">
          {label}
          <span className="sr-only">, {providerLabel(accountId)}</span>
        </span>
        {selected && <Check aria-hidden size={14} className="shrink-0" />}
        {unavailable && <UnavailableBadge />}
      </div>
      <Tooltip label={starLabel}>
        <button
          type="button"
          aria-label={starLabel}
          aria-pressed={favorite}
          className="flex size-6 items-center justify-center rounded-field text-ink-faint transition-colors hover:bg-hover hover:text-ink"
          onClick={() => toggleFavorite(favoriteKey(accountId, row.id))}
        >
          <Star
            aria-hidden
            size={12}
            fill={favorite ? "currentColor" : "none"}
            className={`${favorite ? "text-honey" : ""} ${
              !favorite || starOnHover
                ? "opacity-0 group-hover:opacity-100 group-data-[active=true]:opacity-100 in-focus-visible:opacity-100 pointer-coarse:opacity-100"
                : ""
            }`}
          />
        </button>
      </Tooltip>
    </div>
  );
}

function UnavailableBadge() {
  return (
    <span className="shrink-0 rounded-full border border-edge-strong px-1.5 text-micro text-ink-secondary">
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

  function focusRail(input: HTMLInputElement) {
    input
      .closest("[data-model-picker]")
      ?.querySelector<HTMLElement>('[data-model-picker-rail] button[aria-pressed="true"]')
      ?.focus();
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    const empty = event.currentTarget.value.length === 0;
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
    } else if ((event.key === "ArrowLeft" && empty) || (event.key === "Tab" && event.shiftKey)) {
      event.preventDefault();
      focusRail(event.currentTarget);
    }
  }

  const empty = !query.trim() && tab === "favorites" ? "No favorites yet" : "No models found";

  return (
    <div
      data-model-picker
      className="flex h-[346px] max-h-[calc(100vh-32px)] w-[min(360px,calc(100vw-32px))] flex-row overflow-hidden"
    >
      <Rail
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-edge bg-raised/40">
        <div className="mx-3 mt-2.5 flex shrink-0 items-center gap-2 border-b border-edge pb-1.5 transition-colors has-[input:focus]:border-honey">
          <Search aria-hidden size={14} className="shrink-0 text-ink-faint" />
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-label="Search models"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active && keys.length > 0 ? optionId(active) : undefined}
            placeholder="Search models..."
            className="h-6 w-full bg-transparent text-name outline-none"
            value={query}
            onChange={({ target }) => {
              setQuery(target.value);
              setHighlight(undefined);
            }}
            onKeyDown={onSearchKey}
          />
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Models"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
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
                starOnHover={tab === "favorites" && !query.trim()}
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
              className="flex min-h-8 cursor-pointer items-center rounded-row px-2 text-name text-ink-secondary hover:text-ink data-[active=true]:bg-raised"
              onClick={() => setShowOlder(!showOlder)}
              onMouseMove={() => setHighlight(showMoreKey)}
            >
              {showOlder ? "Show less" : "Show more"}
            </div>
          )}
          {shown.length === 0 && (
            <p className="px-2 py-1.5 text-small text-ink-secondary">{empty}</p>
          )}
        </div>
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
  const id = useId();
  const anchor = `--picker-${id.replace(/[^\w-]/g, "")}`;
  const unavailable = isUnavailable(catalog, accountId, model);
  const label = findModel(catalog, accountId, model)?.label ?? model;
  const { Logo } = providerOf(accountId);

  useEffect(() => () => wheelLock.current?.abort(), []);

  function onToggle(open: boolean) {
    wheelLock.current?.abort();
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
          data-model-picker-trigger
          className={
            field ? "field flex items-center gap-2 text-left text-ink" : "composer-control"
          }
          style={{ anchorName: anchor } as CSSProperties}
        >
          <Logo aria-hidden width={16} height={16} className="shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
          {unavailable && <UnavailableBadge />}
          {field && <ChevronDown aria-hidden size={16} className="ml-auto shrink-0 opacity-60" />}
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
