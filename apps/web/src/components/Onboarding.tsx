import {
  type Bot,
  type BoxAvailability,
  type Command,
  type HostPlatform,
  setupCommand,
} from "@beebot/contracts";
import { Check, LoaderCircle, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { connectionLines, engineFix } from "../labels";
import {
  checkEngine,
  type ConnectionState,
  fetchHost,
  getConnectionState,
  postCommand,
  requestNotifications,
} from "../serverConnection";
import { BotForm } from "./BotForm";
import { CopyButton } from "./CopyButton";
import { RedactedText } from "./RedactedText";
import { SetupProgress } from "./SetupProgress";
import { iconProps } from "./ui";

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <section className="surface flex w-full max-w-[520px] flex-col gap-5 p-6">
        <div className="flex flex-col gap-2">
          <div aria-hidden className="flex gap-1">
            {[1, 2].map((step) => (
              <span
                key={step}
                className={`h-1 flex-1 rounded-full ${step <= number ? "bg-honey-fill" : "bg-raised"}`}
              />
            ))}
          </div>
          <p className="text-label text-ink-faint">Step {number} of 2</p>
          <h1 className="text-heading font-semibold">{title}</h1>
        </div>
        {children}
      </section>
    </main>
  );
}

function guessHost(): HostPlatform {
  const agent = navigator.userAgent;
  const os = agent.includes("Windows") ? "windows" : agent.includes("Mac") ? "macos" : "linux";
  return { os, linuxFamily: null };
}

function Dependency({
  name,
  state,
  line,
  action,
  command,
  hint,
  children,
}: {
  name: string;
  state: "ok" | "missing" | "checking";
  line: ReactNode;
  action?: { label: string; command: Command } | undefined;
  // Undefined shows no command; null means there is none for this computer.
  command?: string | null | undefined;
  hint?: string | undefined;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [opened, setOpened] = useState(false);
  const Icon = state === "ok" ? Check : state === "checking" ? LoaderCircle : X;

  async function run(command: Command) {
    setBusy(true);
    setError(undefined);
    const result = await postCommand(command);
    setBusy(false);
    if (result.ok) {
      setOpened(command.type === "open-setup-terminal");
    } else {
      setError(result.message);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-row border border-edge p-3">
      <div className="flex items-center gap-3">
        <Icon {...iconProps} className={state === "checking" ? "animate-spin" : undefined} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">{name}</span>
          <span role="status" className="flex min-w-0 gap-1 text-small text-ink-secondary">
            {line}
          </span>
        </div>
        {action && (
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() => void run(action.command)}
          >
            {action.label}
          </button>
        )}
      </div>
      {children}
      {opened && (
        <p className="text-small text-ink-secondary">
          Finish in the terminal window, then come back here.
        </p>
      )}
      {error && (
        <p role="alert" className="text-small text-ink-secondary">
          {error}
        </p>
      )}
      {command === null && (
        <a
          className="text-small text-ink-secondary underline underline-offset-2"
          href="https://podman.io/docs/installation"
          target="_blank"
          rel="noreferrer noopener"
        >
          How to install Podman on this computer
        </a>
      )}
      {command && (
        <div className="flex flex-col gap-1 rounded-row border border-edge bg-code p-3">
          <p className="text-label text-ink-faint">
            {action ? "Or run this in a terminal:" : "Run this in a terminal:"}
          </p>
          <div className="flex items-center justify-between gap-2">
            <code className="font-mono text-small wrap-anywhere">{command}</code>
            <CopyButton label="Copy command" text={() => command} />
          </div>
          {hint && <p className="text-label text-ink-faint">{hint}</p>}
        </div>
      )}
    </div>
  );
}

function ClaudeRow({
  connection,
  host,
}: {
  connection: ConnectionState;
  host: HostPlatform | undefined;
}) {
  const { engine, engineChecking, status } = connection;
  const name = "Claude Code";
  if (!engine) {
    return (
      <Dependency
        name={name}
        state={engineChecking ? "checking" : "missing"}
        line={
          engineChecking
            ? "Checking Claude Code"
            : status === "connected"
              ? "Bee Bot couldn't check Claude Code. Check again."
              : connectionLines[status]
        }
      />
    );
  }
  const fix = engineFix(engine, host);
  if (!fix) {
    return (
      <Dependency
        name={name}
        state="ok"
        line={
          <>
            {engine.version ? `Claude Code ${engine.version}` : "Installed"}
            {engine.email ? (
              <>
                , signed in as
                <RedactedText value={engine.email} label="account email" />
              </>
            ) : (
              ", sign-in is checked when a bot first runs"
            )}
          </>
        }
      />
    );
  }
  // Every fix after a missing or broken CLI is to sign in again.
  const step = !engine.cliFound
    ? "claude-install"
    : engine.pauseReason === "cli_failed"
      ? undefined
      : "claude-login";
  return (
    <Dependency
      key={step}
      name={name}
      state="missing"
      line={fix.label}
      action={
        step && {
          label: step === "claude-install" ? "Install" : "Sign in",
          command: { type: "open-setup-terminal", step },
        }
      }
      command={host && fix.command}
    >
      {step !== "claude-install" && engine.auth !== "unauthenticated" && (
        <p className="text-small text-ink-secondary">{fix.text}</p>
      )}
    </Dependency>
  );
}

function BoxesRow({
  boxes,
  host,
}: {
  boxes: BoxAvailability | undefined;
  host: HostPlatform | undefined;
}) {
  const name = "Computers for your bots";
  if (!boxes) {
    return <Dependency name={name} state="missing" line="This server can't run them." />;
  }
  if (!boxes.podmanFound) {
    return (
      <Dependency
        key="podman-install"
        name={name}
        state="missing"
        line="Podman isn't installed"
        action={{
          label: "Install Podman",
          command: { type: "open-setup-terminal", step: "podman-install" },
        }}
        command={host && setupCommand(host, "podman-install")}
        hint={
          host?.os === "macos"
            ? "Needs Homebrew (brew.sh)."
            : host?.os === "windows"
              ? "Windows may ask to restart to finish installing WSL."
              : undefined
        }
      />
    );
  }
  if (boxes.settingUp) {
    return (
      <Dependency name={name} state="checking" line="Setting up">
        {boxes.progress && <SetupProgress progress={boxes.progress} />}
      </Dependency>
    );
  }
  if (!boxes.available) {
    return (
      <Dependency
        key="set-up"
        name={name}
        state="missing"
        line={boxes.problem ?? "Not set up yet"}
        action={{ label: "Set up", command: { type: "set-up-boxes" } }}
      />
    );
  }
  return <Dependency name={name} state="ok" line="Ready" />;
}

// Setting up probes first, so while Podman is missing this only looks for it, and once it is
// installed setup carries on from there.
function recheck() {
  void checkEngine();
  if (getConnectionState().boxAvailability?.podmanFound === false) {
    void postCommand({ type: "set-up-boxes" });
  }
}

function SetupStep({
  connection,
  onContinue,
}: {
  connection: ConnectionState;
  onContinue: () => void;
}) {
  const [host, setHost] = useState<HostPlatform>();
  const { engine, engineChecking, status, boxAvailability } = connection;
  const claudeReady = status === "connected" && !!engine && !engineFix(engine) && !engineChecking;
  const boxesReady = boxAvailability?.available === true;

  useEffect(() => {
    let live = true;
    void fetchHost().then((found) => {
      if (live) {
        setHost(found ?? guessHost());
      }
    });
    return () => {
      live = false;
    };
  }, []);

  // The owner installs or signs in from a terminal window, so coming back is the moment to look.
  useEffect(() => {
    void checkEngine();
    const onReturn = () => {
      if (document.visibilityState === "visible") {
        recheck();
      }
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);

  return (
    <Step number={1} title="Set up Bee Bot">
      <div className="flex flex-col gap-3">
        <ClaudeRow connection={connection} host={host} />
        <BoxesRow boxes={boxAvailability} host={host} />
      </div>
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          className="button button-outline"
          disabled={engineChecking}
          onClick={recheck}
        >
          {engineChecking ? "Checking…" : "Check again"}
        </button>
        {!boxesReady && (
          <button
            type="button"
            className="button button-outline"
            disabled={!claudeReady}
            onClick={onContinue}
          >
            Skip for now
          </button>
        )}
        <button
          type="button"
          className="button button-primary"
          disabled={!claudeReady || !boxesReady}
          onClick={onContinue}
        >
          Continue
        </button>
      </div>
    </Step>
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
  const [setUp, setSetUp] = useState(false);

  if (!setUp) {
    return <SetupStep connection={connection} onContinue={() => setSetUp(true)} />;
  }
  return (
    <Step number={2} title="Create your first bot">
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
