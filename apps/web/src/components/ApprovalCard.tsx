import {
  type Approval,
  type ApprovalChange,
  connectorToolPrefix,
  type Continuation,
  type PendingApproval,
} from "@beebot/contracts";
import { Clock } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { approvalTitle, changeLines, changeNote, hiddenCharsLine, visibleDetail } from "../labels";
import { postCommand } from "../serverConnection";
import { iconProps } from "./ui";

const cardClass =
  "flex flex-col gap-3 rounded-card border border-waiting-edge bg-card p-4 text-body-s";
const blockClass =
  "rounded-field bg-sidebar p-3 font-mono text-code wrap-anywhere whitespace-pre-wrap";
const noteClass = "text-caption text-ink-secondary";

function ChangeLines({ removed, added }: { removed: string; added: string }) {
  const removedLines = changeLines("- ", removed);
  const addedLines = changeLines("+ ", added);
  return (
    <>
      {removedLines && <span className="block text-danger">{removedLines}</span>}
      {addedLines && <span className="block text-brand">{addedLines}</span>}
    </>
  );
}

function ProposedChange({ change }: { change: ApprovalChange }) {
  const note = changeNote(change);
  const { action, removed, added, files = [] } = change;
  return (
    <>
      {note && <p className={noteClass}>{note}</p>}
      {action !== "patch" && !added && removed === null && <p className={noteClass}>Empty file</p>}
      {(files.length > 0 || removed || added) && (
        <pre
          role="region"
          tabIndex={0}
          aria-label="Proposed change"
          className={`${blockClass} max-h-[30dvh] overflow-y-auto overscroll-contain`}
          // On the transcript, a wheel up raises Jump to latest over this card's buttons.
          onWheel={(event) => event.stopPropagation()}
        >
          {files.map((file) => (
            <span
              key={file.path}
              role="group"
              aria-label={visibleDetail(file.path)}
              className="block not-first:mt-2"
            >
              <span className="block text-ink-secondary">{visibleDetail(file.path)}</span>
              <ChangeLines removed={file.removed} added={file.added} />
            </span>
          ))}
          <ChangeLines removed={removed ?? ""} added={added} />
        </pre>
      )}
    </>
  );
}

function TimeLeft({ createdAt, expiresAt }: { createdAt: string; expiresAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const end = Date.parse(expiresAt);
  const seconds = Math.max(0, Math.ceil((end - now) / 1000));
  const lastMinute = seconds <= 60;
  const share = Math.min(1, (seconds * 1000) / Math.max(1, end - Date.parse(createdAt)));
  return (
    <span className={`flex shrink-0 flex-col gap-1 ${lastMinute ? "w-[120px]" : ""}`}>
      {/* `timer` is not announced on each tick, even inside the transcript's live region. */}
      <span
        role="timer"
        aria-live="off"
        className={`flex items-center gap-1 tabular-nums ${
          lastMinute ? "text-body-s font-medium text-waiting" : "text-caption text-ink-secondary"
        }`}
      >
        {lastMinute && <Clock {...iconProps} className="text-waiting-status" />}
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} left
      </span>
      {lastMinute && (
        <span aria-hidden className="h-0.5 overflow-hidden rounded-full bg-raised">
          <span className="block h-full bg-waiting-status" style={{ width: `${share * 100}%` }} />
        </span>
      )}
    </span>
  );
}

function CardHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <Clock {...iconProps} className="shrink-0 text-waiting-status" />
      <h3 className="max-h-[40dvh] min-w-0 flex-1 overflow-y-auto font-medium wrap-anywhere">
        {title}
      </h3>
      {children}
    </div>
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
    <article ref={card} aria-label={approvalTitle(name, approval.tool)} className={cardClass}>
      <CardHeader title={approvalTitle(name, approval.tool)}>
        <TimeLeft createdAt={approval.createdAt} expiresAt={pending.expiresAt} />
      </CardHeader>
      <pre aria-label="Exact request" className={blockClass}>
        {visibleDetail(pending.detail)}
      </pre>
      {pending.change && <ProposedChange change={pending.change} />}
      {error && <p className="text-danger">{error}</p>}
      {hiddenChars > 0 && <p className={noteClass}>{hiddenCharsLine(hiddenChars)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="button button-sm button-outline"
          disabled={disabled}
          onClick={() => void decide("deny")}
        >
          Deny
        </button>
        <button
          type="button"
          className="button button-sm button-primary"
          disabled={disabled}
          onClick={() => void decide("allow")}
        >
          Allow once
        </button>
        {pending.canAlwaysAllow && (
          <button
            type="button"
            className="button button-sm"
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

// A Box bot's turn has already ended: answering starts the next one with the outcome.
export function ContinuationCard({
  name,
  continuation,
  connected,
}: {
  name: string;
  continuation: Continuation;
  connected: boolean;
}) {
  const deciding = useRef(false);
  const card = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(decision: "approve" | "deny" | "always") {
    if (deciding.current) {
      return;
    }
    deciding.current = true;
    const hadFocus = card.current?.contains(document.activeElement);
    setBusy(true);
    setError(undefined);
    const { id: continuationId, digest } = continuation;
    const result = await postCommand({
      type: "decide-continuation",
      continuationId,
      digest,
      decision,
    });
    // On success the lock stays: this card closes when the continuation event arrives.
    if (!result.ok) {
      deciding.current = false;
      setBusy(false);
      setError(result.message);
    } else if (hadFocus) {
      document.querySelector<HTMLElement>("[data-composer]")?.focus();
    }
  }

  const handOff = continuation.kind === "hand_off";
  // A connector write comes as "<app>: <tool>", then its arguments.
  const connector = !handOff && continuation.tool.startsWith(connectorToolPrefix);
  // An action on this PC comes in words, with the exact element or window under them. Anything
  // else is the tool's name and its input.
  const [said = "", ...exact] = continuation.shown.split("\n");
  const worded = !handOff && !connector && !continuation.shown.startsWith(`${continuation.tool}: `);
  const title = handOff
    ? `${name} needs you to do this`
    : connector
      ? `${name} wants to use ${visibleDetail(said)}`
      : worded
        ? visibleDetail(said)
        : `${name} wants to run ${continuation.tool}`;
  const disabled = busy || !connected;
  return (
    <article ref={card} aria-label={worded ? `${name}: ${title}` : title} className={cardClass}>
      <CardHeader title={title}>
        <TimeLeft createdAt={continuation.createdAt} expiresAt={continuation.expiresAt} />
      </CardHeader>
      {worded ? (
        exact.length > 0 && (
          <p className="font-mono text-caption wrap-anywhere whitespace-pre-wrap text-ink-secondary">
            {visibleDetail(exact.join("\n"))}
          </p>
        )
      ) : (
        <pre
          role="region"
          tabIndex={0}
          aria-label="Exact request"
          className={`${blockClass} max-h-[40dvh] overflow-y-auto overscroll-contain`}
          onWheel={(event) => event.stopPropagation()}
        >
          {visibleDetail(connector ? exact.join("\n") : continuation.shown)}
        </pre>
      )}
      <p className={noteClass}>
        {handOff
          ? `Bee never does this itself. If you want it done, do it yourself, then tell ${name}.`
          : `Bee runs exactly this, once, then tells ${name} how it went.`}
      </p>
      {error && <p className="text-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={`button button-sm ${handOff ? "order-last" : "button-outline"}`}
          disabled={disabled}
          onClick={() => void decide("deny")}
        >
          {handOff ? "Not done" : "Deny"}
        </button>
        <button
          type="button"
          className="button button-sm button-primary"
          disabled={disabled}
          onClick={() => void decide("approve")}
        >
          {handOff ? "I did it" : "Approve"}
        </button>
        {connector && (
          <button
            type="button"
            className="button button-sm"
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
