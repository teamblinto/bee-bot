import type { Bot, Command, EngineStatus } from "@beebot/contracts";
import { Check, Minus, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { connectionLines, engineFix } from "../labels";
import {
  checkEngine,
  type ConnectionState,
  postCommand,
  requestNotifications,
} from "../serverConnection";
import { BotForm } from "./BotForm";
import { CopyButton } from "./CopyButton";
import { RedactedText } from "./RedactedText";
import { iconProps } from "./ui";
import { AutomatedAccessNotice } from "./VaultPanel";

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <section className="surface flex w-full max-w-[520px] flex-col gap-5 p-6">
        <div className="flex flex-col gap-2">
          <div aria-hidden className="flex gap-1">
            {[1, 2, 3, 4].map((step) => (
              <span
                key={step}
                className={`h-1 flex-1 rounded-full ${step <= number ? "bg-honey-fill" : "bg-raised"}`}
              />
            ))}
          </div>
          <p className="text-label text-ink-faint">Step {number} of 4</p>
          <h1 className="text-heading font-semibold">{title}</h1>
        </div>
        {children}
      </section>
    </main>
  );
}

function CheckList({ engine }: { engine: EngineStatus }) {
  const fixed = !engineFix(engine);
  const loginUnknown = engine.auth === "unknown" && fixed;
  const checks = [
    {
      label: engine.version ? `Claude Code ${engine.version} installed` : "Claude Code installed",
      passed: engine.cliFound && engine.pauseReason !== "cli_failed",
    },
    {
      label: loginUnknown ? "Login is checked when a bot first runs" : "Logged in",
      passed: engine.auth !== "unauthenticated" && fixed,
    },
  ];
  const firstFailure = checks.findIndex(({ passed }) => !passed);
  return (
    <ul className="flex flex-col gap-1 text-small">
      {checks.map(({ label, passed }, position) => {
        const blocked = firstFailure !== -1 && position > firstFailure;
        const pending = blocked || (loginUnknown && position === checks.length - 1);
        return (
          <li
            key={label}
            className={`flex items-center gap-2 ${blocked ? "text-ink-faint" : "text-ink"}`}
          >
            {pending ? (
              <Minus {...iconProps} />
            ) : passed ? (
              <Check {...iconProps} />
            ) : (
              <X {...iconProps} />
            )}
            {label}
            <span className="sr-only">
              {pending ? "Not checked yet" : passed ? "Passed" : "Needs a fix"}
            </span>
          </li>
        );
      })}
      {engine.email && (
        <li className="flex min-w-0 items-center gap-2 pl-6 text-ink-secondary">
          Signed in as
          <RedactedText value={engine.email} label="account email" />
        </li>
      )}
    </ul>
  );
}

function ConnectStep({
  connection,
  onContinue,
}: {
  connection: ConnectionState;
  onContinue: () => void;
}) {
  const { engine, engineChecking, status } = connection;
  const fix = engine && engineFix(engine);
  const healthy = status === "connected" && engine && !fix;

  useEffect(() => {
    void checkEngine();
  }, []);

  return (
    <Step number={1} title="Connect Claude">
      <p className="text-ink-secondary">
        Bee Bot talks to Claude through Claude Code on this computer.
      </p>
      <div role="status" className="flex flex-col gap-3">
        {engine && <CheckList engine={engine} />}
        {engineChecking && !engine && <p className="shimmer w-fit text-small">Checking Claude</p>}
        {!engineChecking && !engine && (
          <p className="text-small text-ink-secondary">
            {status === "connected"
              ? "Bee Bot couldn't check Claude. Check again in a moment."
              : status === "connecting"
                ? connectionLines.connecting
                : connectionLines[status]}
          </p>
        )}
        {fix && (
          <div className="flex flex-col gap-2 rounded-row border border-edge bg-code p-3">
            <p className="text-small text-ink-secondary">{fix.text}</p>
            {fix.command && (
              <div className="flex items-center justify-between gap-2">
                <code className="font-mono text-small wrap-anywhere">{fix.command}</code>
                <CopyButton label="Copy command" text={() => fix.command ?? ""} />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          className="button button-outline"
          disabled={engineChecking}
          onClick={() => void checkEngine()}
        >
          {engineChecking ? "Checking…" : "Check again"}
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={!healthy || engineChecking}
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </Step>
  );
}

function AcknowledgeStep({
  number,
  title,
  command,
  buttonLabel,
  children,
}: {
  number: number;
  title: string;
  command: Extract<Command, { type: "acknowledge-notice" | "acknowledge-automated-access" }>;
  buttonLabel: string;
  children: ReactNode;
}) {
  const acknowledging = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function acknowledge() {
    if (acknowledging.current) {
      return;
    }
    acknowledging.current = true;
    setBusy(true);
    setError(undefined);
    const result = await postCommand(command);
    // On success the lock stays: this step leaves when the acknowledged event arrives.
    if (!result.ok) {
      acknowledging.current = false;
      setBusy(false);
      setError(result.message);
    }
  }

  return (
    <Step number={number} title={title}>
      {children}
      {error && (
        <p role="alert" className="text-small text-ink-secondary">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          // The previous step's button is gone, and focus would fall back to the page.
          autoFocus
          className="button button-primary"
          disabled={busy}
          onClick={() => void acknowledge()}
        >
          {buttonLabel}
        </button>
      </div>
    </Step>
  );
}

function NoticeStep() {
  return (
    <AcknowledgeStep
      number={2}
      title="How this works"
      command={{ type: "acknowledge-notice" }}
      buttonLabel="Got it"
    >
      <ul className="flex flex-col gap-2 text-ink-secondary">
        <li>Your bots use your own Claude login.</li>
        <li>Your Claude account terms apply to what they do.</li>
        <li>Bots run only while this app is open.</li>
      </ul>
    </AcknowledgeStep>
  );
}

function AutomatedAccessStep() {
  return (
    <AcknowledgeStep
      number={3}
      title="Bots that run on their own"
      command={{ type: "acknowledge-automated-access" }}
      buttonLabel="I understand"
    >
      <AutomatedAccessNotice />
      <p className="text-small text-ink-faint">You can add API keys later, on the Usage page.</p>
    </AcknowledgeStep>
  );
}

export function Onboarding({
  connection,
  onCreated,
  onNotNow,
}: {
  connection: ConnectionState;
  onCreated: (bot: Bot) => void;
  onNotNow: () => void;
}) {
  const [connected, setConnected] = useState(false);

  const { noticeAcknowledgedAt, automatedAccessAcknowledgedAt } = connection.chat;
  if (noticeAcknowledgedAt && !automatedAccessAcknowledgedAt) {
    return <AutomatedAccessStep />;
  }
  if (noticeAcknowledgedAt) {
    return (
      <Step number={4} title="Create your first bot">
        <BotForm
          bot={undefined}
          submitLabel="Create bot"
          onSaved={(bot) => {
            requestNotifications();
            onCreated(bot);
          }}
        >
          <button
            type="button"
            className="px-3 text-small text-ink-secondary underline underline-offset-2"
            onClick={onNotNow}
          >
            Not now
          </button>
        </BotForm>
      </Step>
    );
  }
  return connected ? (
    <NoticeStep />
  ) : (
    <ConnectStep connection={connection} onContinue={() => setConnected(true)} />
  );
}
