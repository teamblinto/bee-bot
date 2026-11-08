import { type BoxAvailability, BoxMachineName } from "@beebot/contracts";
import { type FormEvent, useState, useSyncExternalStore } from "react";

import { getConnectionState, postCommand, subscribeToConnection } from "../serverConnection";

function Check({ label, done }: { label: string; done: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-small">
      <span>{label}</span>
      <span className="text-label text-ink-faint">{done ? "Yes" : "No"}</span>
    </div>
  );
}

function statusLine(availability: BoxAvailability) {
  if (availability.settingUp) {
    return "Setting up. Building the box image the first time takes several minutes.";
  }
  return availability.available ? "Boxes are ready." : availability.problem;
}

export function BoxesPanel() {
  const availability = useSyncExternalStore(
    subscribeToConnection,
    () => getConnectionState().boxAvailability,
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

  const { machineFound, settingUp, available } = availability;
  return (
    <section aria-label="Boxes" className="flex flex-col gap-4 border-t border-edge pt-6">
      <div className="flex flex-col gap-1">
        <h3 className="text-name font-medium">Boxes</h3>
        <p className="text-small text-ink-secondary">
          A bot that runs in a box works in its own container, away from your files, and can run on
          its own: on a schedule or while you're away. Boxes run in a Podman machine.
        </p>
      </div>
      <form className="flex flex-col gap-1" onSubmit={saveMachine}>
        <label htmlFor="box-machine" className="text-label text-ink-secondary">
          Podman machine
        </label>
        <div className="flex items-center gap-1">
          <input
            id="box-machine"
            className="field min-w-0 flex-1 text-ink"
            spellCheck={false}
            maxLength={64}
            value={name}
            onChange={(event) => setMachine(event.target.value)}
          />
          <button
            type="submit"
            className="button button-outline"
            disabled={busy || settingUp || !valid || name === availability.machine}
          >
            Save
          </button>
        </div>
      </form>
      <div className="flex flex-col gap-1">
        <Check label="Machine found" done={machineFound} />
        <Check label="Box daemon installed" done={availability.boxdInstalled} />
        <Check label="Box image built" done={availability.imageBuilt} />
      </div>
      <p role="status" className="text-small text-ink-secondary">
        {statusLine(availability)}
      </p>
      {!available && (
        <div>
          <button
            type="button"
            className="button button-primary"
            disabled={busy || settingUp || !machineFound}
            onClick={() => void run({ type: "set-up-boxes" })}
          >
            Set up boxes
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-small text-ink-secondary">
          {error}
        </p>
      )}
    </section>
  );
}
