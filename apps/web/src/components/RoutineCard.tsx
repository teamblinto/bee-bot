import type { Command, Routine, RoutineFiring } from "@beebot/contracts";
import { useRef, useState } from "react";

import {
  catchUpLine,
  dayAndTime,
  missedLine,
  retryCardLine,
  routineReadyLine,
  visibleDetail,
} from "../labels";
import { postCommand } from "../serverConnection";

export function RoutineCard({
  routine,
  firing,
  connected,
}: {
  routine: Routine;
  firing: RoutineFiring;
  connected: boolean;
}) {
  const deciding = useRef(false);
  const card = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(command: Command) {
    if (deciding.current) {
      return;
    }
    deciding.current = true;
    const hadFocus = card.current?.contains(document.activeElement);
    setBusy(true);
    setError(undefined);
    const result = await postCommand(command);
    // On success the lock stays: this card closes when the firing event arrives.
    if (!result.ok) {
      deciding.current = false;
      setBusy(false);
      setError(result.message);
    } else if (hadFocus) {
      document.querySelector<HTMLElement>("[data-composer]")?.focus();
    }
  }

  const disabled = busy || !connected;
  const title = routineReadyLine(routine.name);
  return (
    <article
      ref={card}
      aria-label={title}
      className="surface flex max-w-[560px] flex-col gap-2 p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-body-s font-medium wrap-anywhere">{title}</h3>
        <span className="shrink-0 text-caption text-ink-secondary">{dayAndTime(firing.slot)}</span>
      </div>
      <p className="line-clamp-3 text-body-s wrap-anywhere whitespace-pre-wrap text-ink-secondary">
        {visibleDetail(routine.prompt)}
      </p>
      {firing.attempts > 0 && <p className="text-caption text-ink-secondary">{retryCardLine}</p>}
      {firing.reason === "catch_up" && (
        <p className="text-caption text-ink-secondary">{catchUpLine}</p>
      )}
      {firing.missedBefore > 0 && (
        <p className="text-caption text-ink-secondary">{missedLine(firing.missedBefore)}</p>
      )}
      {error && <p className="text-caption text-ink-secondary">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button
          type="button"
          className="button button-sm button-outline"
          disabled={disabled}
          onClick={() => void decide({ type: "skip-firing", firingId: firing.id })}
        >
          Skip
        </button>
        <button
          type="button"
          className="button button-sm button-primary"
          disabled={disabled}
          onClick={() => void decide({ type: "start-firing", firingId: firing.id })}
        >
          Run
        </button>
      </div>
    </article>
  );
}
