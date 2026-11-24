import { expect, it } from "vite-plus/test";

import { presetCron, presetOf, cronLine } from "./routineSchedule";

it("turns each preset into a single-hour cron and back", () => {
  const presets = [
    { repeat: "daily", day: 1, time: "09:05" },
    { repeat: "weekdays", day: 1, time: "23:30" },
    { repeat: "weekly", day: 0, time: "00:00" },
  ] as const;
  expect(presets.map(presetCron)).toEqual(["5 9 * * *", "30 23 * * 1-5", "0 0 * * 0"]);
  expect(presets.map(presetCron).map(presetOf)).toEqual(presets);
});

it("describes presets, and shows anything else as it is", () => {
  expect(cronLine("30 9 * * 1-5")).toBe("Weekdays at 09:30");
  expect(cronLine("0 18 * * 5")).toBe("Fridays at 18:00");
  expect(cronLine("*/30 * * * *")).toBe("*/30 * * * *");
});
