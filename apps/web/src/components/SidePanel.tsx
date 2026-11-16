import { Ellipsis, type LucideIcon, X } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef } from "react";

import { iconProps } from "./ui";

export const badgeClass =
  "inline-flex h-[22px] shrink-0 items-center rounded-xs bg-raised px-2 text-label text-ink";
export const checkboxClass = "mt-0.5 size-4 shrink-0 accent-brand-fill";
export const fieldLabelClass = "field-label flex flex-col gap-1.5";
export const errorClass = "text-label text-danger";

const menuItemClass =
  "flex h-8 w-full items-center gap-2 rounded-row px-2 text-left text-body-s transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:text-ink-disabled";

// Figma "Side panel": the bot's tools open beside the chat. Modal, so focus and Escape stay in it.
export function SidePanel<Tab extends string>({
  label,
  botName,
  title,
  wide,
  tabs,
  tab,
  onTab,
  footer,
  onClose,
  children,
}: {
  label: string;
  botName: string;
  title: string;
  wide?: boolean;
  tabs?: { id: Tab; label: string; count?: number }[];
  tab?: Tab;
  onTab?: (tab: Tab) => void;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
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
      aria-label={label}
      className={`m-0 ml-auto h-dvh max-h-none max-w-full flex-col border-l border-edge-subtle bg-background text-ink shadow-panel backdrop:bg-transparent backdrop:[backdrop-filter:none] open:flex max-[900px]:w-full ${wide ? "w-panel-wide" : "w-panel"}`}
      onClose={onClose}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-caption text-ink-secondary">{botName}</p>
          <h2 className="truncate text-title-s font-semibold">{title}</h2>
        </div>
        <button
          type="button"
          className="button button-icon"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
        >
          <X {...iconProps} />
        </button>
      </header>
      {tabs && (
        <div role="tablist" className="flex shrink-0 gap-1 border-b border-edge-subtle px-3">
          {tabs.map(({ id, label: name, count }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={id === tab}
              className={`relative flex h-9 items-center gap-2 px-2 text-body-s font-medium transition-colors hover:text-ink ${id === tab ? "text-ink" : "text-ink-secondary"}`}
              onClick={() => onTab?.(id)}
            >
              {name}
              {count !== undefined && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-raised px-1.5 text-label text-ink-secondary">
                  {count}
                </span>
              )}
              {id === tab && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-brand-fill" />}
            </button>
          ))}
        </div>
      )}
      <div
        role={tabs ? "tabpanel" : undefined}
        className="scroller flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
      >
        {children}
      </div>
      {footer && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-edge-subtle p-4">
          {footer}
        </div>
      )}
    </dialog>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <span className="mb-1 flex size-10 items-center justify-center rounded-full bg-raised text-ink-secondary">
        <Icon {...iconProps} size={20} />
      </span>
      <p className="text-title-s font-semibold">{title}</p>
      {children}
    </div>
  );
}

export function RowMenu({
  label,
  items,
}: {
  label: string;
  items: { label: string; danger?: boolean; disabled?: boolean; onSelect: () => void }[];
}) {
  const id = useId();
  const anchor = `--row-menu-${id.replace(/[^\w-]/g, "")}`;
  return (
    <>
      <button
        type="button"
        popoverTarget={id}
        aria-haspopup="menu"
        aria-label={label}
        className="button button-icon button-sm shrink-0"
        style={{ anchorName: anchor } as CSSProperties}
      >
        <Ellipsis {...iconProps} />
      </button>
      <div
        id={id}
        popover="auto"
        role="menu"
        aria-label={label}
        className="menu m-0 mt-1 w-40 p-1 [position-area:bottom_span-left]"
        style={{ positionAnchor: anchor } as CSSProperties}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            popoverTarget={id}
            popoverTargetAction="hide"
            disabled={item.disabled}
            className={`${menuItemClass} ${item.danger ? "text-danger" : ""}`}
            onClick={item.onSelect}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

// Figma "Dialog": a question on top of the panel. Cancel takes the focus so Enter can't destroy.
export function ConfirmDialog({
  title,
  confirmLabel,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
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
      aria-label={title}
      className="dialog m-auto w-[min(440px,calc(100vw-32px))] flex-col gap-4 p-6 backdrop:bg-scrim open:flex"
      onClose={onClose}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-title-s font-semibold">{title}</h2>
        <button
          type="button"
          className="button button-icon -my-1 -mr-2"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
        >
          <X {...iconProps} />
        </button>
      </div>
      <div className="text-body-s">{children}</div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          autoFocus
          className="button button-outline"
          onClick={() => dialog.current?.close()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button button-danger"
          onClick={() => {
            onConfirm();
            dialog.current?.close();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
