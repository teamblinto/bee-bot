import type { BoxAvailability } from "@beebot/contracts";

// Measured steps fill the bar; the others slide, because a bar that guesses misleads.
export function SetupProgress({
  progress,
}: {
  progress: NonNullable<BoxAvailability["progress"]>;
}) {
  const percent = progress.fraction === null ? null : Math.round(progress.fraction * 100);
  return (
    <div className="flex w-full flex-col gap-1.5 text-left">
      <div className="flex items-baseline justify-between gap-2 text-small">
        <span className="text-ink">{progress.label}</span>
        {percent !== null && (
          <span className="text-label text-ink-faint tabular-nums">{percent}%</span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={progress.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={progress.detail ?? undefined}
        className="h-1.5 overflow-hidden rounded-full bg-raised"
      >
        <div
          className={`h-full rounded-full bg-honey-fill ${percent === null ? "w-1/3 animate-[progress-slide_1.4s_ease-in-out_infinite]" : "transition-[width] duration-300"}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {progress.detail && (
        <span className="text-label text-ink-faint tabular-nums">{progress.detail}</span>
      )}
    </div>
  );
}
