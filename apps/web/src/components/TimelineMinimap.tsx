import { ChevronDown, ChevronUp } from "lucide-react";
import {
  memo,
  type MouseEvent,
  type RefObject,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import {
  type MinimapItem,
  minimapCurrentIndex,
  minimapFisheyeClass,
  minimapHasPersistentGutter,
  minimapHeightStyle,
  minimapHitStripWidth,
  minimapIndexFromPointer,
  minimapInteractiveWidth,
  minimapItemsEqual,
  minimapMinItems,
  minimapNavigationInteractive,
  minimapPreview,
  minimapTopPercent,
  minimapVisibilityClass,
} from "../timelineMinimap";
import { forwardWheelToTimeline } from "../timelineMinimapWheel";
import { Tooltip } from "./Tooltip";

const targetsPreview = (target: EventTarget) =>
  target instanceof Element && target.closest("[data-minimap-preview]") !== null;

// A release outside the window can skip `mouseup`, so the next button-free `mousemove` counts too.
function onMouseButtonsReleased(onRelease: () => void) {
  const check = (event: globalThis.MouseEvent) => {
    if (event.buttons !== 0) {
      return;
    }
    window.removeEventListener("mouseup", check);
    window.removeEventListener("mousemove", check);
    onRelease();
  };
  window.addEventListener("mouseup", check);
  window.addEventListener("mousemove", check);
}

function setDisabled(button: HTMLButtonElement | null, disabled: boolean) {
  if (button && button.disabled !== disabled) {
    button.disabled = disabled;
  }
}

function NavigationButton({
  direction,
  interactive,
  buttonRef,
  onClick,
}: {
  direction: "previous" | "next";
  interactive: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  const previous = direction === "previous";
  const label = previous ? "Previous turn" : "Next turn";
  const Icon = previous ? ChevronUp : ChevronDown;
  return (
    <Tooltip
      label={label}
      side={previous ? "top" : "bottom"}
      className={`absolute left-1 z-10 inline-flex -translate-x-1/2 opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 hover:opacity-100 focus-within:opacity-100 ${
        interactive ? "pointer-events-auto" : "pointer-events-none"
      } ${previous ? "bottom-[calc(100%+2px)]" : "top-[calc(100%+2px)]"}`}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        className="flex size-5 items-center justify-center rounded-field text-ink transition-colors hover:bg-hover disabled:text-ink-faint"
        onClick={onClick}
      >
        <Icon aria-hidden size={16} strokeWidth={1.75} />
      </button>
    </Tooltip>
  );
}

function Minimap({
  items,
  scroller,
  content,
  onJump,
}: {
  items: MinimapItem[];
  scroller: RefObject<HTMLDivElement | null>;
  content: RefObject<HTMLDivElement | null>;
  onJump: (id: string) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [gutter, setGutter] = useState({ persistent: false, hitWidth: 0 });
  const [passThrough, setPassThrough] = useState(false);
  const pressedOnStrip = useRef(false);
  const strips = useRef(new Map<string, HTMLSpanElement>());
  const current = useRef<number | null>(null);
  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const latest = useRef(items);
  const frame = useRef<number>(undefined);

  // Scrolling and streaming land here, so nothing in it may touch React state. Writes are skipped
  // when unchanged, to leave style state clean on every scroll tick.
  function refresh() {
    const box = scroller.current;
    if (!box) {
      return;
    }
    const view = box.getBoundingClientRect();
    const rows = latest.current.flatMap(({ id }) => {
      const row = content.current?.querySelector(`[data-message-id="${id}"]`);
      return row ? [{ id, rect: row.getBoundingClientRect() }] : [];
    });
    for (const { id, rect } of rows) {
      const inView = rect.top < view.bottom && rect.bottom > view.top ? "true" : "false";
      const strip = strips.current.get(id);
      if (strip && strip.dataset.inView !== inView) {
        strip.dataset.inView = inView;
      }
    }
    current.current = minimapCurrentIndex(
      rows.map(({ rect }) => rect),
      view,
    );
    const count = latest.current.length;
    const at = current.current;
    setDisabled(previousButton.current, at === null || at <= 0);
    setDisabled(nextButton.current, at === null || at >= count - 1);
  }

  const scheduleRefresh = useEffectEvent(() => {
    frame.current ??= requestAnimationFrame(() => {
      frame.current = undefined;
      refresh();
    });
  });

  useEffect(() => {
    latest.current = items;
    scheduleRefresh();
  });

  // Output grows without any scroll event, so size changes matter here as they do for auto-follow.
  useEffect(() => {
    const box = scroller.current;
    const lane = content.current;
    if (!box || !lane) {
      return undefined;
    }
    const measure = () => {
      const viewport = box.getBoundingClientRect().width;
      const width = lane.getBoundingClientRect().width;
      const persistent = minimapHasPersistentGutter(viewport, width);
      const hitWidth = minimapHitStripWidth(viewport, width);
      setGutter((known) =>
        known.persistent === persistent && known.hitWidth === hitWidth
          ? known
          : { persistent, hitWidth },
      );
      scheduleRefresh();
    };
    const onScroll = () => scheduleRefresh();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(lane);
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      box.removeEventListener("scroll", onScroll);
      if (frame.current !== undefined) {
        cancelAnimationFrame(frame.current);
        frame.current = undefined;
      }
    };
  }, [scroller, content]);

  const wheelTarget = (node: HTMLDivElement | null) => {
    if (!node) {
      return undefined;
    }
    const onWheel = (event: WheelEvent) => {
      if (scroller.current) {
        forwardWheelToTimeline(event, scroller.current);
      }
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  };

  if (items.length < minimapMinItems) {
    return null;
  }

  const resolvedActive = activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolvedActive === null ? undefined : items[resolvedActive];
  const preview = activeItem && minimapPreview(activeItem);
  const navigationInteractive = minimapNavigationInteractive(gutter.hitWidth) && !passThrough;
  const activeTop = resolvedActive === null ? 0 : minimapTopPercent(resolvedActive, items.length);
  // The first and last strips hang the card off their own edge, so it never leaves the rail's reach.
  let previewShift = "-50%";
  if (resolvedActive === 0) {
    previewShift = "0%";
  } else if (resolvedActive === items.length - 1) {
    previewShift = "-100%";
  }

  const indexFromPointer = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return minimapIndexFromPointer({
      itemCount: items.length,
      railTop: rect.top,
      railHeight: rect.height,
      pointerY: event.clientY,
    });
  };

  const jumpBy = (step: number) => {
    const target = current.current === null ? undefined : items[current.current + step];
    if (target) {
      onJump(target.id);
    }
  };

  const moveActive = (step: number) =>
    setActiveIndex((index) => Math.max(0, Math.min(items.length - 1, (index ?? 0) + step)));

  return (
    <div
      ref={wheelTarget}
      role="navigation"
      aria-label="Chat navigator"
      data-testid="timeline-minimap"
      className={`group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 w-18 ${minimapVisibilityClass(gutter.persistent)}`}
    >
      <div className="relative h-full w-full select-none">
        <div
          className={`group/rail absolute top-1/2 left-3 -translate-y-1/2 ${
            gutter.hitWidth > 0 && !passThrough ? "pointer-events-auto" : "pointer-events-none"
          }`}
          style={{
            height: minimapHeightStyle(items.length),
            width: minimapInteractiveWidth(gutter.hitWidth, preview !== undefined),
          }}
          onMouseDown={() => {
            if (pressedOnStrip.current) {
              return;
            }
            pressedOnStrip.current = true;
            onMouseButtonsReleased(() => {
              pressedOnStrip.current = false;
            });
          }}
          onMouseMove={(event) => {
            // A drag that started elsewhere is passing over, so the rail gets out of its way.
            if (event.buttons === 0 || pressedOnStrip.current || passThrough) {
              return;
            }
            setPassThrough(true);
            onMouseButtonsReleased(() => setPassThrough(false));
          }}
        >
          <NavigationButton
            direction="previous"
            interactive={navigationInteractive}
            buttonRef={previousButton}
            onClick={() => jumpBy(-1)}
          />
          <button
            type="button"
            aria-label={`Jump to message: ${preview?.userText ?? "User message"}`}
            className="absolute inset-y-0 left-0 w-full cursor-pointer bg-transparent focus-visible:outline-2 focus-visible:-outline-offset-2"
            onBlur={() => setActiveIndex(null)}
            onClick={(event) => {
              const index = indexFromPointer(event);
              const target = index === null ? undefined : items[index];
              // A click on the card jumps to the turn it shows, not to whatever is under the pointer.
              const picked = targetsPreview(event.target) ? activeItem : target;
              if (picked) {
                onJump(picked.id);
              }
              event.currentTarget.blur();
            }}
            onFocus={() => setActiveIndex((index) => index ?? current.current ?? 0)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveActive(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveActive(-1);
              } else if (event.key === "Home") {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === "End") {
                event.preventDefault();
                setActiveIndex(items.length - 1);
              } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (activeItem) {
                  onJump(activeItem.id);
                }
              }
            }}
            onMouseDown={(event) => {
              if (!targetsPreview(event.target)) {
                event.preventDefault();
              }
            }}
            onMouseLeave={() => setActiveIndex(null)}
            onMouseMove={(event) => {
              if (event.buttons === 0 || pressedOnStrip.current) {
                setActiveIndex(indexFromPointer(event));
              }
            }}
          >
            <span aria-hidden className="absolute top-0 left-3 h-full w-px bg-ink/15" />
            {items.map(({ id }, index) => {
              const distance = resolvedActive === null ? null : Math.abs(index - resolvedActive);
              return (
                // Only transform and opacity: scrolling and streaming flip a band of these at once.
                <span
                  key={id}
                  ref={(node) => {
                    if (node) {
                      strips.current.set(id, node);
                    } else {
                      strips.current.delete(id);
                    }
                  }}
                  aria-hidden
                  data-in-view="false"
                  data-minimap-strip
                  className={`pointer-events-none absolute left-0 h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-transform duration-150 after:absolute after:inset-0 after:rounded-full after:bg-ink/55 after:opacity-0 after:transition-opacity after:duration-150 data-[in-view=true]:after:opacity-100 ${
                    distance === 0 ? "bg-ink/60" : "bg-ink/25"
                  } ${minimapFisheyeClass(distance)}`}
                  style={{ top: `${minimapTopPercent(index, items.length)}%` }}
                />
              );
            })}
            {preview && (
              <span
                data-minimap-preview
                className="pointer-events-auto absolute left-8 w-80 max-w-[calc(100vw-5rem)] cursor-text select-text"
                style={{ top: `${activeTop}%`, transform: `translateY(${previewShift})` }}
                onMouseMove={(event) => event.stopPropagation()}
              >
                <span className="menu block rounded-card p-3 text-left">
                  <span className="block max-w-full truncate text-name font-medium">
                    {preview.userText || "User message"}
                  </span>
                  {preview.assistantText && (
                    <span className="mt-1 line-clamp-3 max-h-[3.75rem] overflow-hidden text-name text-ink-secondary">
                      {preview.assistantText}
                    </span>
                  )}
                </span>
              </span>
            )}
          </button>
          <NavigationButton
            direction="next"
            interactive={navigationInteractive}
            buttonRef={nextButton}
            onClick={() => jumpBy(1)}
          />
        </div>
      </div>
    </div>
  );
}

// `onJump` and the refs are stable by contract: streaming re-renders the transcript on every delta,
// and that must not reach the rail.
export const TimelineMinimap = memo(Minimap, (a, b) => minimapItemsEqual(a.items, b.items));
