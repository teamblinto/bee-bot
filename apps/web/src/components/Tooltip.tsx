import { type CSSProperties, type ReactNode, useId, useRef } from "react";

const hoverDelayMs = 400;

// Top layer, so a popup's clipping can't cut it off. Shares the popover's anchor positioning.
export function Tooltip({
  label,
  side = "top",
  className = "inline-flex min-w-0",
  children,
}: {
  label: string;
  side?: "top" | "bottom" | "left";
  className?: string;
  children: ReactNode;
}) {
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const anchor = `--tip-${useId().replace(/[^\w-]/g, "")}`;
  const show = () => tip.current?.showPopover?.();
  const hide = () => {
    clearTimeout(timer.current);
    tip.current?.hidePopover?.();
  };
  return (
    <span
      className={className}
      style={{ anchorName: anchor } as CSSProperties}
      onPointerEnter={() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(show, hoverDelayMs);
      }}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={({ key }) => {
        if (key === "Escape") {
          hide();
        }
      }}
    >
      {children}
      <span
        ref={tip}
        popover="manual"
        role="tooltip"
        data-side={side}
        className="tooltip"
        style={{ positionAnchor: anchor } as CSSProperties}
      >
        {label}
      </span>
    </span>
  );
}
