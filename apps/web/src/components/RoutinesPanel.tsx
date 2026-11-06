import type { Bot, Command, Routine, RoutineFiring } from "@beebot/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { firingLine, nextDueLine, routinesNotice } from "../labels";
import {
  dayNames,
  defaultPreset,
  presetCron,
  presetOf,
  type Repeat,
  repeats,
  scheduleLine,
} from "../routineSchedule";
import { postCommand } from "../serverConnection";

const labelClass = "flex flex-col gap-1 text-label text-ink-secondary";
const metaClass = "text-label text-ink-faint";
const repeatLabels: Record<Repeat, string> = {
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "One day a week",
};
const lateHours = [1, 2, 4, 8, 12];

export function RoutinesPanel({
  bot,
  routines,
  firings,
  connected,
  onClose,
}: {
  bot: Bot;
  routines: Routine[];
  firings: RoutineFiring[];
  connected: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [preset, setPreset] = useState(defaultPreset);
  const [skipIfLaterMins, setSkipIfLaterMins] = useState<number | null>(null);
  const [editing, setEditing] = useState<Routine>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!dialog.current?.open) {
      dialog.current?.showModal();
    }
  }, []);

  const disabled = busy || !connected;

  function clearForm() {
    setName("");
    setPrompt("");
    setPreset(defaultPreset);
    setSkipIfLaterMins(null);
    setEditing(undefined);
    setError(undefined);
  }

  // State updates arrive by event, so a success only has to tidy up here.
  async function send(command: Command, onDone: () => void) {
    if (sending.current) {
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(undefined);
    const result = await postCommand(command);
    sending.current = false;
    setBusy(false);
    if (result.ok) {
      onDone();
    } else {
      setError(result.message);
    }
  }

  function edit(routine: Routine) {
    setName(routine.name);
    setPrompt(routine.prompt);
    setPreset(presetOf(routine.cron) ?? defaultPreset);
    setSkipIfLaterMins(routine.skipIfLaterMins);
    setEditing(routine);
    setError(undefined);
    field.current?.focus();
  }

  function setEnabled(routine: Routine, enabled: boolean) {
    const { id: routineId, name, prompt, cron, timezone, skipIfLaterMins } = routine;
    const fields = { name, prompt, cron, timezone, enabled, skipIfLaterMins };
    void send({ type: "update-routine", routineId, ...fields }, () => {});
  }

  const remove = (routineId: string) =>
    void send({ type: "delete-routine", routineId }, () => {
      if (routineId === editing?.id) {
        clearForm();
      }
      list.current?.focus();
    });

  function submit(event: FormEvent) {
    event.preventDefault();
    const fields = { name, prompt, cron: presetCron(preset), skipIfLaterMins };
    const command: Command = editing
      ? {
          type: "update-routine",
          routineId: editing.id,
          timezone: editing.timezone,
          enabled: editing.enabled,
          ...fields,
        }
      : {
          type: "create-routine",
          botId: bot.id,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          enabled: true,
          ...fields,
        };
    void send(command, clearForm);
  }

  return (
    <dialog
      ref={dialog}
      aria-label={`${bot.name} routines`}
      className="dialog m-auto max-h-[80dvh] w-[min(560px,calc(100vw-32px))] flex-col gap-3 p-5 backdrop:bg-scrim open:flex"
      onClose={onClose}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title font-semibold">Routines</h2>
        <button type="button" className="button" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      <p className="text-small text-ink-secondary">{routinesNotice}</p>
      <div
        ref={list}
        tabIndex={-1}
        className="scroller flex min-h-0 flex-col gap-3 overflow-y-auto outline-none"
      >
        {routines.length === 0 && <p className="text-small text-ink-secondary">No routines yet.</p>}
        {routines.map((routine) => {
          const firing = firings.find(({ routineId }) => routineId === routine.id);
          return (
            <article key={routine.id} aria-label={routine.name} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-small font-medium wrap-anywhere">{routine.name}</p>
                <p className={metaClass}>{scheduleLine(routine.cron)}</p>
                <p className={metaClass}>{nextDueLine(routine)}</p>
                {firing && <p className={metaClass}>{firingLine(firing)}</p>}
              </div>
              <button
                type="button"
                className="button shrink-0"
                disabled={disabled}
                onClick={() => setEnabled(routine, !routine.enabled)}
              >
                {routine.enabled ? "Turn off" : "Turn on"}
              </button>
              <button
                type="button"
                className="button shrink-0"
                disabled={disabled}
                onClick={() => edit(routine)}
              >
                Edit
              </button>
              <button
                type="button"
                className="button shrink-0"
                disabled={disabled}
                onClick={() => remove(routine.id)}
              >
                Delete
              </button>
            </article>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-small text-ink-secondary">
          {error}
        </p>
      )}
      <form className="flex shrink-0 flex-col gap-2" onSubmit={submit}>
        <label className={labelClass}>
          {editing ? "Edit this routine" : "Add a routine"}
          <input
            ref={field}
            className="field text-ink"
            maxLength={80}
            placeholder="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className={labelClass}>
          Prompt
          <textarea
            className="field resize-none text-ink"
            maxLength={32_000}
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <label className={labelClass}>
            Repeats
            <select
              className="field text-ink"
              value={preset.repeat}
              onChange={(event) =>
                setPreset({
                  ...preset,
                  repeat: repeats.find((repeat) => repeat === event.target.value) ?? "daily",
                })
              }
            >
              {repeats.map((repeat) => (
                <option key={repeat} value={repeat}>
                  {repeatLabels[repeat]}
                </option>
              ))}
            </select>
          </label>
          {preset.repeat === "weekly" && (
            <label className={labelClass}>
              Day
              <select
                className="field text-ink"
                value={preset.day}
                onChange={(event) => setPreset({ ...preset, day: Number(event.target.value) })}
              >
                {dayNames.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className={labelClass}>
            Time
            <input
              type="time"
              className="field text-ink"
              value={preset.time}
              onChange={(event) => setPreset({ ...preset, time: event.target.value })}
            />
          </label>
          <label className={labelClass}>
            Skip if late
            <select
              className="field text-ink"
              value={skipIfLaterMins ?? ""}
              onChange={({ target: { value } }) => setSkipIfLaterMins(value ? Number(value) : null)}
            >
              <option value="">Never</option>
              {lateHours.map((hours) => (
                <option key={hours} value={hours * 60}>
                  More than {hours} {hours === 1 ? "hour" : "hours"} late
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex justify-end gap-2">
          {editing && (
            <button type="button" className="button" onClick={clearForm}>
              Cancel
            </button>
          )}
          <button
            type="submit"
            className="button button-primary"
            disabled={disabled || !name.trim() || !prompt.trim() || !preset.time}
          >
            {editing ? "Save" : "Add"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
