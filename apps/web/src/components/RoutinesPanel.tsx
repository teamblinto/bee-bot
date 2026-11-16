import type { Bot, Command, Routine, RoutineFiring } from "@beebot/contracts";
import { CalendarClock, CircleX, Plus } from "lucide-react";
import { type FormEvent, type ReactNode, useRef, useState } from "react";

import {
  firingLine,
  heartbeatLine,
  nextDueLine,
  retryLine,
  routinePauseLines,
  routinesNotice,
} from "../labels";
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
import { EmptyState, errorClass, fieldLabelClass, RowMenu, SidePanel } from "./SidePanel";
import { iconProps } from "./ui";

const metaClass = "text-caption text-ink-secondary";
const repeatLabels: Record<Repeat, string> = {
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "One day a week",
};
const lateHours = [1, 2, 4, 8, 12];

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} className="flex items-center gap-1 text-caption font-normal text-danger">
      <CircleX {...iconProps} size={12} />
      {children}
    </span>
  );
}

function Switch({
  label,
  on,
  disabled,
  onChange,
}: {
  label: string;
  on: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? "bg-brand-fill" : "bg-ink-secondary"}`}
      onClick={() => onChange(!on)}
    >
      <span
        className={`absolute top-0.5 size-3.5 rounded-full bg-card transition-[left] ${on ? "left-4" : "left-0.5"}`}
      />
    </button>
  );
}

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
  const list = useRef<HTMLDivElement>(null);
  const sending = useRef(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [preset, setPreset] = useState(defaultPreset);
  const [skipIfLaterMins, setSkipIfLaterMins] = useState<number | null>(null);
  const [editing, setEditing] = useState<Routine | "new">();
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const disabled = busy || !connected;
  const nameMissing = tried && !name.trim();
  const promptMissing = tried && !prompt.trim();

  function clearForm() {
    setName("");
    setPrompt("");
    setPreset(defaultPreset);
    setSkipIfLaterMins(null);
    setEditing(undefined);
    setTried(false);
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
    setTried(false);
    setError(undefined);
  }

  function setEnabled(routine: Routine, enabled: boolean) {
    const { id: routineId, name, prompt, cron, timezone, skipIfLaterMins } = routine;
    const fields = { name, prompt, cron, timezone, enabled, skipIfLaterMins };
    void send({ type: "update-routine", routineId, ...fields }, () => {});
  }

  const remove = (routineId: string) =>
    void send({ type: "delete-routine", routineId }, () => list.current?.focus());

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !prompt.trim() || !preset.time) {
      setTried(true);
      return;
    }
    const fields = { name, prompt, cron: presetCron(preset), skipIfLaterMins };
    const command: Command =
      editing && editing !== "new"
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

  const alert = error && (
    <p role="alert" className={errorClass}>
      {error}
    </p>
  );

  if (editing) {
    const isNew = editing === "new";
    return (
      <SidePanel
        label={`${bot.name} routines`}
        botName={bot.name}
        title={isNew ? "New routine" : "Edit routine"}
        onClose={onClose}
        footer={
          <>
            <button type="button" className="button" onClick={clearForm}>
              Cancel
            </button>
            <button
              type="submit"
              form="routine-form"
              className="button button-primary"
              disabled={disabled}
            >
              {isNew ? "Save and turn on" : "Save"}
            </button>
          </>
        }
      >
        <form id="routine-form" className="flex flex-col gap-4" noValidate onSubmit={submit}>
          <label className={fieldLabelClass}>
            Name
            <input
              autoFocus
              className="field font-normal"
              maxLength={80}
              placeholder="For example, Morning PR review"
              aria-invalid={nameMissing}
              aria-describedby={nameMissing ? "routine-name-error" : undefined}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {nameMissing && (
              <FieldError id="routine-name-error">Give the routine a name.</FieldError>
            )}
          </label>
          <label className={fieldLabelClass}>
            What {bot.name} does
            <textarea
              className="field resize-none font-normal"
              maxLength={32_000}
              rows={4}
              aria-invalid={promptMissing}
              aria-describedby={promptMissing ? "routine-prompt-error" : undefined}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            {promptMissing && (
              <FieldError id="routine-prompt-error">Tell {bot.name} what to do.</FieldError>
            )}
          </label>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-3">
              <label className={`${fieldLabelClass} min-w-40 flex-1`}>
                Repeats
                <select
                  className="field font-normal"
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
                <label className={`${fieldLabelClass} w-36`}>
                  Day
                  <select
                    className="field font-normal"
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
              <label className={`${fieldLabelClass} w-30`}>
                Time
                <input
                  type="time"
                  className="field font-normal"
                  aria-invalid={tried && !preset.time}
                  value={preset.time}
                  onChange={(event) => setPreset({ ...preset, time: event.target.value })}
                />
              </label>
            </div>
            {preset.time && <p className={metaClass}>{scheduleLine(presetCron(preset))}</p>}
          </div>
          <label className={fieldLabelClass}>
            Skip if late
            <select
              className="field font-normal"
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
            <span className="field-help font-normal">
              If {bot.name}'s computer was asleep when it was due, skip that run instead of running
              late.
            </span>
          </label>
          {alert}
        </form>
      </SidePanel>
    );
  }

  return (
    <SidePanel label={`${bot.name} routines`} botName={bot.name} title="Routines" onClose={onClose}>
      <div ref={list} tabIndex={-1} className="flex flex-col gap-4 outline-none">
        <p className="text-body-s text-ink-secondary">{routinesNotice}</p>
        <button
          type="button"
          className="button button-sm button-outline self-start"
          disabled={disabled}
          onClick={() => setEditing("new")}
        >
          <Plus {...iconProps} />
          New routine
        </button>
        {routines.length === 0 && (
          <EmptyState icon={CalendarClock} title="No routines yet">
            <p className="text-body-s text-ink-secondary">
              A routine asks {bot.name} to do the same thing on a schedule.
            </p>
          </EmptyState>
        )}
        {routines.map((routine) => {
          const firing = firings.find(({ routineId }) => routineId === routine.id);
          return (
            <article
              key={routine.id}
              aria-label={routine.name}
              className="surface flex flex-col gap-2 p-4"
            >
              <div className="flex items-center gap-2">
                <h3
                  className={`min-w-0 flex-1 text-body-s font-medium wrap-anywhere ${routine.enabled ? "" : "text-ink-secondary"}`}
                >
                  {routine.name}
                </h3>
                <Switch
                  label={`${routine.name} on`}
                  on={routine.enabled}
                  disabled={disabled}
                  onChange={(on) => setEnabled(routine, on)}
                />
              </div>
              <p className={`text-body-s ${routine.enabled ? "" : "text-ink-secondary"}`}>
                {scheduleLine(routine.cron)}
              </p>
              <div className="flex flex-col gap-1">
                <p className={metaClass}>{nextDueLine(routine)}</p>
                {routine.pausedReason && (
                  <p className="text-caption text-waiting">
                    {routinePauseLines[routine.pausedReason]}
                  </p>
                )}
                <p className={metaClass}>{heartbeatLine(routine)}</p>
                {firing && <p className={metaClass}>{firingLine(firing)}</p>}
                {firing?.retryAt && <p className={metaClass}>{retryLine(firing.retryAt)}</p>}
              </div>
              <div className="flex justify-end">
                <RowMenu
                  label={`${routine.name} actions`}
                  items={[
                    { label: "Edit", disabled, onSelect: () => edit(routine) },
                    {
                      label: "Delete",
                      danger: true,
                      disabled,
                      onSelect: () => remove(routine.id),
                    },
                  ]}
                />
              </div>
            </article>
          );
        })}
        {alert}
      </div>
    </SidePanel>
  );
}
