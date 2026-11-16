import type { Effort } from "@beebot/contracts";

const glyphHeight = 14;
// Bars stop this far above the box's bottom, which puts their flat base on the text baseline.
const baselineInset = 2;
const barStep = 4;

export const effortLabels: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

// One bar per level. Max is the full scale, so it has no bar of its own.
export function resolveEffortGlyph(levels: readonly Effort[], current: Effort | null) {
  const ordinary = levels.filter((level) => level !== "max");
  if (ordinary.length < 2 || current === null) {
    return null;
  }
  const filled = current === "max" ? ordinary.length : ordinary.indexOf(current) + 1;
  return filled > 0 ? { count: ordinary.length, filled } : null;
}

// Rounding each bar separately mixes 1px and 2px steps, so the step is rounded once.
export function effortBarHeights(count: number, maxBar: number) {
  const step = Math.max(1, Math.round(maxBar / 2 / Math.max(count - 1, 1)));
  return Array.from({ length: count }, (_, index) => maxBar - (count - 1 - index) * step);
}

export function EffortGlyph({ count, filled }: { count: number; filled: number }) {
  const width = barStep * count - 2;
  const maxBar = glyphHeight - baselineInset;
  return (
    <svg
      aria-hidden
      width={width}
      height={glyphHeight}
      viewBox={`0 0 ${width} ${glyphHeight}`}
      className="shrink-0 text-ink-secondary"
    >
      {effortBarHeights(count, maxBar).map((height, index) => (
        <rect
          key={height}
          x={index * barStep}
          y={maxBar - height}
          width={2}
          height={height}
          fill="currentColor"
          opacity={index < filled ? 1 : 0.4}
        />
      ))}
    </svg>
  );
}
