import type { Approval, ApprovalChange, PendingApproval } from "@beebot/contracts";
import { useEffect, useRef, useState } from "react";

import { approvalTitle, changeLines, changeNote, hiddenCharsLine, visibleDetail } from "../labels";
import { postCommand } from "../serverConnection";

function ProposedChange({ change }: { change: ApprovalChange }) {
  const note = changeNote(change);
  const removed = changeLines("- ", change.removed ?? "");
  const added = changeLines("+ ", change.added);
  return (
    <>
      {note && <p className="text-small text-ink-secondary">{note}</p>}
      {!removed && !added && change.removed === null && (
        <p className="text-small text-ink-secondary">Empty file</p>
      )}
      {(removed || added) && (
        <pre
          role="region"
          tabIndex={0}
          aria-label="Proposed change"
          className="max-h-[30dvh] overflow-y-auto overscroll-contain rounded-row border border-edge bg-code px-3 py-2 font-mono text-small wrap-anywhere whitespace-pre-wrap"
          // On the transcript, a wheel up raises Jump to latest over this card's buttons.
          onWheel={(event) => event.stopPropagation()}
        >
          {removed && <span className="block text-danger">{removed}</span>}
          {added && <span className="block text-honey">{added}</span>}
        </pre>
      )}
    </>
  );
}

function TimeLeft({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return (
    // `timer` is not announced on each tick, even inside the transcript's live region.
    <span role="timer" aria-live="off" className="text-label text-ink-faint tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} left
    </span>
  );
}

export function ApprovalCard({
  name,
  approval,
  pending,
  connected,
}: {
  name: string;
  approval: Approval;
  pending: PendingApproval;
  connected: boolean;
}) {
  const deciding = useRef(false);
  const card = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(decision: "allow" | "deny" | "always") {
    if (deciding.current) {
      return;
    }
    deciding.current = true;
    const hadFocus = card.current?.contains(document.activeElement);
    setBusy(true);
    setError(undefined);
    const { id: approvalId, digest } = approval;
    const result = await postCommand({ type: "decide-approval", approvalId, digest, decision });
    // On success the lock stays: this card closes when the approval event arrives.
    if (!result.ok) {
      deciding.current = false;
      setBusy(false);
      setError(result.message);
    } else if (hadFocus) {
      document.querySelector<HTMLElement>("[data-composer]")?.focus();
    }
  }

  const disabled = busy || !connected;
  const hiddenChars = pending.change?.hiddenChars ?? 0;
  return (
    <article
      ref={card}
      aria-label={approvalTitle(name, approval.tool)}
      className="surface flex max-w-[560px] flex-col gap-3 p-3.5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-name font-medium">{approvalTitle(name, approval.tool)}</h3>
        <TimeLeft expiresAt={pending.expiresAt} />
      </div>
      <pre
        aria-label="Exact request"
        className="rounded-row border border-edge bg-code px-3 py-2 font-mono text-small wrap-anywhere whitespace-pre-wrap"
      >
        {visibleDetail(pending.detail)}
      </pre>
      {pending.change && <ProposedChange change={pending.change} />}
      {error && <p className="text-small text-ink-secondary">{error}</p>}
      {hiddenChars > 0 && (
        <p className="text-small text-ink-secondary">{hiddenCharsLine(hiddenChars)}</p>
      )}
      <div className="flex flex-wrap justify-end gap-1">
        <button
          type="button"
          className="button button-outline"
          disabled={disabled}
          onClick={() => void decide("deny")}
        >
          Deny
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={disabled}
          onClick={() => void decide("allow")}
        >
          Allow once
        </button>
        {pending.canAlwaysAllow && (
          <button
            type="button"
            className="button button-outline"
            disabled={disabled}
            onClick={() => void decide("always")}
          >
            Always allow
          </button>
        )}
      </div>
    </article>
  );
}
