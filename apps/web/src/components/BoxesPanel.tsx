import { type BoxAvailability, BoxMachineName } from "@beebot/contracts";
import { Circle, CircleCheck, Info, LoaderCircle } from "lucide-react";
import { type FormEvent, useState, useSyncExternalStore } from "react";

import { getConnectionState, postCommand, subscribeToConnection } from "../serverConnection";
import { SetupProgress } from "./SetupProgress";
import { iconProps } from "./ui";

function steps(availability: BoxAvailability) {
  return [
    {
      label: "Find the machine",
      detail: "Bee Bot looks for the Podman machine named above.",
      done: availability.machineFound,
    },
    {
      label: "Build the box image",
      detail: "The system each box starts from.",
      done: availability.imageBuilt,
    },
    {
      label: "Install the box daemon",
      detail: "Lets Bee Bot start boxes on this computer.",
      done: availability.boxdInstalled,
    },
  ];
}

function statusLine(availability: BoxAvailability, doneCount: number) {
  if (availability.settingUp) {
    return `Setting up boxes · ${Math.min(doneCount + 1, 3)} of 3`;
  }
  return availability.available ? "Boxes are ready." : availability.problem;
}

export function BoxesPanel() {
  const availability = useSyncExternalStore(
    subscribeToConnection,
    () => getConnectionState().boxAvailability,
  );
  const hasKey = useSyncExternalStore(
    subscribeToConnection,
    () => getConnectionState().chat.vault.apiKeys.length > 0,
  );
  const [machine, setMachine] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!availability) {
    return null;
  }
  const name = machine ?? availability.machine;
  const valid = BoxMachineName.safeParse(name).success;

  async function run(command: Parameters<typeof postCommand>[0]) {
    setBusy(true);
    setError(undefined);
    const result = await postCommand(command);
    setBusy(false);
    if (result.ok) {
      setMachine(undefined);
    } else {
      setError(result.message);
    }
  }

  function saveMachine(event: FormEvent) {
    event.preventDefault();
    if (valid && name !== availability?.machine) {
      void run({ type: "set-box-machine", machine: name });
    }
  }

  const { settingUp, available } = availability;
  const list = steps(availability);
  const active = settingUp ? list.findIndex(({ done }) => !done) : -1;
  const doneCount = list.filter(({ done }) => done).length;
  return (
    <section aria-label="Boxes" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-body-s font-medium">Boxes</h3>
        <p className="text-caption text-ink-secondary">
          A bot that runs in a box works in its own container, away from your files, and can run on
          its own: on a schedule or while you're away. Boxes run in a Podman machine.
        </p>
      </div>
      <form className="flex flex-col gap-2" onSubmit={saveMachine}>
        <label htmlFor="box-machine" className="field-label">
          Podman machine
        </label>
        <div className="flex items-center gap-2">
          <input
            id="box-machine"
            className="field min-w-0 flex-1 text-ink"
            spellCheck={false}
            maxLength={64}
            aria-invalid={valid ? undefined : true}
            value={name}
            onChange={(event) => setMachine(event.target.value)}
          />
          {name !== availability.machine && (
            <button
              type="submit"
              className="button button-outline"
              disabled={busy || settingUp || !valid}
            >
              Save
            </button>
          )}
        </div>
      </form>
      {!hasKey && (
        <div className="flex items-start gap-2 rounded-card border border-edge-subtle bg-sidebar px-3 py-3 text-body-s">
          <Info {...iconProps} className="mt-0.5 shrink-0 text-ink-secondary" />
          <p>
            <span className="font-medium">Boxed bots need an API key.</span> Add an Anthropic or
            OpenAI key above.
          </p>
        </div>
      )}
      <div className="flex flex-col">
        <p role="status" className="text-caption text-ink-secondary empty:hidden">
          {statusLine(availability, doneCount)}
        </p>
        <ul className="flex flex-col">
          {list.map((step, index) => {
            const running = index === active;
            const waiting = active !== -1 && index > active;
            return (
              <li key={step.label} className="flex gap-3 border-b border-edge-subtle py-3">
                <span className="mt-0.5 shrink-0">
                  {step.done ? (
                    <CircleCheck {...iconProps} className="text-success-status" />
                  ) : running ? (
                    <LoaderCircle {...iconProps} className="animate-spin text-success-status" />
                  ) : (
                    <Circle {...iconProps} className="text-icon-muted" />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={`text-body-s ${waiting ? "text-ink-disabled" : ""}`}>
                    <span className="sr-only">{step.done ? "Done: " : "Not done: "}</span>
                    {step.label}
                  </span>
                  <span className="text-caption text-ink-secondary">
                    {waiting ? `Waits for: ${list[active]?.label}` : step.detail}
                  </span>
                  {running && availability.progress && (
                    <span className="mt-2">
                      <SetupProgress progress={availability.progress} />
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        {active === -1 && settingUp && availability.progress && (
          <span className="mt-3">
            <SetupProgress progress={availability.progress} />
          </span>
        )}
      </div>
      {!available && (
        <div>
          <button
            type="button"
            className="button button-primary"
            disabled={busy || settingUp}
            onClick={() => void run({ type: "set-up-boxes" })}
          >
            Set up boxes
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
