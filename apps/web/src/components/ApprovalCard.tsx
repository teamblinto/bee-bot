import type { Approval, PendingApproval } from "@beebot/contracts";
import { useEffect, useRef, useState } from "react";

import { approvalTitle, visibleDetail } from "../labels";
import { postCommand } from "../serverConnection";

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
  return (
    <article
      ref={card}
      aria-label={approvalTitle(name, approval.tool)}
      className="flex max-w-[560px] flex-col gap-2 rounded-card bg-card p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-name font-medium">{approvalTitle(name, approval.tool)}</h3>
        <TimeLeft expiresAt={pending.expiresAt} />
      </div>
      <pre
        aria-label="Exact request"
        className="font-mono text-small wrap-anywhere whitespace-pre-wrap"
      >
        {visibleDetail(pending.detail)}
      </pre>
      {error && <p className="text-small text-ink-secondary">{error}</p>}
      <div className="flex flex-wrap justify-end gap-1">
        <button
          type="button"
          className="button"
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
            className="button"
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
