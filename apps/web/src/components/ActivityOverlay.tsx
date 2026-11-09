import type { BotActivity } from "../serverConnection";

// The bot's latest action, drawn over its screen at the spot it acted on. Keyed by `seq`, so each
// new action replays the fade.
export function ActivityOverlay({ activity }: { activity: BotActivity | undefined }) {
  if (!activity) {
    return null;
  }
  const at = { left: `${activity.x * 100}%`, top: `${activity.y * 100}%` };
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <span
        key={activity.seq}
        data-activity="click"
        className="activity-ripple absolute -mt-4 -ml-4 size-8 rounded-full border-2 border-honey-fill bg-honey-surface"
        style={at}
      />
      {activity.text !== null && (
        <span
          key={`text-${activity.seq}`}
          data-activity="type"
          className="activity-chip absolute mt-4 max-w-[60%] -translate-x-1/2 truncate rounded-md bg-honey-fill px-1.5 py-0.5 text-label text-honey-ink"
          style={at}
        >
          {activity.text}
        </span>
      )}
    </div>
  );
}
