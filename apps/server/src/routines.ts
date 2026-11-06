import { Cron } from "croner";

const minGapMs = 15 * 60_000;
// A cron pattern repeats, so a close pair shows up within this many runs.
const gapSamples = 48;
// Each step costs about 0.3 ms, and this runs on the server's only thread.
const maxWalk = 1000;
export const catchUpWindowMs = 24 * 60 * 60_000;

type Schedule = { cron: string; timezone: string };

// No callback, so this only computes times: croner starts no timer.
const times = ({ cron, timezone }: Schedule) => new Cron(cron, { timezone });

export function scheduleProblem(schedule: Schedule, now: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone }).format();
  } catch {
    return "invalid_timezone";
  }
  let runs: Date[];
  try {
    runs = times(schedule).nextRuns(gapSamples, new Date(now));
  } catch {
    return "invalid_cron";
  }
  if (runs.length === 0) {
    return "invalid_cron";
  }
  const tooClose = runs.some((run, index) => {
    const previous = runs[index - 1];
    return previous && run.getTime() - previous.getTime() < minGapMs;
  });
  return tooClose ? "schedule_too_frequent" : null;
}

// Null when the schedule no longer parses or has no time left.
export function nextSlot(schedule: Schedule, after: string) {
  try {
    return times(schedule).nextRun(new Date(after))?.toISOString() ?? null;
  } catch {
    return null;
  }
}

// `passedOver` stops counting at the bound, but the slot stays exact: past the bound the walk jumps
// close to `now`. `previousRuns` can land a slot short, so the walk still finishes the last steps.
export function dueSlot(schedule: Schedule, nextFireAt: string, now: string) {
  const job = times(schedule);
  let slot = nextFireAt;
  let passedOver = 0;
  for (let step = 1; ; step += 1) {
    if (step === maxWalk + 1) {
      slot = job.previousRuns(1, new Date(now))[0]?.toISOString() ?? slot;
    }
    const after = job.nextRun(new Date(slot))?.toISOString();
    if (!after || after > now) {
      return { slot, passedOver };
    }
    slot = after;
    passedOver = Math.min(passedOver + 1, maxWalk);
  }
}
