import type { Routine } from "@beebot/contracts";

import { dayAndTime } from "./labels";

export const repeats = ["daily", "weekdays", "weekly"] as const;
export type Repeat = (typeof repeats)[number];
export type SchedulePreset = { repeat: Repeat; day: number; time: string };

export const dayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const defaultPreset: SchedulePreset = { repeat: "daily", day: 1, time: "09:00" };

const days = { daily: "*", weekdays: "1-5" };

// One hour value only: croner has an open DST issue with hour lists.
export function presetCron({ repeat, day, time }: SchedulePreset) {
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  return `${minute} ${hour} * * ${repeat === "weekly" ? day : days[repeat]}`;
}

export function presetOf(cron: string): SchedulePreset | undefined {
  const [, minute, hour, field] = /^(\d+) (\d+) \* \* (\*|1-5|[0-6])$/.exec(cron) ?? [];
  if (!minute || !hour || !field) {
    return undefined;
  }
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (field === "*") {
    return { ...defaultPreset, repeat: "daily", time };
  }
  return field === "1-5"
    ? { ...defaultPreset, repeat: "weekdays", time }
    : { repeat: "weekly", day: Number(field), time };
}

export function cronLine(cron: string) {
  const preset = presetOf(cron);
  if (!preset) {
    return cron;
  }
  const { repeat, day, time } = preset;
  const when = { daily: "Every day", weekdays: "Weekdays", weekly: `${dayNames[day]}s` };
  return `${when[repeat]} at ${time}`;
}

export const scheduleLine = ({ cron, fireAt }: Pick<Routine, "cron" | "fireAt">) =>
  fireAt !== null ? `Once at ${dayAndTime(fireAt)}` : cronLine(cron ?? "");
